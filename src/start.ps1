# simpllm 起動スクリプト (Windows PowerShell 5.1 対応)
#   例: start.bat                 (ふだんの起動。引数はこのスクリプトにそのまま渡る)
#       start.bat -Model D:\models\xxx-Q4_K_M.gguf
#       start.bat -Vision          (画像入力を有効化。モデルと同じフォルダの mmproj-*.gguf を使う)
# 専用ウィンドウ (Chrome / Edge) で UI を開き、そのウィンドウを閉じるとサーバーも終了する。
# 対象: llama.cpp b11669 (v0.7.0) で動作確認済みのフラグを使用。
#       llama.cpp を更新したら .\bin\llama-server.exe --help でフラグが残っているか確認すること。

param(
    [string[]]$Model = @(),              # 空なら .\models と、設定で選んだモデルのフォルダの .gguf をすべて選択肢にする
    [string]$Browser = "",               # 専用ウィンドウに使うブラウザ (Chrome 系) の実行ファイル。空なら Chrome、Edge の順に探す
    [switch]$Vision,                     # 画像入力を有効にする (mmproj を読み込む分 VRAM を使う)
    [switch]$NoBrowser,                  # 専用ウィンドウを開かず、Ctrl+C まで動かし続ける
    [switch]$BuildOnly,                  # UI (public\index.html) の再生成だけ行って終了する。サーバー起動中に UI を直したとき用
    [switch]$Hidden,                     # コンソールなしで起動する (start.bat が付ける)。エラーはポップアップで知らせる
    [switch]$ShowServerLog,             # サーバーのログをコンソールに出す (起動しないときの調査用)。既定では破棄する。ファイルには書かない
    [string]$Mmproj = "",                # mmproj のパス。空ならモデルと同じフォルダから名前の合うものを探す
    [int]$Port = 8080,                   # 使用中なら、指定していないときに限り空いている番号を自動で選ぶ
    # --- 以下の起動設定は、既定ではどの PC でも破綻しにくい llama.cpp の標準に任せる ---
    # 設定画面の「起動設定」で変えた値は .run\launch.json に保存し、次回からも使う。ここで明示した値はそれより優先する
    [int]$Context = 0,                   # コンテキスト長。0 = モデルの値から、メモリに収まるよう llama.cpp (--fit) が決める (16384 以上)
    [int]$CpuMoe = -1,                   # MoEエキスパートをRAMに逃がす層数。-1 = llama.cpp の自動調整 (--fit) に任せる
    [int]$MoeCacheMiB = 0,               # RAMに逃がしたエキスパート用のGPUキャッシュ (MiB)。0 = 使わない
    [string]$TensorSplit = "",           # 空 = 自動。指定すると --fit の自動調整が無効になる。例 "7,11"
    [int]$UBatch = 0,                    # 入力処理のバッチサイズ。0 = llama.cpp の既定。大きいほど入力の処理が速いが VRAM を使う
    [int]$Parallel = 1,                  # 同時処理数。1人で使うなら 1 (作業用メモリが減り GPU に載る量が増える)。0 = llama.cpp の既定 (自動)
    [string]$CacheType = "",             # KVキャッシュの型。空 = 既定 (f16)
    [int]$FitMarginMiB = 0,              # --fit が各GPUに残す余白 (MiB)。0 = llama.cpp の既定 (1024)
    [string]$LoadMode = "auto",          # auto = llama.cpp の既定 (mmap)。none = モデルを RAM に読み込む (RAM がモデルより大きいときだけ)
    [string]$ReasoningFormat = "deepseek" # 思考を reasoning_content に分離する
)

$ErrorActionPreference = "Stop"
# このスクリプトは src\ にある。データ (bin・models・history・.run) は 1 つ上の、start.bat のあるフォルダに置く
$root = [IO.Path]::GetDirectoryName($PSScriptRoot)
$server = [IO.Path]::Combine($root, "bin\llama-server.exe")
$public = [IO.Path]::Combine($root, "public")
$profileDir = [IO.Path]::Combine($root, "browser-profile")

# 表示言語の候補: 設定画面で選んだもの (.run\language)、Windows の表示言語の順。画面には URL で渡し、こちらの文言 (エラーの知らせなど) は
# lang.ps1 が同じ決め方で言語にする (文言を用意していない言語なら英語)。
# lang.ps1 は最初に文言を使うときに読み込む: ふだんの起動では文言を 1 つも使わないので、読み込まない分だけ軽い (約 25ms。実測)
$languageFile = [IO.Path]::Combine($root, ".run\language")
$script:languageHint = @([Globalization.CultureInfo]::CurrentUICulture.Name)
if ([IO.File]::Exists($languageFile)) { try { $script:languageHint = @([IO.File]::ReadAllText($languageFile).Trim()) + $script:languageHint } catch { } }
# lang.ps1 は関数を script: に定義するので、関数の中から読み込んでも残り、下の 2 つを本物に置き換える
function Import-Lang { . ([IO.Path]::Combine($PSScriptRoot, "lang.ps1")) }
function L { Import-Lang; L @args }
function Set-Language { Import-Lang; Set-Language @args }
. ([IO.Path]::Combine($PSScriptRoot, "session.ps1"))

# コンソールがない起動でも読めるように知らせる
# サーバーを起動した後は、知らせを終了処理の後まで溜める (ダイアログを閉じるまでサーバーが VRAM を持ったまま待たないように)
$script:deferredProblems = $null
function Show-Problem([string]$message, [string]$detail = "") {
    if ($null -ne $script:deferredProblems) { $script:deferredProblems.Add(@($message, $detail)); return }
    if ($Hidden) { Show-MessageDialog $message $detail }
    else { Write-Host (($message, $detail | Where-Object { $_ }) -join "`n") -ForegroundColor Red }
}
function Fail([string]$message, [string]$detail = "") {
    Show-Problem $message $detail
    exit 1
}
trap { Fail (L 'start.error') $_.Exception.Message }

# 127.0.0.1 で待ち受けている (= 127.0.0.1 へ接続できる) ポートか。
# 接続を試して確かめると、待ち受けていないときに Windows が再送を待つので 1 回 2 秒かかる (実測)。待ち受けの一覧なら数ミリ秒
# 番号を複数渡すと、どれか 1 つでも待ち受けていれば $true (一覧の取得は 1 回で済ませる)
function Test-PortOpen([int[]]$numbers) {
    foreach ($listener in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        if ($numbers -contains $listener.Port -and ($listener.Address.Equals([System.Net.IPAddress]::Loopback) -or $listener.Address.Equals([System.Net.IPAddress]::Any))) { return $true }
    }
    return $false
}

