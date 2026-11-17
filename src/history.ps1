# チャット履歴の保存 (UI からの依頼を start.ps1 の受付が受けて呼ぶ)
#   history\chats\<id>.json   会話 1 件 = 1 ファイル (UI が組み立てた 1 行の JSON をそのまま書く)
#   history\images\<sha256>.<拡張子>  画像の本体。会話の JSON には "simpllm-img:<名前>" だけを書く (同じ画像は 1 つだけ)
#   history\meta.json         設定・システムプロンプト集
#   history\projects.json     プロジェクト (指示と、常に参照するファイルの全文)
# 暗号化はしない (軽さ優先)。中身は UI 側で検証してから使う。

if (-not $function:L) { . (Join-Path $PSScriptRoot 'lang.ps1') } # 文言 (L 'キー')。start.ps1 から読み込んだときは読み込み済み
$historyDir = Join-Path (Split-Path $PSScriptRoot -Parent) "history"
$historyChats = Join-Path $historyDir "chats"
$historyImages = Join-Path $historyDir "images"
$historyMeta = Join-Path $historyDir "meta.json"
$historyUtf8 = [System.Text.UTF8Encoding]::new($false, $true) # 不正な UTF-8 は例外にする
$HistoryLimits = @{ chat = 64MB; meta = 8MB; image = 25MB }
$historyProblem = "" # 空でなければ、フォルダを用意できなかった理由 (保存なしで起動を続ける)
$historyNullLine = [byte[]](0x6E, 0x75, 0x6C, 0x6C) # null (設定のファイルが無いとき)
. (Join-Path $PSScriptRoot 'history-index.ps1')

function Test-HistoryChatId([string]$id) { return $id -cmatch '^[A-Za-z0-9-]{1,64}$' }
function Test-HistoryImageName([string]$name) { return $name -cmatch '^[0-9a-f]{64}\.(png|jpg|webp|gif)$' }

# 起動時: フォルダを用意し、書きかけの一時ファイルを消す。会話はここでは読まない (一覧を返すときに一度だけ読む)。
# 用意できなくても起動は止めない。理由を残し、UI には「保存されません」と表示させる
function Initialize-History {
    try {
        foreach ($dir in @($historyDir, $historyChats, $historyImages)) {
            New-Item -ItemType Directory -Force $dir -ErrorAction SilentlyContinue | Out-Null
            # 同じ名前のファイルがあっても New-Item -Force はエラーにならない (実測) ので、フォルダかどうかを確かめる
            if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw (L 'history.cannotCreate' @{ dir = $dir }) }
            Get-ChildItem -LiteralPath $dir -File -Filter "*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        }
        # 書けるかを確かめる (読み取り専用などなら、保存なしで起動を続ける)
        $probe = Join-Path $historyChats "write-check.tmp"
        [IO.File]::WriteAllBytes($probe, [byte[]]@())
        Remove-Item -LiteralPath $probe -Force
        $script:historyProblem = ""
    } catch {
        $script:historyProblem = $_.Exception.Message
    }
}

function Assert-HistoryReady {
    if ($script:historyProblem) { throw (L 'history.unavailable' @{ reason = $script:historyProblem }) }
}

# 一時ファイルに書いてから置き換える (途中で落ちても前の内容が残る)。
# 置き換える前にディスクまで書き切る (停電などで、置き換え後のファイルが空や 0 埋めにならないように)
function Write-HistoryFile([string]$path, [byte[]]$bytes) {
    $tmp = "$path.tmp"
    $stream = New-Object IO.FileStream($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    # ウイルス対策・検索インデックス・同期ソフトが一瞬だけファイルを開いていることがあるので、少し待って再試行する
    for ($attempt = 1; ; $attempt++) {
        try {
            if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) }
            else { [IO.File]::Move($tmp, $path) }
            return
        } catch {
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds (50 * $attempt)
        }
    }
}

