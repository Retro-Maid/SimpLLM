if (-not $function:L) { . ([IO.Path]::Combine($PSScriptRoot, 'lang.ps1')) } # 文言 (L 'キー')。start.ps1 から読み込んだときは読み込み済み
# UIの生成物だけをキャッシュする。会話・設定・認証情報は扱わない。
# $root: データのフォルダ (public\ と .run\ を作る)。$UiDir: UI のソース (省略時はこのスクリプトの隣の ui\)
function Update-UI([string]$root, [int]$controlPort, [switch]$Force, [string]$UiDir = '') {
    $ui = if ($UiDir) { $UiDir } else { [IO.Path]::Combine($PSScriptRoot, 'ui') }
    $public = [IO.Path]::Combine($root, 'public')
    $index = [IO.Path]::Combine($public, 'index.html')
    $stamp = [IO.Path]::Combine($root, '.run\ui-build.stamp')
    $utf8 = [Text.UTF8Encoding]::new($false) # 起動のたびに通るので New-Object を使わない (start.ps1 の同じ注記を参照)
    $jsFiles = @('i18n.js', 'runtime.js', 'markdown.js', 'pdf.js', 'tools.js', 'app.js') # i18n.js はほかのスクリプトが文言を取り出すので先頭
    # 表示言語の文言 (src\lang\<言語>.json)。用意してある言語だけを埋め込む
    $langDir = [IO.Path]::Combine([IO.Path]::GetDirectoryName($ui), 'lang')
    $langCodes = @('ja', 'en', 'zh-CN', 'zh-TW', 'ko', 'de')
    $files = @('index.html', 'style.css', 'logo.webp', 'wordmark.svg', 'favicon-16.png', 'favicon-32.png') + $jsFiles
    # 起動のたびに通る確認なので、パイプラインと JSON の変換を使わない (JSON は初回の読み込みだけで約 100ms かかる)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("port=$controlPort")
    $lines.Add('format=3')
    foreach ($name in $files) {
        $file = [IO.FileInfo]::new(([IO.Path]::Combine($ui, $name)))
        if (-not $file.Exists) { throw (L 'build.missingFile' @{ name = $name }) }
        $lines.Add("$name|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
    }
    $langFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($code in $langCodes) {
        $file = [IO.FileInfo]::new(([IO.Path]::Combine($langDir, "$code.json")))
        if (-not $file.Exists) { continue }
        $langFiles.Add(@($code, $file.FullName))
        $lines.Add("lang/$code|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
    }
    if ($langFiles.Count -eq 0) { throw (L 'build.missingLang' @{ dir = $langDir }) }
    # SimpLLM の版 (src\version.txt の 1 行。版の番号はここにだけ書く)。設定画面の「情報」に出す
    $versionFile = [IO.FileInfo]::new(([IO.Path]::Combine([IO.Path]::GetDirectoryName($ui), 'version.txt')))
    if (-not $versionFile.Exists) { throw (L 'build.missingFile' @{ name = 'version.txt' }) }
    $lines.Add("version|$($versionFile.Length)|$($versionFile.LastWriteTimeUtc.Ticks)")
    $builder = [IO.FileInfo]::new($PSCommandPath)
    $lines.Add("builder=$($builder.Length)|$($builder.LastWriteTimeUtc.Ticks)")
    $signature = $lines -join "`n"
    # 記録するのは入力ファイルの構成と、生成した HTML の大きさ・更新時刻 (生成物が書き換えられたら作り直す)
    $stampFor = { param($out) "$signature`noutput=$($out.Length)|$($out.LastWriteTimeUtc.Ticks)" }
    if (-not $Force) {
        try {
            $output = [IO.FileInfo]::new($index)
            if ($output.Exists -and [IO.File]::Exists($stamp) -and [IO.File]::ReadAllText($stamp, $utf8) -ceq (& $stampFor $output)) {
                return [pscustomobject]@{ rebuilt = $false; path = $index }
            }
        } catch { } # 壊れたキャッシュは再生成する
    }
    # 改行は LF にそろえてから埋め込む。ブラウザは HTML の CRLF を LF に直してからハッシュを計算するので、
    # CRLF のまま埋め込むと CSP のハッシュが合わず、スクリプトもスタイルも適用されない
    # (Git の設定によっては、取得したファイルの改行が CRLF になる)
    $readText = { param($name) [IO.File]::ReadAllText(([IO.Path]::Combine($ui, $name)), $utf8).Replace("`r`n", "`n").Replace("`r", "`n") }
    $template = & $readText 'index.html'
    # セマンティックバージョニングの形 (1.2.3、1.2.3-beta.1 など) だけを受け付ける。HTML に入れるので、記号の混入もここで防ぐ
    $version = [IO.File]::ReadAllText($versionFile.FullName, $utf8).Trim()
    if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$') { throw (L 'build.badVersion' @{ text = $version }) }
    $css = & $readText 'style.css'
    $js = ($jsFiles | ForEach-Object { & $readText $_ }) -join "`n;`n"
    if ($js -match '(?i)</script|<script|<!--' -or $css -match '(?i)</style') { throw (L 'build.unsafeSource') }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $scriptHash = 'sha256-' + [Convert]::ToBase64String($sha.ComputeHash($utf8.GetBytes($js)))
        $styleHash = 'sha256-' + [Convert]::ToBase64String($sha.ComputeHash($utf8.GetBytes($css)))
    } finally { $sha.Dispose() }
    $html = $template.Replace('{{SCRIPT_HASH}}', $scriptHash).Replace('{{STYLE_HASH}}', $styleHash).Replace('{{CONTROL_PORT}}', "$controlPort").Replace('{{VERSION}}', $version)
    # 画像を先に入れ、JS/CSS は最後に入れる (ソース中の {{LOGO}} などを置き換えてハッシュを壊さない)
    $html = $html.Replace('{{WORDMARK}}', [IO.File]::ReadAllText(([IO.Path]::Combine($ui, 'wordmark.svg')), $utf8))
    foreach ($image in @(@('LOGO', 'logo.webp'), @('FAVICON16', 'favicon-16.png'), @('FAVICON32', 'favicon-32.png'))) {
        $html = $html.Replace('{{' + $image[0] + '}}', [Convert]::ToBase64String([IO.File]::ReadAllBytes([IO.Path]::Combine($ui, $image[1]))))
    }
    # 文言は実行されないデータとして埋め込む (type="application/json")。"<" は \u003c にして、HTML のタグとして読まれないようにする
    $lang = [Text.StringBuilder]::new()
    foreach ($entry in $langFiles) {
        $json = [IO.File]::ReadAllText($entry[1], $utf8).Replace("`r`n", "`n").Trim().Replace('<', '\u003c')
        [void]$lang.Append('<script type="application/json" id="lang-').Append($entry[0]).Append('">').Append($json).Append("</script>`n")
    }
    $html = $html.Replace('{{LANG}}', $lang.ToString().TrimEnd())
    $html = $html.Replace('{{STYLE}}', $css).Replace('{{SCRIPT}}', $js)
    New-Item -ItemType Directory -Force $public | Out-Null
    if (-not (Test-Path -LiteralPath $index) -or [IO.File]::ReadAllText($index, $utf8) -cne $html) { [IO.File]::WriteAllText($index, $html, $utf8) }
    $data = & $stampFor ([IO.FileInfo]::new($index))
    # キャッシュが置けなくても実行できる。壊れた場合も次回再生成するだけ。
    try {
        New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($stamp)) | Out-Null
        [IO.File]::WriteAllText("$stamp.tmp", $data, $utf8)
        Move-Item -LiteralPath "$stamp.tmp" -Destination $stamp -Force -ErrorAction Stop
    } catch { }
    return [pscustomobject]@{ rebuilt = $true; path = $index }
}