# 引数を 1 本のコマンドラインにする (Windows の規則: 空白か " を含むものは " で囲み、" の前と末尾の \ は 2 倍にする。
# 末尾の \ をそのままにすると、閉じの " が打ち消されて次の引数とつながる。image.ps1 の SimpllmArgs.Quote と同じ規則)
function Quote-Args([string[]]$list) {
    $quoted = foreach ($item in $list) {
        if ($item -ne '' -and $item -notmatch '[\s"]') { $item }
        else { '"' + (($item -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    return $quoted -join " "
}

# 起動の経路 (専用ウィンドウを開くまで) では、PowerShell のモジュールのコマンドレットを使わない:
#   Join-Path・Split-Path・Test-Path・New-Item・Get-ChildItem など (Microsoft.PowerShell.Management) は .NET の [IO.Path]・[IO.File]・[IO.Directory] で、
#   New-Object など (Microsoft.PowerShell.Utility) は [型]::new() で書く。
# 最初の 1 回でモジュールの読み込み (実測 約 60ms) が起き、ウィンドウを開くのがその分遅れる
$utf8 = [System.Text.UTF8Encoding]::new($false)
$runDir = [IO.Path]::Combine($root, ".run")
$portFile = [IO.Path]::Combine($runDir, "port") # 起動中の画面のポート (-BuildOnly で同じ番号の画面を作るため)
$portExplicit = $PSBoundParameters.ContainsKey('Port')

if (-not $BuildOnly) {
    $binDir = [IO.Path]::Combine($root, "bin")
    if (-not [IO.File]::Exists($server)) {
        # zip をフォルダごと置いた (bin\llama-...\llama-server.exe) のはよくある間違いなので、場所を示す
        $nested = @(Get-ChildItem -LiteralPath $binDir -Filter "llama-server.exe" -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($nested.Count) { Fail (L 'bin.nested') (L 'bin.nestedDetail' @{ dir = $nested[0].DirectoryName }) }
        Fail (L 'bin.missing' @{ path = $server }) (L 'bin.missingDetail')
    }
    # 共有ファイルや一時画像、画面の HTML に触る前に二重起動を止める。
    $sessionLock = [System.Threading.Mutex]::new($false, "Local\simpllm-session")
    $lockTaken = $false
    try { $lockTaken = $sessionLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $lockTaken = $true }
    if (-not $lockTaken) { Fail (L 'start.alreadyRunning') }
    # 画面用と受付用 (+1) の 2 つの番号を使う。使用中なら、番号を指定していないときに限り空いている組を探す
    if (Test-PortOpen $Port, ($Port + 1)) {
        if ($portExplicit) { Fail (L 'port.inUse' @{ port = $Port; next = $Port + 1 }) (L 'port.inUseDetail') }
        $found = 0
        for ($candidate = 8090; $candidate -lt 8400; $candidate += 2) {
            if (-not (Test-PortOpen $candidate, ($candidate + 1))) { $found = $candidate; break }
        }
        if (-not $found) { Fail (L 'port.noneFree') (L 'port.noneFreeDetail') }
        $Port = $found
    }
    # 設定・履歴・画面はこのフォルダの中に書く。書けない場所 (Program Files や読み取り専用) なら、理由を示して止める
    try {
        [void][IO.Directory]::CreateDirectory($runDir)
        [IO.File]::WriteAllText($portFile, "$Port", $utf8)
        # 終了の手順の記録 (時刻と手順だけ。起動のたびに上書き)
        $script:sessionLogPath = [IO.Path]::Combine($runDir, "last-session.log")
        [IO.File]::WriteAllText($script:sessionLogPath, "", $utf8)
        $appVersion = try { [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'version.txt'), $utf8).Trim() } catch { '?' }
        Write-SessionLog "launcher started (SimpLLM $appVersion, pid $PID)"
    } catch {
        Fail (L 'folder.notWritable') (L 'folder.notWritableDetail' @{ root = $root })
    }
    # CUDA 版なのに 2 つ目の zip (cudart) の中身が無いのは、よくある入れ忘れ。GPU を使えないか、起動に失敗する (どちらになるかは未確認)。
    # 気付けるように 1 度だけ知らせる (別の場所に CUDA を入れている PC もあるので、止めはしない)
    $binNote = [IO.Path]::Combine($runDir, "bin-notice")
    if ([IO.File]::Exists(([IO.Path]::Combine($binDir, "ggml-cuda.dll"))) -and -not [IO.File]::Exists($binNote)) {
        $hasRuntime = [IO.Directory]::GetFiles($binDir, "cudart64_*.dll").Count -gt 0 # 起動のたびに通るので Get-ChildItem を使わない (約 5ms → 1ms)
        if (-not $hasRuntime) {
            foreach ($dir in ($env:PATH -split ';')) {
                if ($dir -and (Test-Path -LiteralPath $dir -PathType Container) -and @(Get-ChildItem -LiteralPath $dir -Filter "cudart64_*.dll" -File -ErrorAction SilentlyContinue).Count) { $hasRuntime = $true; break }
            }
        }
        if (-not $hasRuntime) {
            Show-Problem (L 'gpu.runtimeMissing') (L 'gpu.runtimeMissingDetail')
            try { [IO.File]::WriteAllText($binNote, "1", $utf8) } catch { }
        }
    }
} elseif (-not $portExplicit -and [IO.File]::Exists($portFile)) {
    $recorded = 0
    if ([int]::TryParse([IO.File]::ReadAllText($portFile, $utf8).Trim(), [ref]$recorded) -and $recorded -gt 0 -and $recorded -lt 65535) { $Port = $recorded }
}

# --- UI のビルド（変更がなければソースの読み直しを省く） ---------------------------
# 画面の HTML には受付用のポート番号が入る (CSP)。番号が変わったときだけ作り直す
$controlPort = $Port + 1
. ([IO.Path]::Combine($PSScriptRoot, 'ui-build.ps1'))
$uiBuild = Update-UI $root $controlPort -Force:$BuildOnly
if ($BuildOnly) { Write-Host (L 'build.done' @{ path = $uiBuild.path }); exit 0 }

# --- 起動設定 (設定画面の「起動設定」で変える。.run\launch.json) ----------------------
# 優先順: 起動時に明示した引数 > 保存した設定 > 既定 (llama.cpp の標準)
$launchPath = [IO.Path]::Combine($runDir, "launch.json")
$launchParams = [ordered]@{ Vision = 'vision'; Context = 'context'; UBatch = 'ubatch'; FitMarginMiB = 'fitMarginMiB'; LoadMode = 'loadMode'; MoeCacheMiB = 'moeCacheMiB'; CpuMoe = 'cpuMoe'; TensorSplit = 'tensorSplit'; CacheType = 'cacheType' }
# vision は既定でオン: 対応する mmproj がモデルと同じフォルダにあるモデルだけ、画像を受け取れるようになる (無いモデルはそのまま動く)
$launchDefaults = [ordered]@{ vision = $true; context = 0; ubatch = 0; fitMarginMiB = 0; loadMode = 'auto'; moeCacheMiB = 0; cpuMoe = -1; tensorSplit = ''; cacheType = '' }
$script:launchArgs = @{} # 起動時に明示した引数 (設定画面では変えられない)
foreach ($name in $launchParams.Keys) { if ($PSBoundParameters.ContainsKey($name)) { $script:launchArgs[$name] = $PSBoundParameters[$name] } }
$launchFixed = @(foreach ($name in $launchParams.Keys) { if ($script:launchArgs.ContainsKey($name)) { $launchParams[$name] } })

# 値を検証して、決まった形にそろえる。不正なら例外 (値はそのままサーバーの引数になるので、形を厳しく決める)
function ConvertTo-LaunchSettings($source) {
    $out = [ordered]@{}
    foreach ($key in $launchDefaults.Keys) {
        $value = $launchDefaults[$key]
        if ($null -ne $source) {
            $given = if ($source -is [System.Collections.IDictionary]) { if ($source.Contains($key)) { $source[$key] } else { $null } } else { $source.$key }
            if ($null -ne $given) { $value = $given }
        }
        $number = 0
        $isInt = $value -isnot [bool] -and [int]::TryParse([string]$value, [ref]$number)
        switch ($key) {
            'vision' { if ($value -isnot [bool]) { throw (L 'launch.badVision') }; $out[$key] = $value }
            'context' { if (-not $isInt -or ($number -ne 0 -and ($number -lt 512 -or $number -gt 1048576))) { throw (L 'launch.badContext') }; $out[$key] = $number }
            'ubatch' { if (-not $isInt -or ($number -ne 0 -and ($number -lt 16 -or $number -gt 8192))) { throw (L 'launch.badUbatch') }; $out[$key] = $number }
            'fitMarginMiB' { if (-not $isInt -or $number -lt 0 -or $number -gt 65536) { throw (L 'launch.badFitMargin') }; $out[$key] = $number }
            'moeCacheMiB' { if (-not $isInt -or $number -lt 0 -or $number -gt 65536) { throw (L 'launch.badMoeCache') }; $out[$key] = $number }
            'cpuMoe' { if (-not $isInt -or $number -lt -1 -or $number -gt 999) { throw (L 'launch.badCpuMoe') }; $out[$key] = $number }
            'loadMode' { if (@('auto', 'mmap', 'none', 'mlock', 'mmap+mlock') -cnotcontains [string]$value) { throw (L 'launch.badLoadMode') }; $out[$key] = [string]$value }
            'tensorSplit' { if ([string]$value -notmatch '^(\d{1,3}(\.\d{1,3})?(,\d{1,3}(\.\d{1,3})?){0,7})?$') { throw (L 'launch.badTensorSplit') }; $out[$key] = [string]$value }
            'cacheType' { if (@('', 'f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1') -cnotcontains [string]$value) { throw (L 'launch.badCacheType') }; $out[$key] = [string]$value }
        }
    }
    return $out
}

# 保存した設定に、起動時の引数で明示したものを重ねる
function Get-EffectiveLaunch($saved) {
    $merged = [ordered]@{}
    foreach ($key in $saved.Keys) { $merged[$key] = $saved[$key] }
    foreach ($name in $launchParams.Keys) {
        if ($script:launchArgs.ContainsKey($name)) {
            $value = $script:launchArgs[$name]
            if ($value -is [System.Management.Automation.SwitchParameter]) { $value = $value.IsPresent }
            $merged[$launchParams[$name]] = $value
        }
    }
    return ConvertTo-LaunchSettings $merged
}

# 保存した起動設定 (.run\launch.json) の中身を読む。自分で書いた形 (1 行で、値は文字列・整数・真偽だけ) はそのまま読む:
# 起動のたびに通るので、初回の呼び出しが重い ConvertFrom-Json (実測 約 55ms) を避ける。それ以外の形は ConvertFrom-Json に任せる。
# 値はこの後 ConvertTo-LaunchSettings が検証する
function Read-LaunchFile([string]$text) {
    $text = $text.Trim()
    $pair = '"(\w+)":(true|false|-?\d{1,9}|"[^"\\]*")'
    if ($text -cnotmatch "^\{($pair(,$pair)*)?\}`$") { return $text | ConvertFrom-Json }
    $out = @{}
    foreach ($m in [regex]::Matches($text, $pair)) {
        $key = $m.Groups[1].Value
        $raw = $m.Groups[2].Value
        if ($out.ContainsKey($key)) { return $text | ConvertFrom-Json } # 同じ項目が 2 回ある
        $out[$key] = if ($raw -ceq 'true') { $true } elseif ($raw -ceq 'false') { $false } elseif ($raw[0] -eq '"') { $raw.Substring(1, $raw.Length - 2) } else { [int]$raw }
    }
    return $out
}


# llama-server の router モードでモデルを切り替える。設定ファイルは ASCII のパスに置く (日本語を含むパスだと読めない)
# public\ には置かない (--path で配信されてしまう)
function New-ModelPreset($files, [bool]$vision = $script:launch.vision) {
    $ini = [System.Text.StringBuilder]::new()
    $seen = @{}
    $mmprojIn = @{} # フォルダ → その中の mmproj*.gguf (モデルごとに同じフォルダを調べ直さない)
    foreach ($file in $files) {
        $id = $file.BaseName -replace "[\[\]\r\n]", "_"
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        [void]$ini.AppendLine("[$id]").AppendLine("model = $($file.FullName)")
        if ($vision) {
            $mm = $Mmproj
            if ($mm -eq "") {
                # 量子化の部分を除いた名前が一致する mmproj を使う
                $stem = $file.BaseName -replace "[-.](IQ\d|Q\d|BF16|F16|F32).*$", ""
                $dir = $file.DirectoryName
                if (-not $mmprojIn.ContainsKey($dir)) { $mmprojIn[$dir] = @(Get-ChildItem -LiteralPath $dir -Filter "mmproj*.gguf" -ErrorAction SilentlyContinue) }
                foreach ($candidate in $mmprojIn[$dir]) { if ($candidate.Name -like "*$stem*") { $mm = $candidate.FullName; break } }
            }
            # mmproj が無いモデルは、画像入力なしで使う (画面が「このモデルは対応していない」と知らせる)。
            # 起動時に -Vision と明示したときだけ、無ければ止める (頼んだことができないのを黙って進めない)
            if ($mm -eq "") {
                if ($script:launchArgs.ContainsKey('Vision')) { throw (L 'vision.noMmproj' @{ file = $file.Name }) }
            } else { [void]$ini.AppendLine("mmproj = $mm") }
        }
        [void]$ini.AppendLine()
    }
    return $ini.ToString()
}

# フォルダの選択画面。選ばなければ空文字を返す
function Select-ModelFolder([string]$initial, [string]$description) {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form # ブラウザの裏に隠れないよう、最前面の親を付ける
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
        $owner.TopMost = $true
        $owner.ShowInTaskbar = $false
        $owner.Opacity = 0
        $owner.Show()
        $dialog.Description = $description
        $dialog.ShowNewFolderButton = $false
        if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
        return ""
    } finally {
        $dialog.Dispose()
        $owner.Dispose()
    }
}


# 起動ごとに使い捨てのAPIキーを生成する。
# 127.0.0.1 限定でも、ブラウザで開いた悪意あるWebページが localhost を叩けるため、その対策。
$bytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
    $apiKey = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    # 推論サーバーは別ポート・別キー。UIのキーでゲートウェイを迂回できないようにする。
    $rng.GetBytes($bytes)
    $nativeKey = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
} finally { $rng.Dispose() }
[Array]::Clear($bytes, 0, $bytes.Length)
$nativeProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$nativeProbe.Start(); $nativePort = $nativeProbe.LocalEndpoint.Port; $nativeProbe.Stop()
if ($nativePort -eq $controlPort -or $nativePort -eq $Port) { Fail (L 'port.internalFailed') }
. ([IO.Path]::Combine($PSScriptRoot, "offline.ps1"))

# 推論サーバーの引数。起動設定 ($script:launch) から作る (設定画面で変えたら作り直して再起動する)
# 設定ファイルは作業フォルダ (.run) からの相対パスで渡す: llama-server は日本語を含むパスの引数を読めない (実測)。
# ファイルの中に書いたモデルのパスは、日本語を含んでいても読める (実測)
function Get-ServerArgs {
    $l = $script:launch
    $list = @(
        "--models-preset", "models.ini", # ローカルファイルのみ。-hf 等のダウンロード系フラグは使わない
        "--models-max", "1",          # 別のモデルを読み込むときは、今のモデルを先に解放する
        "--no-models-autoload",       # モデルの読み込みは UI の指示だけで行う
        "--offline",                  # 自動ダウンロードを抑止。メディアURLはoffline.ps1でも拒否する
        "--host", "127.0.0.1",        # 外部(LAN)からは接続不可
        "--port", "$nativePort",
        "--cors-origins", "http://127.0.0.1:$Port", # 他サイトからのレスポンス読み取りをブラウザに拒否させる
        "--cors-methods", "GET,POST",
        "--cors-headers", "Authorization,Content-Type",
        "--no-cors-credentials",
        "--no-slots",                 # UI で使わない API は閉じる
        "--no-webui",                 # 画面は SimpllmOfflineApi が publicindex.html から返す (内蔵WebUIは使わない)
        "--jinja",
        "--reasoning-format", $ReasoningFormat
    )
    # 通常の起動では警告とエラーだけを出させる (失敗の理由の判定用。会話の内容を含む通常のログは出させない。直近だけをメモリに持ち、ファイルには書かない)
    if (-not $ShowServerLog) { $list += @("--log-verbosity", "2") }
    # 0 = モデルの値から、メモリに収まるよう --fit が決める。ただし 16384 より短くはしない
    # (下限なしだと 4096 まで縮めることがあり、思考だけで回答が途切れる。下限を付けても速度はほぼ同じ: 実測 4096=34.9, 16384=29.5, 32768=32.6 tok/s)
    if ($l.context -gt 0) { $list += @("-c", "$($l.context)") } else { $list += @("--fit-ctx", "16384") }
    if ($l.loadMode -ne "auto") { $list += @("--load-mode", $l.loadMode) }
    if (-not $l.vision) { $list += @("--no-mmproj") }
    if ($l.tensorSplit -ne "") { $list += @("--tensor-split", $l.tensorSplit) }
    if ($l.cpuMoe -ge 0) { $list += @("--n-cpu-moe", "$($l.cpuMoe)") }
    if ($Parallel -gt 0) { $list += @("--parallel", "$Parallel") }
    if ($l.cacheType -ne "") { $list += @("-ctk", $l.cacheType, "-ctv", $l.cacheType) }
    if ($l.fitMarginMiB -gt 0) { $list += @("--fit-target", "$($l.fitMarginMiB)") }
    if ($l.ubatch -gt 0) { $list += @("-b", "$($l.ubatch)", "-ub", "$($l.ubatch)") }
    if ($l.moeCacheMiB -gt 0) { $list += @("--moe-cache-mib", "$($l.moeCacheMiB)") }
    return $list
}

# キーは URL のフラグメントで UI に渡す (サーバーへのリクエストには含まれない)
$url = "http://127.0.0.1:$Port/#key=$apiKey"
# 画面の言語を、こちらの知らせの言語とそろえる (候補のうち、URL に入れられる形の最初のもの。画面も同じ決め方で言語にする)
$urlLang = ''
foreach ($hint in $script:languageHint) { if ($hint -cmatch '^[A-Za-z0-9-]{2,20}$') { $urlLang = "&lang=$hint"; break } }
$browserPath = $null
if (-not $NoBrowser) {
    if ($Browser) {
        # 指定したブラウザを使う。起動フラグが Chrome 系のものなので、Chrome 系 (Chrome・Edge・Brave など) に限る
        if (-not [IO.File]::Exists($Browser)) { Fail (L 'browser.notFound') $Browser }
        $browserPath = $Browser
    } else {
        foreach ($candidate in @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
        )) { if ([IO.File]::Exists($candidate)) { $browserPath = $candidate; break } } # パイプラインより速い
        if ($null -eq $browserPath) {
            # いつもの場所に無ければ、Windows に登録された場所を見る (別のドライブに入れた Chrome など)
            foreach ($exe in "chrome.exe", "msedge.exe") {
                foreach ($hive in "HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE") {
                    $registered = [string][Microsoft.Win32.Registry]::GetValue("$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe", "", "")
                    $registered = $registered.Trim('"')
                    if ($registered -and [IO.File]::Exists($registered)) { $browserPath = $registered; break }
                }
                if ($null -ne $browserPath) { break }
            }
        }
        if ($null -eq $browserPath) {
            Fail (L 'browser.noneFound') (L 'browser.noneFoundDetail')
        }
    }
}
# 専用ウィンドウの起動フラグ
# --proxy-server: 存在しないプロキシを指定し、localhost 以外への通信をすべて失敗させる
# --disable-features: キャスト機能はプロキシを通らず LAN 内の機器に接続するので止める
# --disable-breakpad 以降: クラッシュレポート・ログ・ディスクキャッシュをできるだけ書かせない (プロファイルは終了時に消す)
$browserFlags = @(
    "--proxy-server=http://127.0.0.1:9",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
    "--disable-features=MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider,GlobalMediaControls,Translate,OptimizationHints",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-logging",
    "--disk-cache-size=1",
    "--media-cache-size=1",
    "--disable-gpu-shader-disk-cache",
    "--disable-spell-checking",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-mode",
    "--no-pings",
    "--no-first-run",
    "--no-default-browser-check"
)

# --- 前回のプロファイルと旧履歴の削除 --------------------------------------------
# 前回が異常終了していたら、専用プロファイルが残っている。-NoBrowser でも消す
if (-not (Close-Session $profileDir)) { Fail (L 'cleanup.historyFailed') $profileDir }
if (-not $NoBrowser) { [void][IO.Directory]::CreateDirectory($profileDir) }


# --- 専用ウィンドウを開いた後に行う準備 ----------------------------------------------
# ウィンドウを開くのに要らないこと (起動設定の読み込み、モデル・画像・履歴のスクリプトの読み込み、モデルのフォルダの走査、
# 推論サーバーの起動の用意) は、ブラウザを起動してから行う。ブラウザが立ち上がるのを待つ間に済むので、その分だけ早くウィンドウが出る。
# 画面は SimpllmOfflineApi が先に返し、推論サーバーへの依頼はサーバーが待ち受けるまで送り直す。受付への依頼は、この準備が済むまで OS が溜めておく。
# ここでの失敗 (モデルが見つからない、など) は、ウィンドウが開いた後に出る: ウィンドウを閉じて片付けてから知らせる。
# 呼び出しは「. Initialize-Backend」: 関数の中身を呼び出し元 (スクリプト) のスコープで実行するので、ここで読み込むスクリプトの関数と
# ここで作る変数は、スクリプト全体から使える
function Initialize-Backend {
    $script:launchSaved = $null
    if ([IO.File]::Exists($launchPath)) {
        try { $script:launchSaved = ConvertTo-LaunchSettings (Read-LaunchFile ([IO.File]::ReadAllText($launchPath, $utf8))) }
        catch {
            # 起動は既定の設定で続ける。専用ウィンドウがあれば、開いた直後に画面の中へ出す (GET /notices)。無ければその場で知らせる
            $notice = (L 'launch.unreadable') + "`n$launchPath`n$($_.Exception.Message)"
            if ($null -ne $control) { $script:startNotices.Add($notice) } else { Show-Problem (L 'launch.unreadable') "$launchPath`n$($_.Exception.Message)" }
        }
    }
    if ($null -eq $script:launchSaved) { $script:launchSaved = ConvertTo-LaunchSettings $null }
    # 起動時の引数がなければ、保存した設定がそのまま使う設定 (同じ検証を繰り返さない。どちらも書き換えず、変えるときは作り直す)
    if ($script:launchArgs.Count -eq 0) { $script:launch = $script:launchSaved }
    else { try { $script:launch = Get-EffectiveLaunch $script:launchSaved } catch { Fail (L 'launch.badArgs') $_.Exception.Message } }
    . (Join-Path $PSScriptRoot "models.ps1") # モデルの一覧 (チャット用・画像用)。Find-ModelFiles もここ
    . (Join-Path $PSScriptRoot "image.ps1") # 画像の生成・編集 (sd-cli)。UI のビルドだけのときは読み込まない
    Clear-ImageTemp # 前回が異常終了していたら、一時ファイルが残っている
    . (Join-Path $PSScriptRoot "history.ps1") # チャット履歴の保存 (history\)
    Initialize-History # 用意できなくても起動は続ける (UI に「保存されません」と理由を出す)
    . (Join-Path $PSScriptRoot 'history-worker.ps1')
    Start-HistoryWorker
    $iniPath = Join-Path $runDir "models.ini"
    $modelDirFile = Join-Path $runDir "model-dir"
    $modelDir = Join-Path $root "models" # 既定はアプリ内の models。別の場所は設定画面で選び、.run\model-dir に覚える
    if (Test-Path -LiteralPath $modelDirFile) {
        $saved = [IO.File]::ReadAllText($modelDirFile, $utf8).Trim()
        if ($saved) { $modelDir = $saved }
    }

    $modelFixed = $Model.Count -gt 0
    if ($modelFixed) {
        $modelFiles = @($Model | ForEach-Object { Get-Item -LiteralPath $_ })
    } else {
        $modelFiles = @(Find-ModelFiles @((Join-Path $root "models"), $modelDir))
        # フォルダを動かしたときなど。ここで止めると設定画面を開けないので、この場で選んでもらう
        while ($modelFiles.Count -eq 0) {
            $picked = Select-ModelFolder $modelDir (L 'models.pickFolder')
            if (-not $picked) { Fail (L 'models.noneFound') (L 'models.noneFoundDetail' @{ dir = $modelDir }) }
            $modelDir = $picked
            $modelFiles = @(Find-ModelFiles @((Join-Path $root "models"), $modelDir))
            if ($modelFiles.Count -gt 0) { [IO.File]::WriteAllText($modelDirFile, $modelDir, $utf8) }
        }
    }
    try { $presetText = New-ModelPreset $modelFiles } catch { Fail $_.Exception.Message }
    [IO.File]::WriteAllText($iniPath, $presetText, $utf8)

    if (-not $Hidden) { # コンソールのない起動 (ふだんの起動) では表示先が無いので、何もしない
        Write-Host ""
        Write-Host (L 'console.models' @{ names = (($modelFiles | ForEach-Object { $_.Name }) -join ', ') })
        if ($NoBrowser) {
            Write-Host "URL    : $url$urlLang"
            Write-Host (L 'console.quitHint')
        } else {
            Write-Host (L 'console.closeHint')
        }
        Write-Host ""
    }

    # このスクリプトがどう終わっても、サーバーと子プロセスが残らないよう Job Object に入れる
    Import-CSharp "SimpllmJob" -source @"
using System;
using System.Runtime.InteropServices;
public static class SimpllmJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic BasicInfo;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    // ハンドルが閉じられる (= このプロセスが終わる) と、Job 内のプロセスがすべて終了する
    public static IntPtr KillOnClose(IntPtr process) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Extended info = new Extended();
        info.BasicInfo.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(info)) || !AssignProcessToJobObject(job, process)) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        return job;
    }
}

