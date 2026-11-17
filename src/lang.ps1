# 起動スクリプト側の文言
#   文言は src\lang\<言語>.launcher.json にある (画面の文言は src\lang\<言語>.json)。ここには日本語などの文言を書かない
#   L 'キー' @{ 名前 = 値 } で取り出す。文言の中の {名前} が値に置き換わるので、語順は言語ごとに変えてよい
#   選んだ言語に無いキーは日本語の文言を使う
# 読み込まれるのは、最初に文言を使うとき: start.ps1 は L と Set-Language の「読み込んでから呼び直す」だけの関数を持ち、
#   ふだんの起動 (文言を 1 つも使わない) ではこのファイルも言語のファイルも読まない (読み込むと起動が 約 25ms 遅くなる。実測)。
#   その関数の中から読み込まれるので、関数はすべて script: を付けて定義する (付けないと、読み込んだ関数の中だけの定義になって消える)
# ほかのスクリプトを単体で読み込んだとき (テスト) は、それぞれが先頭でこのファイルを読み込む

$script:langDir = Join-Path $PSScriptRoot 'lang'
$script:langCodes = @('ja', 'en', 'zh-CN', 'zh-TW', 'ko', 'de') # src\ui\i18n.js の NAMES と同じ並び
$script:langFallback = 'ja'
$script:langTables = @{}

# Windows やブラウザの言語の書き方 (ja-JP, zh-Hant-TW など) を、対応する言語の名前にそろえる。対応していなければ空
# (src\ui\i18n.js の normalize と同じ決め方。画面と起動スクリプトで同じ言語になるようにする)
function script:ConvertTo-LanguageCode([string]$name) {
    $n = $name.Trim().Replace('_', '-').ToLowerInvariant()
    if (-not $n) { return '' }
    $short = $n.Split('-')[0]
    if ($short -ceq 'zh') { if ($n -notmatch 'hans' -and $n -match 'hant|-tw|-hk|-mo') { return 'zh-TW' } else { return 'zh-CN' } } # 文字の指定 (Hans / Hant) が地域より優先
    foreach ($code in $script:langCodes) { if ($code -ieq $short) { return $code } }
    return ''
}

# 文言を用意してある言語か (画面用と起動スクリプト用の両方のファイルがある)
function script:Test-LanguageAvailable([string]$code) {
    return ($script:langCodes -ccontains $code) -and [IO.File]::Exists((Join-Path $script:langDir "$code.json")) -and [IO.File]::Exists((Join-Path $script:langDir "$code.launcher.json"))
}

# 使う言語を決める: 候補 (設定画面で選んだもの、Windows の表示言語の順) のうち最初に文言のあるもの → 英語 → 日本語
function script:Resolve-Language($hints) {
    foreach ($hint in @($hints) + 'en') {
        $code = ConvertTo-LanguageCode ([string]$hint)
        if ($code -and (Test-LanguageAvailable $code)) { return $code }
    }
    return $script:langFallback
}

# 言語のファイルを読む。"キー": "文言" を 1 行ずつ並べた JSON なので、正規表現で読む
# (ConvertFrom-Json は最初の 1 回が重い (実測 約 55ms)。エラーの知らせ 1 つのために読み込ませない)
function script:Read-LangTable([string]$code) {
    $table = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    try { $text = [IO.File]::ReadAllText((Join-Path $script:langDir "$code.launcher.json"), [Text.Encoding]::UTF8) } catch { return $table }
    foreach ($m in [regex]::Matches($text, '(?m)^\s*"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$')) {
        $value = $m.Groups[2].Value
        if ($value.IndexOf('\') -ge 0) { $value = [regex]::Unescape($value) } # \n, \", \\, \uXXXX
        $table[$m.Groups[1].Value] = $value
    }
    return $table
}

function script:Get-LangTable([string]$code) {
    $table = $script:langTables[$code]
    if ($null -eq $table) { $table = Read-LangTable $code; $script:langTables[$code] = $table }
    return $table
}

# 文言を取り出す。キーが無ければキーをそのまま返す (文言の入れ忘れに気付けるように)
function script:L([string]$key, $vars = $null) {
    $text = $null
    if (-not (Get-LangTable $script:language).TryGetValue($key, [ref]$text) -and $script:language -cne $script:langFallback) {
        [void](Get-LangTable $script:langFallback).TryGetValue($key, [ref]$text)
    }
    if ($null -eq $text) { return $key }
    if ($null -eq $vars -or $text.IndexOf('{') -lt 0) { return $text }
    # 1 回で置き換える (値の中に {名前} の形があっても、もう一度は置き換えない)
    $out = [System.Text.StringBuilder]::new()
    $at = 0
    foreach ($m in [regex]::Matches($text, '\{(\w+)\}')) {
        [void]$out.Append($text, $at, $m.Index - $at)
        $name = $m.Groups[1].Value
        if ($vars.Contains($name)) { [void]$out.Append([string]$vars[$name]) } else { [void]$out.Append($m.Value) }
        $at = $m.Index + $m.Length
    }
    return $out.Append($text, $at, $text.Length - $at).ToString()
}

# "@キー" の形の文字列を、そのキーの文言にする (同梱のモデルの設定のメモ)。キーが無ければそのまま
function script:Resolve-LangRef([string]$text) {
    if (-not $text.StartsWith('@')) { return $text }
    $key = $text.Substring(1)
    $found = L $key
    if ($found -ceq $key) { return $text }
    return $found
}

# 設定画面で選んだ言語に切り替える。$savePath があれば、次回の起動のために書いておく。対応していない言語は例外
function script:Set-Language([string]$code, [string]$savePath = '') {
    if (-not $code -or (ConvertTo-LanguageCode $code) -cne $code -or -not (Test-LanguageAvailable $code)) { throw (L 'lang.unsupported') }
    $script:language = $code
    if ($savePath) { [IO.File]::WriteAllText($savePath, $code, [System.Text.UTF8Encoding]::new($false)) }
}

# いまの言語。start.ps1 が候補 ($script:languageHint) を渡す。単体で読み込んだとき (テスト) は日本語
if (-not $script:language) { $script:language = if ($script:languageHint) { Resolve-Language $script:languageHint } else { $script:langFallback } }