function Read-HistoryBody($request, [long]$limit) {
    $length = $request.ContentLength64
    if ($length -le 0 -or $length -gt $limit) { throw (L 'history.badBodySize' @{ mb = [math]::Round($limit / 1MB) }) }
    $bytes = New-Object byte[] $length
    $offset = 0
    while ($offset -lt $length) {
        $n = $request.InputStream.Read($bytes, $offset, $length - $offset)
        if ($n -le 0) { throw (L 'history.receiveFailed') }
        $offset += $n
    }
    return ,$bytes
}

# UI が送る 1 行の JSON か (改行を含まない、{ で始まる、正しい UTF-8)。行区切りで一覧を返すため
function Test-HistoryLine([byte[]]$bytes) {
    if ($bytes[0] -ne 0x7B) { throw (L 'history.badChat') }
    if ([Array]::IndexOf($bytes, [byte]10) -ge 0 -or [Array]::IndexOf($bytes, [byte]13) -ge 0) { throw (L 'history.badChat') }
    [void]$historyUtf8.GetCharCount($bytes) # 不正な UTF-8 なら例外。確かめるだけなので、会話全体の文字列は作らない
}

# 手で整形したファイルも 1 行にする。正しい JSON では、文字列の中に生の改行は入らないので意味は変わらない。
# UI が書いたファイルは初めから 1 行なので、改行が無ければ全文の置き換えをしない
$historyNewlines = [char[]]@(13, 10)
function ConvertTo-HistoryLine([string]$text) {
    if ($text.IndexOfAny($historyNewlines) -lt 0) { return $text.Trim() }
    return ($text -replace "[\r\n]+", " ").Trim()
}

# 使われていない画像を消し、消した名前を返す。読めない会話が 1 つでもあれば、念のため何も消さない
function Remove-UnusedHistoryImages($used) {
    $removed = New-Object System.Collections.Generic.List[string]
    if ($null -eq $used) { return }
    foreach ($image in Get-ChildItem -LiteralPath $historyImages -File -ErrorAction SilentlyContinue) {
        if ($used.Contains($image.Name)) { continue }
        try { Remove-Item -LiteralPath $image.FullName -Force -ErrorAction Stop; $removed.Add($image.Name) } catch { }
    }
    return $removed.ToArray() # 呼び出し側は @(...) で受ける
}

# 保存してあるファイルを、一覧に載せる 1 行のバイト列にする: 先頭の BOM と前後の空白を除き、不正な UTF-8 は例外。
# UI が書いたファイルは初めから 1 行なので、そのまま (写しも作らずに) 使う。手で整形した (改行を含む) ファイルだけ、文字列にして 1 行に直す
function ConvertTo-HistoryLineBytes([byte[]]$bytes) {
    $start = 0
    $end = $bytes.Length
    if ($end -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $start = 3 }
    while ($start -lt $end -and ($bytes[$start] -eq 32 -or $bytes[$start] -eq 9 -or $bytes[$start] -eq 10 -or $bytes[$start] -eq 13)) { $start++ }
    while ($end -gt $start -and ($bytes[$end - 1] -eq 32 -or $bytes[$end - 1] -eq 9 -or $bytes[$end - 1] -eq 10 -or $bytes[$end - 1] -eq 13)) { $end-- }
    $count = $end - $start
    [void]$historyUtf8.GetCharCount($bytes, $start, $count) # 不正な UTF-8 なら例外。確かめるだけで、文字列は作らない
    if ([Array]::IndexOf($bytes, [byte]10, $start, $count) -ge 0 -or [Array]::IndexOf($bytes, [byte]13, $start, $count) -ge 0) {
        return , $historyUtf8.GetBytes((ConvertTo-HistoryLine ($historyUtf8.GetString($bytes, $start, $count))))
    }
    if ($start -eq 0 -and $end -eq $bytes.Length) { return , $bytes }
    $line = [byte[]]::new($count)
    [Array]::Copy($bytes, $start, $line, 0, $count)
    return , $line
}

function Get-HistoryProjectsPath { return (Join-Path $historyDir "projects.json") }