// サーバーのログの直近だけをメモリに持つ (起動・読み込みに失敗した理由を知らせるため)。ファイルには書かない
public sealed class SimpllmServerLog {
    readonly System.Collections.Generic.Queue<string> lines = new System.Collections.Generic.Queue<string>();
    const int Max = 300;
    public void Attach(System.Diagnostics.Process p) {
        p.OutputDataReceived += delegate(object s, System.Diagnostics.DataReceivedEventArgs e) { Add(e.Data); };
        p.ErrorDataReceived += delegate(object s, System.Diagnostics.DataReceivedEventArgs e) { Add(e.Data); };
    }
    void Add(string line) {
        if (line == null) return;
        if (line.Length > 500) line = line.Substring(0, 500);
        lock (lines) { lines.Enqueue(line); while (lines.Count > Max) lines.Dequeue(); }
    }
    public string[] Snapshot() { lock (lines) { return lines.ToArray(); } }
    public void Clear() { lock (lines) { lines.Clear(); } }
}
"@

    # サーバーには環境変数でキーを渡す。ブラウザのコマンドライン (--app) には残るが、読めるのは同じ PC 上のプログラムだけ
    $serverInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $serverInfo.FileName = $server # 引数は Start-LlamaServer が起動のたびに作る
    $serverInfo.WorkingDirectory = $runDir # models.ini を相対パスで渡すため
    $serverInfo.UseShellExecute = $false
    $serverInfo.EnvironmentVariables["LLAMA_API_KEY"] = $nativeKey
    # libcurlの外部取得経路にも通信不能なプロキシを設定。OS全体の通信遮断ではない。
    foreach ($proxyName in @('http_proxy', 'https_proxy', 'all_proxy')) { $serverInfo.EnvironmentVariables[$proxyName] = 'http://127.0.0.1:9' }
    $serverInfo.EnvironmentVariables['no_proxy'] = ''
    if (-not $ShowServerLog) {
        # router の子プロセスの出力も親を通って流れてくる。直近だけをメモリに持ち、残りは捨てる (コンソールにもファイルにも残さない)
        $serverInfo.RedirectStandardOutput = $true
        $serverInfo.RedirectStandardError = $true
    }
    $serverLog = [SimpllmServerLog]::new()
}

function Start-LlamaServer {
    $serverInfo.Arguments = Quote-Args (Get-ServerArgs) # 起動設定を変えたときのため、毎回作る
    $serverLog.Clear()
    $script:serverProcess = [System.Diagnostics.Process]::new()
    $script:serverProcess.StartInfo = $serverInfo
    if (-not $ShowServerLog) { $serverLog.Attach($script:serverProcess) }
    [void]$script:serverProcess.Start()
    try {
        $script:job = [SimpllmJob]::KillOnClose($script:serverProcess.Handle)
        if (-not $ShowServerLog) {
            $script:serverProcess.BeginOutputReadLine()
            $script:serverProcess.BeginErrorReadLine()
        }
    } catch {
        if (-not $script:serverProcess.HasExited) { $script:serverProcess.Kill() }
        throw
    }
}

# --- UI からの依頼の受付 ---------------------------------------------------------------
# ブラウザはファイルに書けないので、モデルのフォルダの変更だけをここで受ける。
# 127.0.0.1 のみで待ち受け、Host と自分の UI のオリジン、起動ごとの API キーのすべてを必須にする。
$appOrigin = "http://127.0.0.1:$Port"
$control = $null
$controlPending = $null
function Start-ControlListener {
    try {
        # 他のプログラムが使用中なら、設定画面からの変更だけを諦める (下の catch)
        $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $controlPort)
        $probe.Start()
        $probe.Stop()
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://127.0.0.1:$controlPort/")
        $listener.Start()
        $script:control = $listener
        $script:controlPending = $listener.BeginGetContext($null, $null)
    } catch { $script:control = $null }
}