# 一覧の行を改行でつなぐ (一覧そのものは history-index.ps1 の Get-HistoryIndexBytes が作る)
function Join-HistoryLines($lines) {
    $total = [Math]::Max(0, $lines.Count - 1)
    foreach ($line in $lines) { $total += $line.Length }
    $out = New-Object IO.MemoryStream($total) # 大きさは分かっているので、途中で広げ直させない
    $first = $true
    foreach ($line in $lines) {
        if (-not $first) { $out.WriteByte(10) }
        $first = $false
        $out.Write($line, 0, $line.Length)
    }
    if ($out.Length -eq $out.Capacity) { return , $out.GetBuffer() } # ちょうどの大きさで確保してあるので、写しを作らずに中身を返す
    return , $out.ToArray()
}

# 会話を消したあとに UI が呼ぶ (全削除で画像が残らないように)
function Invoke-HistoryPrune {
    Assert-HistoryReady
    return Remove-UnusedHistoryImages (Get-IndexedHistoryImages)
}

function Save-HistoryChat([string]$id, [byte[]]$bytes) {
    Assert-HistoryReady
    if (-not (Test-HistoryChatId $id)) { throw (L 'history.badId') }
    Test-HistoryLine $bytes
    Write-HistoryFile (Join-Path $historyChats "$id.json") $bytes
    # The full save supersedes older attributes; remove them only after the atomic write.
    # The cached summary is dropped too: it is matched by size and time, and a file system with
    # coarse timestamps (exFAT: 2 s) could otherwise pair a new body with old image references.
    foreach ($sub in 'attributes', 'index') {
        $sidecar = Join-Path $historyDir "$sub\$id.json"
        if ([IO.File]::Exists($sidecar)) { [IO.File]::Delete($sidecar) }
    }
    (Get-HistoryIndex).Forget($id)
}

function Remove-HistoryChat([string]$id) {
    Assert-HistoryReady
    if (-not (Test-HistoryChatId $id)) { throw (L 'history.badId') }
    # 消せなければ例外にする (.NET の呼び出しなので、$ErrorActionPreference によらない)。
    # 失敗を成功として返すと、UI は消えたものとして扱い、次回の起動で会話が戻ってくる
    $path = Join-Path $historyChats "$id.json"
    if ([IO.File]::Exists($path)) {
        [IO.File]::SetAttributes($path, [IO.FileAttributes]::Normal) # 読み取り専用でも消す (Remove-Item -Force と同じ)
        [IO.File]::Delete($path)
    }
    foreach ($sub in 'attributes', 'index') {
        $sidecar = Join-Path $historyDir "$sub\$id.json"
        if ([IO.File]::Exists($sidecar)) { [IO.File]::Delete($sidecar) }
    }
    (Get-HistoryIndex).Forget($id)
}

function Save-HistoryMeta([byte[]]$bytes) {
    Assert-HistoryReady
    Test-HistoryLine $bytes
    Write-HistoryFile $historyMeta $bytes
}

# プロジェクト (指示と、常に参照するファイルの全文) は設定とは別のファイルにする: 設定は切り替えのたびに保存するので、
# 同じファイルだと、そのたびにプロジェクトの全文を書き直すことになる
function Save-HistoryProjects([byte[]]$bytes) {
    Assert-HistoryReady
    Test-HistoryLine $bytes
    Write-HistoryFile (Get-HistoryProjectsPath) $bytes
}

# 画像の本体を保存し、名前 (SHA-256 + 拡張子) を返す。形式は先頭のバイトで確かめる
function Save-HistoryImage([byte[]]$bytes) {
    Assert-HistoryReady
    $ext = $null
    if ($bytes.Length -gt 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { $ext = "png" }
    elseif ($bytes.Length -gt 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF) { $ext = "jpg" }
    elseif ($bytes.Length -gt 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ceq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ceq "WEBP") { $ext = "webp" }
    elseif ($bytes.Length -gt 6 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ceq "GIF8") { $ext = "gif" }
    if (-not $ext) { throw (L 'history.badImageType') }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose() }
    $name = "$hash.$ext"
    $path = Join-Path $historyImages $name
    # 同じ名前でも大きさが違えば壊れているので書き直す
    $existing = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($null -eq $existing -or $existing.Length -ne $bytes.Length) { Write-HistoryFile $path $bytes }
    return $name
}