function Send-ControlResponse($context, [int]$status, $body) {
    $response = $context.Response
    try {
        $response.StatusCode = $status
        $origin = $context.Request.Headers["Origin"]
        if ($origin -ceq $appOrigin) {
            $response.AddHeader("Access-Control-Allow-Origin", $appOrigin)
            $response.AddHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
            $response.AddHeader("Access-Control-Allow-Methods", "GET, POST")
        }
        $response.ContentType = "application/json; charset=utf-8"
        $bytes = $utf8.GetBytes(($body | ConvertTo-Json -Compress -Depth 8)) # 既定の深さ (2) だと、モデルの一覧の中身が文字列に潰れる
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { } finally { try { $response.Close() } catch { } }
}

# 画像や履歴の本文をそのまま返す (画像・履歴の受付で共用)
function Send-ControlBytes($context, [byte[]]$bytes, [string]$type) {
    $response = $context.Response
    try {
        $response.StatusCode = 200
        $response.AddHeader("Access-Control-Allow-Origin", $appOrigin)
        $response.AddHeader("Cache-Control", "no-store")
        $response.ContentType = $type
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { } finally { try { $response.Close() } catch { } }
}

# 依頼の本文 (JSON) を読む。大きさは依頼ごとの上限まで
function Read-ControlJson($request, [int]$maxBytes) {
    if ($request.ContentLength64 -le 0 -or $request.ContentLength64 -gt $maxBytes) { throw (L 'common.badBodySize') }
    $reader = New-Object IO.StreamReader($request.InputStream, $utf8)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}

function Read-ControlPath($request) {
    if ($request.ContentLength64 -gt 8192) { throw (L 'control.pathTooLong') }
    $reader = New-Object IO.StreamReader($request.InputStream, $utf8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return [string](($text | ConvertFrom-Json).path)
}

# 先に検証し、問題があれば今のサーバーに触らず例外を投げる
function Set-ModelDir([string]$path) {
    if (Test-ImageRunning) { throw (L 'image.busyApply') }
    $path = $path.Trim().Trim('"')
    if (-not [IO.Path]::IsPathRooted($path) -or $path -notmatch '^[A-Za-z]:\\') { throw (L 'modelDir.needDrive') }
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw (L 'modelDir.notFound' @{ path = $path }) }
    $path = (Get-Item -LiteralPath $path).FullName
    if (@(Find-ModelFiles @($path)).Count -eq 0) { throw (L 'modelDir.noGguf' @{ path = $path }) }
    $presetText = New-ModelPreset (Find-ModelFiles @((Join-Path $root "models"), $path))

    [IO.File]::WriteAllText($modelDirFile, $path, $utf8)
    $script:modelDir = $path
    Clear-ImageInventoryCache # 画像モデルを探す場所が変わった
    Restart-LlamaServer $presetText
    return $path
}

# 置いたばかりのチャット用モデルを使えるようにする。一覧が変わっていなければ何もしない ($false)
function Update-ChatModels {
    if (Test-ImageRunning) { throw (L 'image.busySwitch') }
    $presetText = New-ModelPreset (Find-ModelFiles @((Join-Path $root "models"), $modelDir))
    if ((Test-Path -LiteralPath $iniPath) -and [IO.File]::ReadAllText($iniPath, $utf8) -ceq $presetText) { return $false }
    Restart-LlamaServer $presetText
    return $true
}

# 新しい一覧を書いて、サーバーを入れ替える (呼び出し側が一覧を作り終えてから呼ぶ。失敗しても今のサーバーはまだ止めていない)
# router はモデルの一覧を起動時にしか読まない (起動中にフォルダへ足しても一覧に出ない。実測)
function Restart-LlamaServer([string]$presetText) {
    [IO.File]::WriteAllText($iniPath, $presetText, $utf8)
    [void][SimpllmJob]::CloseHandle($script:job)
    $script:job = [IntPtr]::Zero
    if (-not $script:serverProcess.WaitForExit(10000)) { throw (L 'server.stopTimeout') }
    $deadline = (Get-Date).AddSeconds(5)
    while ((Test-PortOpen $nativePort) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Start-LlamaServer
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $script:serverProcess.HasExited -and -not (Test-PortOpen $nativePort) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($script:serverProcess.HasExited) { throw (L 'server.restartFailed') }
}

# サーバーのログの直近から、起動・読み込みに失敗した理由を分かる言葉にする。分からなければ reason は空
# (表の reason は文言のキー。文言にするのは使うときで、起動時には言語のファイルを読まない)
$script:serverProblems = @(
    @{ pattern = 'No mapping for the Unicode character|failed to open .*models\.ini'; reason = 'server.problem.path' }
    @{ pattern = 'out of memory|cudaMalloc failed|failed to allocate|alloc_buffer: .*failed|unable to allocate|not enough memory|bad_alloc'; reason = 'server.problem.memory' }
    @{ pattern = 'CUDA driver version is insufficient|driver version is insufficient|cudaErrorInsufficientDriver'; reason = 'server.problem.driver' }
    @{ pattern = 'unknown model architecture|unsupported model architecture'; reason = 'server.problem.arch' }
    @{ pattern = 'invalid magic|failed to read .*gguf|tensor .* data is not within the file bounds|gguf_init_from_file.*failed|failed to load model|error loading model'; reason = 'server.problem.file' }
    @{ pattern = 'failed to load mmproj|mmproj.*(failed|error)|clip.*(failed|error)'; reason = 'server.problem.mmproj' }
    @{ pattern = 'error: (invalid|unknown) argument|unrecognized (option|argument)'; reason = 'server.problem.options' }
    @{ pattern = "couldn't bind|address already in use|bind failed"; reason = 'server.problem.port' }
)
function Get-ServerDiagnosis {
    $lines = @($serverLog.Snapshot())
    $tail = @($lines | Select-Object -Last 12)
    # いちばん新しい行から見る (前に出た無害な警告より、最後の失敗の理由を優先する)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        foreach ($problem in $script:serverProblems) {
            if ($lines[$i] -match $problem.pattern) { return @{ reason = (L $problem.reason); lines = $tail } }
        }
    }
    return @{ reason = ""; lines = $tail }
}

# 設定画面の「起動設定」: 検証してから保存し、サーバーを入れ替える。起動できなければ元の設定に戻す
function Set-LaunchSettings($body) {
    if (Test-ImageRunning) { throw (L 'image.busyApply') }
    $saved = ConvertTo-LaunchSettings $body
    $effective = Get-EffectiveLaunch $saved # 起動時の引数で指定したものは、そちらを使い続ける
    $files = if ($modelFixed) { $modelFiles } else { Find-ModelFiles @((Join-Path $root "models"), $modelDir) }
    $presetText = New-ModelPreset $files $effective.vision # 一覧を作れないときは、ここで止まる (今のサーバーには触らない)
    $previous = @{ saved = $script:launchSaved; launch = $script:launch; preset = [IO.File]::ReadAllText($iniPath, $utf8) }
    [IO.File]::WriteAllText($launchPath, ($saved | ConvertTo-Json -Compress), $utf8)
    $script:launchSaved = $saved
    $script:launch = $effective
    try { Restart-LlamaServer $presetText }
    catch {
        $diagnosis = Get-ServerDiagnosis
        [IO.File]::WriteAllText($launchPath, ($previous.saved | ConvertTo-Json -Compress), $utf8)
        $script:launchSaved = $previous.saved
        $script:launch = $previous.launch
        try { Restart-LlamaServer $previous.preset } catch { }
        $why = if ($diagnosis.reason) { $diagnosis.reason } else { $_.Exception.Message }
        throw (L 'launch.reverted' @{ why = $why })
    }
}

function Get-LaunchInfo {
    return [ordered]@{ saved = $script:launchSaved; effective = $script:launch; fixed = @($launchFixed); defaults = $launchDefaults }
}

function Invoke-ControlRequest($context) {
    $request = $context.Request
    $origin = $request.Headers["Origin"]
    if ($origin -cne $appOrigin -or $request.Headers["Host"] -cne "127.0.0.1:$controlPort") { Send-ControlResponse $context 403 @{ error = (L 'control.forbidden') }; return }
    if ($request.HttpMethod -eq "OPTIONS") { Send-ControlResponse $context 200 @{}; return }
    if ($request.Headers["Authorization"] -cne "Bearer $apiKey") { Send-ControlResponse $context 401 @{ error = (L 'control.badKey') }; return }
    $route = "$($request.HttpMethod) $($request.Url.AbsolutePath)"
    try {
        # 履歴・モデルの一覧・フォルダの選択は、専用の runspace に渡す (history-worker.ps1。ディスクの読み書きや選択の画面で、この受付を止めない)。
        # runspace が無い・止まったときは、同じ処理をここで行う
        # (準備の途中で止まったときの片付けでは、まだ読み込んでいないことがある)
        if (${function:Test-BackgroundRoute} -and (Test-BackgroundRoute $route)) {
            $work = @{ context = $context; modelDir = $script:modelDir; modelFixed = $modelFixed; language = $script:language; languageHint = $script:languageHint }
            if (-not (Send-HistoryWork $work)) { Invoke-BackgroundRoute $context $route $modelFixed }
            return
        }
        if ($route -match "^(GET|POST) /image/" -and (Invoke-ImageRoute $context $route)) { return }
        switch ($route) {
            "GET /model-dir" { Send-ControlResponse $context 200 @{ path = $modelDir; fixed = $modelFixed } }
            "GET /server/diagnosis" { Send-ControlResponse $context 200 (Get-ServerDiagnosis) }
            "GET /launch" { Send-ControlResponse $context 200 (Get-LaunchInfo) }
            "GET /notices" {
                # 1 度渡したら消す (読み込み直しのたびに同じ知らせを出さない)
                $pending = @($script:startNotices)
                $script:startNotices.Clear()
                Send-ControlResponse $context 200 @{ notices = $pending }
            }
            "POST /launch" {
                $body = Read-ControlJson $request 8192
                Set-LaunchSettings $body
                Send-ControlResponse $context 200 (Get-LaunchInfo)
            }
            "POST /models/refresh" {
                if ($modelFixed) { throw (L 'models.fixedList') }
                Send-ControlResponse $context 200 @{ restarted = (Update-ChatModels) }
            }
            "POST /language" {
                # 設定画面で言語を変えた: こちらの知らせの言語もそろえ、次回の起動のために覚える (画面は自分で読み込み直す)
                $body = Read-ControlJson $request 256
                Set-Language ([string]$body.lang) $languageFile
                Clear-ImageInventoryCache # 一覧のメモや問題の文言は、作ったときの言語になっている
                Send-ControlResponse $context 200 @{ lang = $script:language }
            }
            "POST /model-dir" {
                if ($modelFixed) { throw (L 'models.fixed') }
                $applied = Set-ModelDir (Read-ControlPath $request)
                Send-ControlResponse $context 200 @{ path = $applied }
            }
            default { Send-ControlResponse $context 404 @{ error = (L 'common.notFound') } }
        }
    } catch {
        # 読み書きの失敗 (ファイルが一時的に使用中・ディスクがいっぱい) は 503。UI は 400 だけを「受け付けられない内容」として再送しない
        $status = 400
        for ($e = $_.Exception; $null -ne $e; $e = $e.InnerException) {
            if ($e -is [IO.IOException] -or $e -is [UnauthorizedAccessException]) { $status = 503; break }
        }
        Send-ControlResponse $context $status @{ error = $_.Exception.Message }
    }
}

function Receive-ControlRequests {
    # UIのポーリングが止まっても、完了した画像の作業ファイルを片付ける。
    # 片付けに失敗しても (ファイルが掴まれているなど) メインのループを抜けない。残りは次回の起動時に消す
    try { Update-ImageJob } catch { }
    if ($null -eq $control) { return }
    while ($controlPending.IsCompleted) {
        try { $context = $control.EndGetContext($controlPending) } catch { $context = $null }
        $script:controlPending = $control.BeginGetContext($null, $null)
        if ($null -ne $context) { Invoke-ControlRequest $context }
    }
}

# 起動したブラウザ。引数 -Browser ($Browser) とは別の名前にする: PowerShell は変数名の大文字小文字を区別しないので、
# 同じ名前だと文字列型の引数に Process が文字列として入り、ウィンドウを閉じても検知できなくなる (2026-11-12・13 の不具合)
$browserProcess = $null
$serverProcess = $null
$job = [IntPtr]::Zero
$exitCode = 0
$offlineApi = $null
$script:deferredProblems = [System.Collections.Generic.List[object]]::new()
$script:startNotices = [System.Collections.Generic.List[string]]::new() # 起動は続けるが知らせたいこと。画面が開いた直後に取りに来る
try {
    # 画面は推論サーバーの起動を待たずに返す (推論サーバーへの依頼は、サーバーが待ち受けるまで SimpllmOfflineApi が送り直す)
    $offlineApi = [SimpllmOfflineApi]::new($Port, $nativePort, $apiKey, $nativeKey)
    $offlineApi.IndexPath = [IO.Path]::Combine($public, "index.html")
    if (-not $NoBrowser) {
        # 専用ウィンドウを先に開き、残りの準備 (Initialize-Backend) と推論サーバーの起動は、ブラウザが立ち上がるのを待つ間に行う
        Start-ControlListener
        if ($null -ne $control) { $url += "&control=$controlPort" }
        $url += $urlLang
        # 普段のブラウザとは別のプロファイルを使う: 他のタブや拡張機能と分離し、閉じたことを確実に検知する
        $browserInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $browserInfo.FileName = $browserPath
        $browserInfo.Arguments = Quote-Args (@("--app=$url", "--user-data-dir=$profileDir") + $browserFlags)
        $browserInfo.UseShellExecute = $false
        $browserProcess = [System.Diagnostics.Process]::Start($browserInfo)
        Write-SessionLog ("browser started: " + $(if ($null -eq $browserProcess) { 'Process.Start returned nothing' } else { "pid $($browserProcess.Id)" }))
    }
    . Initialize-Backend
    Start-LlamaServer
    Write-SessionLog "server started (pid $($serverProcess.Id))"
    if ($NoBrowser) {
        $serverProcess.WaitForExit()
    } else {
        $browserWatch = New-BrowserWatch $browserProcess $profileDir
        if (-not $serverProcess.HasExited) {
            # 受付の最初の依頼が届くまでに、起動に必要ないことを済ませる
            [void](@{ warm = 1 } | ConvertTo-Json -Compress) # 初回だけ重い JSON 変換を、UI の最初の依頼より前に済ませる
            Install-DesktopShortcut $root (Join-Path $runDir "desktop-shortcut")
            # start.bat 用の目印: コンソールなしで直接起動できる Windows (10 1809 以降) だと分かっていれば、次回から版の確認 (ver) を省く
            $headlessMark = Join-Path $runDir "headless-ok"
            if (-not [IO.File]::Exists($headlessMark) -and [Environment]::OSVersion.Version.Build -ge 17763) { try { [IO.File]::WriteAllText($headlessMark, "1", $utf8) } catch { } }
            # 受付への依頼が届いたらすぐ起きて処理する (届かない間は 250ms ごとにウィンドウとサーバーの終了を確かめる)。
            # ウィンドウが閉じたかは、起動した Process と、専用プロファイルを使うプロセスの両方で確かめる (Test-BrowserGone)
            while (-not (Test-BrowserGone $browserWatch) -and -not $serverProcess.HasExited) {
                if ($null -ne $control) { [void]$controlPending.AsyncWaitHandle.WaitOne(250) } else { Start-Sleep -Milliseconds 250 }
                Receive-ControlRequests
            }
        }
        Write-SessionLog ("wait ended: " + $(if ($serverProcess.HasExited) { "server exited (code $($serverProcess.ExitCode))" } else { $browserWatch.reason }))
    }
    if ($serverProcess.HasExited) {
        $diagnosis = Get-ServerDiagnosis
        $detail = if ($diagnosis.reason) { $diagnosis.reason }
            # 0xC0000135: 必要な DLL が無くて、何も出力せずに終わった (zip の中身を一部しか入れていないとき)
            elseif ($serverProcess.ExitCode -eq -1073741515) { (L 'server.dllMissing') }
            else { (L 'server.unknownCause') + "`n" + ($diagnosis.lines -join "`n") }
        Show-Problem (L 'server.exited' @{ code = $serverProcess.ExitCode }) $detail
        $exitCode = 1
    }
} finally {
    # ブラウザの後始末に失敗しても、下の確認と片付けは必ず行う
    try {
        if ($null -ne $browserProcess -and -not $browserProcess.HasExited) {
            [void]$browserProcess.CloseMainWindow()
            if (-not $browserProcess.WaitForExit(3000)) { $browserProcess.Kill() }
        }
    } catch { }
    # 推論サーバーはもう使わないので、先に終了して VRAM を返す (下の保存の待ちと片付けの間、持ったままにしない)
    # (準備の途中で止まったときは、まだ読み込んでいない型や関数がある。あるものだけを片付ける)
    if ('SimpllmJob' -as [type]) { [void][SimpllmJob]::CloseHandle($job) }
    $job = [IntPtr]::Zero
    Write-SessionLog "shutdown: server stopped"
    if ($null -ne $control) {
        # 閉じる直前に UI が送った保存 (会話・設定) を取りこぼさないよう、届いている依頼を処理する。
        # 100ms 何も届かず、専用プロファイルのブラウザも残っていなければ、もう届くものは無いので終える (長くても 800ms)
        try {
            $drainUntil = [DateTime]::UtcNow.AddMilliseconds(800)
            while ([DateTime]::UtcNow -lt $drainUntil) {
                if ($controlPending.AsyncWaitHandle.WaitOne(100)) { Receive-ControlRequests; continue }
                $left = @()
                try { $left = @(Get-ProfileProcess $profileDir) } catch { continue } # 数えられないときは、時間いっぱい待つ
                $alive = $left.Count
                foreach ($p in $left) { $p.Dispose() }
                if ($alive -eq 0) { break }
            }
        } catch { }
        if (${function:Stop-HistoryWorker}) { Stop-HistoryWorker }
        try { $control.Close() } catch { }
        Write-SessionLog "shutdown: control requests drained, receiver closed"
    }
    if ($null -ne $offlineApi) { $offlineApi.Dispose(); Write-SessionLog "shutdown: page server closed" }
    try { if (${function:Stop-ImageJob}) { Stop-ImageJob ""; Clear-ImageTemp } } catch {
        Show-Problem (L 'cleanup.imageFailed') $_.Exception.Message
        $exitCode = 1
    }
    if ('SimpllmJob' -as [type]) { [void][SimpllmJob]::CloseHandle($job) } # 上で終了済み。待っている間に起動し直していた場合のために、もう一度閉じる

    if (-not $NoBrowser) {
        try { $cleaned = Close-Session $profileDir } catch { $cleaned = $false }
        Write-SessionLog "shutdown: profile removed: $cleaned"
        if (-not $cleaned) {
            Show-Problem (L 'cleanup.failed') (L 'cleanup.retry' @{ path = $profileDir })
            $exitCode = 1
        }
    }
    # 溜めた知らせは、サーバーを止めて片付けた後に出す
    $problems = $script:deferredProblems
    $script:deferredProblems = $null
    Write-SessionLog "shutdown: done (exit code $exitCode, notices $($problems.Count))"
    foreach ($p in $problems) { Show-Problem $p[0] $p[1] }
}
exit $exitCode