# 履歴の依頼を処理したら $true。Host・Origin・API キーは呼び出し側で確認済み (応答の送信は start.ps1)
function Invoke-HistoryRoute($context, [string]$route) {
    $request = $context.Request
    $id = [string]$request.QueryString["id"]
    switch ($route) {
        "GET /history" { Send-ControlBytes $context (Get-HistoryIndexBytes) "text/plain; charset=utf-8"; return $true }
        "GET /history/chat" {
            if (-not (Test-HistoryChatId $id)) { throw (L 'history.badId') }
            Assert-HistoryReady
            # 無い会話は 404 (読み書きの失敗の 503 にすると、UI が「一時的な失敗」として扱う)
            if (-not [IO.File]::Exists((Join-Path $historyChats "$id.json"))) { Send-ControlResponse $context 404 @{ error = (L 'common.notFound') }; return $true }
            Send-ControlBytes $context ((Get-HistoryIndex).Full($id)) "application/json; charset=utf-8"; return $true
        }
        "GET /history/search" {
            Assert-HistoryReady
            $q = [string]$request.QueryString['q']
            if ($q.Length -gt 1000) { throw (L 'history.badChat') }
            $ids = [Collections.Generic.List[string]]::new()
            $index = Get-HistoryIndex
            if ($q.Trim()) {
                foreach ($path in [IO.Directory]::EnumerateFiles($historyChats, '*.json')) {
                    if ($null -ne $script:historyShared -and $script:historyShared.stopping) { break } # 終了の待ちを、検索で長引かせない
                    $chatId = [IO.Path]::GetFileNameWithoutExtension($path)
                    if (-not (Test-HistoryChatId $chatId)) { continue }
                    try { if ($index.Matches($chatId, $q, ($request.QueryString['words'] -eq '1'))) { $ids.Add($chatId) } } catch { }
                }
            }
            Send-ControlResponse $context 200 @{ ids = @($ids) }; return $true
        }
        "POST /history/attributes" { Save-HistoryAttributes $id (Read-HistoryBody $request 4096); Send-ControlResponse $context 200 @{ ok = $true }; return $true }
        "POST /history/chat" { Save-HistoryChat $id (Read-HistoryBody $request $HistoryLimits.chat); Send-ControlResponse $context 200 @{ ok = $true }; return $true }
        "POST /history/chat/delete" { Remove-HistoryChat $id; Send-ControlResponse $context 200 @{ ok = $true }; return $true }
        "POST /history/meta" { Save-HistoryMeta (Read-HistoryBody $request $HistoryLimits.meta); Send-ControlResponse $context 200 @{ ok = $true }; return $true }
        "POST /history/projects" { Save-HistoryProjects (Read-HistoryBody $request $HistoryLimits.meta); Send-ControlResponse $context 200 @{ ok = $true }; return $true }
        "POST /history/image" { $name = Save-HistoryImage (Read-HistoryBody $request $HistoryLimits.image); Send-ControlResponse $context 200 @{ name = $name }; return $true }
        "POST /history/prune" { Send-ControlResponse $context 200 @{ removed = @(Invoke-HistoryPrune) }; return $true }
        "GET /history/image" {
            Assert-HistoryReady
            $name = [string]$request.QueryString["name"]
            if (-not (Test-HistoryImageName $name)) { throw (L 'history.badImageName') }
            $path = Join-Path $historyImages $name
            if (-not (Test-Path -LiteralPath $path)) { Send-ControlResponse $context 404 @{ error = (L 'history.imageNotFound') }; return $true }
            $type = @{ png = "image/png"; jpg = "image/jpeg"; webp = "image/webp"; gif = "image/gif" }[$name.Split('.')[1]]
            Send-ControlBytes $context ([IO.File]::ReadAllBytes($path)) $type
            return $true
        }
    }
    return $false
}
