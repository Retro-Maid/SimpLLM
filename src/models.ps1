# モデルの一覧 (start.ps1 から読み込む)
# 利用者はモデルを決まったフォルダに置くだけでよい。種類はファイル名ではなく、ファイルの先頭 (GGUF のメタデータと
# 重みの名前、safetensors の目録) を読んで判定する。読むのは先頭だけなので、数 GB のファイルでも数ミリ秒で済む。
#   <モデルのフォルダ>\*.gguf, <モデルのフォルダ>\chat\*.gguf    → チャット用 (GGUF が自分の情報を持つので、そのまま動く)
#   <モデルのフォルダ>\image\<名前>\                              → 画像用。1 モデル 1 フォルダ (本体・テキストエンコーダ・VAE)
# 画像用は sd-cli に渡す設定が系統ごとに違うので、系統ごとの推奨設定を model-catalog.json (同梱) に持つ。
# 利用者は <モデルのフォルダ>\models.json で表示名や設定を足せる (なくてよい)。

if (-not $function:L) { . (Join-Path $PSScriptRoot 'lang.ps1') } # 文言 (L 'キー')。start.ps1 から読み込んだときは読み込み済み
# テストや検証では、本物のカタログを書き換えないよう SIMPLLM_CATALOG で別のファイルを指定する
$script:catalogPath = if ($env:SIMPLLM_CATALOG) { $env:SIMPLLM_CATALOG } else { Join-Path $PSScriptRoot "model-catalog.json" }
# 画面で直した設定と自動作成した項目は、同梱のカタログとは別のファイルに書く (新しい版を上書きコピーしても消えない)。
# SIMPLLM_CATALOG だけを指定したとき (テスト) は、そのファイル 1 つを読み書きする
$script:userCatalogPath = if ($env:SIMPLLM_USER_CATALOG) { $env:SIMPLLM_USER_CATALOG } elseif ($env:SIMPLLM_CATALOG) { $script:catalogPath } else { Join-Path (Split-Path $PSScriptRoot -Parent) ".run\model-settings.json" }
$script:partialExtensions = @(".part", ".crdownload", ".incomplete", ".download", ".partial", ".tmp")
$script:headerCache = @{}

$modelHeaderSource = @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

// ファイルの先頭だけを読む。大きな配列 (トークナイザの語彙など) は読まずに飛ばす
public sealed class SimpllmHeader {
    public string Format = "";
    public string Error = "";
    public bool Complete = true;
    public Dictionary<string, string> Meta = new Dictionary<string, string>();
    public HashSet<string> Prefixes = new HashSet<string>();

    static readonly int[] Sizes = { 1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8 };

    public static SimpllmHeader Read(string path) {
        var h = new SimpllmHeader();
        try {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16)) {
                var r = new BinaryReader(fs);
                if (fs.Length < 16) { h.Error = "too small"; return h; }
                uint magic = r.ReadUInt32();
                if (magic == 0x46554747) { h.Format = "gguf"; ReadGguf(h, r, fs); }
                else if (path.EndsWith(".safetensors", StringComparison.OrdinalIgnoreCase)) { fs.Position = 0; h.Format = "safetensors"; ReadSafetensors(h, r, fs); }
                else h.Error = "unknown format";
            }
        } catch (Exception e) { h.Error = e.GetType().Name; h.Complete = false; }
        return h;
    }

    static string Str(BinaryReader r) {
        ulong n = r.ReadUInt64();
        if (n > 64 * 1024 * 1024) throw new InvalidDataException("string too long");
        return Encoding.UTF8.GetString(r.ReadBytes((int)n));
    }

    // 短い読み飛ばしはバッファから読み捨てる (Seek は毎回OSを呼び、語彙数十万件の読み飛ばしが遅い)
    static void SkipBytes(FileStream fs, byte[] scratch, long n) {
        if (n > scratch.Length || n < 0) { fs.Seek(n, SeekOrigin.Current); return; }
        int left = (int)n;
        while (left > 0) { int got = fs.Read(scratch, 0, left); if (got <= 0) throw new EndOfStreamException(); left -= got; }
    }

    static void Skip(BinaryReader r, FileStream fs, byte[] s, uint type) {
        if (type == 8) { ulong n = r.ReadUInt64(); SkipBytes(fs, s, (long)n); return; }
        if (type == 9) {
            uint at = r.ReadUInt32(); ulong count = r.ReadUInt64();
            if (at == 8 || at == 9) { for (ulong i = 0; i < count; i++) Skip(r, fs, s, at); }
            else fs.Seek((long)count * Sizes[at], SeekOrigin.Current);
            return;
        }
        SkipBytes(fs, s, Sizes[type]);
    }

    static string Scalar(BinaryReader r, uint t) {
        switch (t) {
            case 0: return r.ReadByte().ToString();
            case 1: return r.ReadSByte().ToString();
            case 2: return r.ReadUInt16().ToString();
            case 3: return r.ReadInt16().ToString();
            case 4: return r.ReadUInt32().ToString();
            case 5: return r.ReadInt32().ToString();
            case 6: return r.ReadSingle().ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            case 7: return r.ReadByte() != 0 ? "true" : "false";
            case 8: return Str(r);
            case 10: return r.ReadUInt64().ToString();
            case 11: return r.ReadInt64().ToString();
            case 12: return r.ReadDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new InvalidDataException("type");
    }

    static void ReadGguf(SimpllmHeader h, BinaryReader r, FileStream fs) {
        uint version = r.ReadUInt32();
        if (version < 2) { h.Error = "old gguf"; return; }
        ulong tensors = r.ReadUInt64(), kvs = r.ReadUInt64();
        byte[] s = new byte[4096];
        for (ulong i = 0; i < kvs; i++) {
            string key = Str(r);
            uint t = r.ReadUInt32();
            if (t == 9 || (t == 8 && key.StartsWith("tokenizer."))) { if (key == "tokenizer.chat_template") h.Meta[key] = "yes"; Skip(r, fs, s, t); continue; }
            string v = Scalar(r, t);
            if (v.Length <= 200) h.Meta[key] = v;
        }
        ulong maxOffset = 0;
        for (ulong i = 0; i < tensors; i++) {
            string name = Str(r);
            uint dims = r.ReadUInt32();
            SkipBytes(fs, s, 8L * dims + 4);
            ulong offset = r.ReadUInt64();
            if (offset > maxOffset) maxOffset = offset;
            AddPrefix(h, name);
        }
        long align = 32;
        string a;
        if (h.Meta.TryGetValue("general.alignment", out a)) long.TryParse(a, out align);
        if (align <= 0) align = 32;
        long dataStart = (fs.Position + align - 1) / align * align;
        // 最後の重みの始まりより短ければ、ダウンロードの途中で止まっている (同じ大きさを先に確保するダウンロードは見分けられない)
        h.Complete = fs.Length > dataStart + (long)maxOffset;
    }

    static readonly Regex Entry = new Regex("\"((?:[^\"\\\\]|\\\\.)+)\"\\s*:\\s*\\{([^{}]*)\\}", RegexOptions.Compiled);
    static readonly Regex Offsets = new Regex("\"data_offsets\"\\s*:\\s*\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]", RegexOptions.Compiled);
    static readonly Regex Pair = new Regex("\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", RegexOptions.Compiled);

    static void ReadSafetensors(SimpllmHeader h, BinaryReader r, FileStream fs) {
        ulong n = r.ReadUInt64();
        if (n == 0 || n > 100 * 1024 * 1024 || (long)n + 8 > fs.Length) { h.Error = "bad header"; h.Complete = false; return; }
        string json = Encoding.UTF8.GetString(r.ReadBytes((int)n));
        ulong maxEnd = 0;
        foreach (Match m in Entry.Matches(json)) {
            string key = m.Groups[1].Value;
            if (key == "__metadata__") {
                foreach (Match p in Pair.Matches(m.Groups[2].Value)) if (p.Groups[2].Value.Length <= 200) h.Meta[p.Groups[1].Value] = p.Groups[2].Value;
                continue;
            }
            Match o = Offsets.Match(m.Groups[2].Value);
            if (o.Success) { ulong end = ulong.Parse(o.Groups[2].Value); if (end > maxEnd) maxEnd = end; }
            AddPrefix(h, key);
        }
        h.Complete = fs.Length >= 8 + (long)n + (long)maxEnd;
    }

    static void AddPrefix(SimpllmHeader h, string name) {
        int first = name.IndexOf('.');
        int second = first < 0 ? -1 : name.IndexOf('.', first + 1);
        h.Prefixes.Add(second < 0 ? name : name.Substring(0, second));
    }

    public bool HasPrefix(string start) {
        foreach (string p in Prefixes) if (p.StartsWith(start, StringComparison.Ordinal)) return true;
        return false;
    }
    public string Get(string key) { string v; return Meta.TryGetValue(key, out v) ? v : ""; }
}
"@
if (Get-Command Import-CSharp -ErrorAction SilentlyContinue) { Import-CSharp "SimpllmHeader" $modelHeaderSource } elseif (-not ("SimpllmHeader" -as [type])) { Add-Type -TypeDefinition $modelHeaderSource }

# 大きさと更新時刻が同じなら、前に読んだ結果を使う
function Get-ModelHeader([IO.FileInfo]$file) {
    $cached = $script:headerCache[$file.FullName]
    if ($null -eq $cached -or $cached.bytes -ne $file.Length -or $cached.ticks -ne $file.LastWriteTimeUtc.Ticks) {
        $cached = @{ bytes = $file.Length; ticks = $file.LastWriteTimeUtc.Ticks; header = [SimpllmHeader]::Read($file.FullName) }
        $script:headerCache[$file.FullName] = $cached # ダウンロード中の旧版を何世代もためない
    }
    return $cached.header
}

function Test-PartialDownload([IO.FileInfo]$file) {
    if ($script:partialExtensions -contains $file.Extension.ToLowerInvariant()) { return $true }
    # モデルの数だけ呼ばれるので Test-Path を使わない (1 回 約 0.45ms → 約 0.16ms。実測)
    return [IO.File]::Exists("$($file.FullName).aria2") -or [IO.File]::Exists("$($file.FullName).part")
}

# ファイルの役割: diffusion:<系統> / checkpoint / text:<種類> / vae:<種類> / chat / mmproj / unknown
# 系統を知らない本体でも、GGUF のアーキテクチャ名を系統名として扱う (自動テンプレートの対象にするため)
function Get-ComponentKind([IO.FileInfo]$file) {
    $h = Get-ModelHeader $file
    if ($h.Error) { return "unknown" }
    if ($h.Format -eq "gguf") {
        $arch = $h.Get("general.architecture")
        if ($arch -eq "qwen_image21") { return "diffusion:qwen-image-2.1" }
        if ($arch -eq "flux") { if ($h.HasPrefix("distilled_guidance_layer")) { return "diffusion:chroma" } else { return "diffusion:flux1" } }
        if ($arch -eq "t5encoder") { return "text:t5" }
        if ($arch -eq "clip" -or $h.Get("general.type") -eq "mmproj") { return "mmproj" }
        if ($h.HasPrefix("model.diffusion_model")) { return "checkpoint" }
        if ($h.HasPrefix("token_embd") -or $h.HasPrefix("blk.")) { if ($arch) { return "chat" } else { return "unknown" } } # 言語モデル (画像用のフォルダではテキストエンコーダ)
        if ($arch) { return "diffusion:" + ($arch.ToLowerInvariant() -replace '[^a-z0-9.-]', '-') }
        return "unknown"
    }
    if ($h.HasPrefix("model.visual") -and $h.HasPrefix("model.layers")) { return "text:qwen3vl" }
    if ($h.Get("modelspec.architecture") -eq "qwen_image_2.1_vae" -or $h.HasPrefix("decoder.upsamples")) { return "vae:qwen-image-2.1" }
    if ($h.HasPrefix("decoder.up_blocks") -and $h.HasPrefix("decoder.mid_block")) { return "vae:flux1" }
    if ($h.HasPrefix("model.diffusion_model")) { return "checkpoint" }
    if ($h.HasPrefix("model.layers") -or $h.HasPrefix("model.embed_tokens")) { return "text:llm" }
    if ($h.HasPrefix("encoder.block") -or $h.HasPrefix("shared.weight")) { return "text:t5" }
    if ($h.HasPrefix("text_model.")) { return "text:clip" }
    if ($h.HasPrefix("decoder.conv_in") -or $h.HasPrefix("first_stage_model")) { return "vae:other" }
    if ($h.HasPrefix("double_blocks")) { if ($h.HasPrefix("distilled_guidance_layer")) { return "diffusion:chroma" } else { return "diffusion:flux1" } }
    if ($h.HasPrefix("transformer_blocks") -or $h.HasPrefix("blocks.") -or $h.HasPrefix("layers.") -or $h.HasPrefix("joint_blocks")) { return "diffusion:safetensors" }
    return "unknown"
}

# 種類の名前は文言のファイルにある (kind.<種類>)。文言にするのは使うときで、読み込み時には言語のファイルを読まない
$script:kindNames = @("diffusion:chroma", "diffusion:qwen-image-2.1", "diffusion:flux1", "checkpoint", "text:t5", "text:qwen3vl", "text:llm", "text:clip", "vae:flux1", "vae:qwen-image-2.1", "vae:other")
function Get-KindLabel([string]$kind) {
    if ($script:kindNames -ccontains $kind) { return (L "kind.$kind") }
    if ($kind -like "diffusion:*") { return (L 'kind.diffusion' @{ name = $kind.Substring(10) }) }
    return $kind
}

# --- 設定できる項目 (画面と受付で同じ定義を使う) ----------------------------------------
# sd-cli の引数のうち、生成の結果に関わるものだけ。出力先や読み込むファイルを変える項目 (-o, --lora-model-dir,
# --prompt-file, --tokenizer など) は、ここに無いので定義からも画面からも指定できない
$script:samplers = @("euler", "euler_a", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2", "ipndm", "ipndm_v", "lcm", "ddim_trailing", "tcd", "res_multistep", "res_2s", "er_sde", "euler_cfg_pp", "euler_a_cfg_pp", "euler_ge", "dpm++2m_sde", "dpm++2m_sde_bt", "lms")
$script:schedulers = @("discrete", "karras", "exponential", "ays", "gits", "sgm_uniform", "simple", "smoothstep", "kl_optimal", "lcm", "bong_tangent", "ltx2", "logit_normal", "flux2", "flux", "beta", "llada_image")
# 名前 (label) と説明 (help) は文言のファイルにある (param.<項目>.label / .help)。画面に送るときと、エラーにするときに文言にする
$script:paramSpec = @(
    [ordered]@{ name = "steps"; type = "int"; min = 1; max = 150 }
    [ordered]@{ name = "cfg-scale"; type = "float"; min = 0; max = 30 }
    [ordered]@{ name = "guidance"; type = "float"; min = 0; max = 30 }
    [ordered]@{ name = "img-cfg-scale"; type = "float"; min = 0; max = 30 }
    [ordered]@{ name = "sampling-method"; type = "choice"; options = $script:samplers }
    [ordered]@{ name = "scheduler"; type = "choice"; options = $script:schedulers }
    [ordered]@{ name = "flow-shift"; type = "float"; min = 0; max = 20 }
    [ordered]@{ name = "clip-skip"; type = "int"; min = 1; max = 12 }
    [ordered]@{ name = "eta"; type = "float"; min = 0; max = 2 }
    [ordered]@{ name = "slg-scale"; type = "float"; min = 0; max = 10 }
    [ordered]@{ name = "timestep-shift"; type = "int"; min = 0; max = 1000 }
    [ordered]@{ name = "prediction"; type = "choice"; options = @("eps", "v", "edm_v", "sd3_flow", "flux_flow", "sefi_flow", "minit2i_flow", "sensenova_u1_flow", "flux3_flow", "h3_av_flow", "ming_image_flow") }
    [ordered]@{ name = "rng"; type = "choice"; options = @("std_default", "cuda", "cpu") }
    [ordered]@{ name = "flash-attn"; type = "choice"; options = @("auto", "on", "off") }
    [ordered]@{ name = "model-args"; type = "text"; pattern = '^((chroma_use_dit_mask|chroma_use_t5_mask|chroma_t5_mask_pad|qwen_image_zero_cond_t|qwen_image_2_1_prefix_cache|qwen_image_2_1_prefix_cache_type)=[A-Za-z0-9_]{1,16},?)+$' }
    [ordered]@{ name = "vae-tiling"; type = "flag" }
)
# 名前から項目を引く表 (大文字小文字を区別しない)。検証のたびにパイプラインで探さない
$script:paramByName = @{}
foreach ($spec in $script:paramSpec) { $script:paramByName[$spec.name] = $spec }
function Get-ParamLabel($spec) { return (L "param.$($spec.name).label") }
# 画面に送る形 (名前と説明を、いまの表示言語の文言にして足す)
function Get-ParamSpecView {
    foreach ($spec in $script:paramSpec) {
        $view = [ordered]@{}
        foreach ($key in $spec.Keys) { $view[$key] = $spec[$key] }
        $view.label = Get-ParamLabel $spec
        $view.help = L "param.$($spec.name).help"
        $view
    }
}
# 役割と sd-cli の引数の対応 (コードだけで決める)。本体は --diffusion-model、一体型は -m
$script:roleFlags = [ordered]@{ t5xxl = "--t5xxl"; llm = "--llm"; clip_l = "--clip_l"; clip_g = "--clip_g"; vae = "--vae" }

# 項目名 → 値 を検証して、sd-cli の引数の並びにする。問題があれば例外
function ConvertTo-ImageParamArgs($params) {
    $list = @()
    $given = @{}
    if ($null -ne $params) { foreach ($p in @($params.PSObject.Properties)) { $given[$p.Name] = $p.Value } }
    foreach ($name in $given.Keys) { if (-not $script:paramByName.ContainsKey($name)) { throw (L 'param.unknown' @{ name = $name }) } }
    foreach ($s in $script:paramSpec) {
        if (-not $given.ContainsKey($s.name)) { continue }
        $v = $given[$s.name]
        if ($null -eq $v -or "$v" -eq "") { continue }
        switch ($s.type) {
            "int" { $n = 0; if (-not [int]::TryParse("$v", [ref]$n) -or $n -lt $s.min -or $n -gt $s.max) { throw (L 'param.needInt' @{ label = (Get-ParamLabel $s); min = $s.min; max = $s.max }) }; $list += @("--$($s.name)", "$n") }
            "float" {
                $f = 0.0
                if (-not [double]::TryParse("$v", [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$f) -or $f -lt $s.min -or $f -gt $s.max) { throw (L 'param.needNumber' @{ label = (Get-ParamLabel $s); min = $s.min; max = $s.max }) }
                $list += @("--$($s.name)", $f.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture))
            }
            "choice" { if ($s.options -cnotcontains "$v") { throw (L 'param.badValue' @{ label = (Get-ParamLabel $s) }) }; $list += @("--$($s.name)", "$v") }
            "text" { if ("$v" -cnotmatch $s.pattern) { throw (L 'param.badValue' @{ label = (Get-ParamLabel $s) }) }; $list += @("--$($s.name)", "$v") }
            "flag" { if ($v -eq $true -or "$v" -eq "true") { $list += @("--$($s.name)") } elseif ($v -ne $false -and "$v" -ne "false") { throw (L 'param.badValue' @{ label = (Get-ParamLabel $s) }) } }
        }
    }
    return , $list
}

# 以前の形 (args: ["--steps", "8", ...]) を項目名 → 値 に直す
function ConvertFrom-LegacyArgs($list) {
    $params = [ordered]@{}
    $items = @($list)
    for ($i = 0; $i -lt $items.Count; $i++) {
        $flag = [string]$items[$i]
        if ($flag -notlike "--*") { throw (L 'catalog.badArg' @{ flag = $flag }) }
        $s = $script:paramByName[$flag.Substring(2)]
        if ($null -eq $s) { throw (L 'catalog.badArg' @{ flag = $flag }) }
        if ($s.type -eq "flag") { $params[$s.name] = $true } else { $i++; $params[$s.name] = [string]$items[$i] }
    }
    return [pscustomobject]$params
}

function Test-CatalogEntry($e) {
    if (-not $e.id -or [string]$e.id -notmatch '^[A-Za-z0-9._-]{1,64}$') { return (L 'catalog.badId') }
    if ([string]$e.diffusion -notmatch '^(checkpoint|[a-z0-9.-]{1,40})$') { return (L 'catalog.badDiffusion') }
    if ($e.folder -and [string]$e.folder -match '[\\/:*?"<>|]') { return (L 'catalog.badFolder') }
    foreach ($m in @($e.modes)) { if ($m -ne "generate" -and $m -ne "edit") { return (L 'catalog.badModes') } }
    if (@($e.modes).Count -eq 0) { return (L 'catalog.needMode') }
    if ($null -ne $e.files) {
        foreach ($p in @($e.files.PSObject.Properties)) {
            if (-not $script:roleFlags.Contains($p.Name)) { return (L 'catalog.badRole' @{ name = $p.Name }) }
            if ([string]$p.Value -notmatch '^(text|vae):[a-z0-9.-]{1,32}$') { return (L 'catalog.badFiles') }
        }
    }
    try { [void](ConvertTo-ImageParamArgs $e.params) } catch { return $_.Exception.Message }
    if ($null -ne $e.editSteps) {
        $steps = 0
        if (-not [int]::TryParse([string]$e.editSteps, [ref]$steps) -or $steps -lt 1 -or $steps -gt 150) { return (L 'catalog.badEditSteps') }
    }
    if ($e.negative -and ([string]$e.negative).Length -gt 1000) { return (L 'catalog.negativeTooLong') }
    if ($e.label -and ([string]$e.label).Length -gt 80) { return (L 'catalog.labelTooLong') }
    if ($e.note -and ([string]$e.note).Length -gt 80) { return (L 'catalog.noteTooLong') }
    return ""
}

$script:chatSamplingKeys = @("temperature", "top_p", "top_k", "min_p", "presence_penalty", "repeat_penalty")
function Test-ChatEntry($c) {
    if (-not $c.file -or [string]$c.file -match '[\\/:"<>|]' -or ([string]$c.file).Length -gt 200) { return (L 'catalog.badFile') }
    if ($c.label -and ([string]$c.label).Length -gt 80) { return (L 'catalog.labelTooLong') }
    if ($null -ne $c.sampling) {
        foreach ($p in @($c.sampling.PSObject.Properties)) {
            if ($script:chatSamplingKeys -notcontains $p.Name) { return (L 'param.unknown' @{ name = $p.Name }) }
            $f = 0.0
            if ("$($p.Value)" -ne "" -and -not [double]::TryParse("$($p.Value)", [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$f)) { return (L 'param.needNumberPlain' @{ name = $p.Name }) }
        }
    }
    return ""
}

# --- カタログの読み書き -------------------------------------------------------------
# 優先する順に 3 つ: 利用者の <モデルのフォルダ>\models.json (読むだけ)、.run\model-settings.json (画面で直したもの + 自動作成。
# 書くのはここだけ)、model-catalog.json (同梱。読むだけ)。同じ id / file は先に読んだものを使う
# 壊れていても起動は止めず、問題として一覧に出す
function Read-CatalogFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Get-ModelCatalog {
    $sources = @(@{ path = (Join-Path $script:modelDir "models.json"); origin = "models.json" }, @{ path = $script:userCatalogPath; origin = "user" })
    if ($script:catalogPath -ne $script:userCatalogPath) { $sources += @{ path = $script:catalogPath; origin = "catalog" } }
    $stamp = [Text.StringBuilder]::new([string]$script:language)
    foreach ($source in $sources) {
        $f = [IO.FileInfo]::new($source.path)
        [void]$stamp.Append('|').Append($source.path).Append(':').Append($f.Exists).Append(':').Append($f.Length).Append(':').Append($f.LastWriteTimeUtc.Ticks)
    }
    $signature = $stamp.ToString()
    if ($null -ne $script:modelCatalogCache -and $script:modelCatalogSignature -ceq $signature) { return $script:modelCatalogCache }
    $problems = @()
    $image = @(); $chat = @()
    $imageIds = @{}; $chatFiles = @{}
    foreach ($source in $sources) {
        try { $data = Read-CatalogFile $source.path } catch { $problems += (L 'catalog.unreadable' @{ path = $source.path }); continue }
        if ($null -eq $data) { continue }
        foreach ($e in @($data.image)) {
            if ($null -eq $e) { continue }
            if ($e.id -and $imageIds.ContainsKey([string]$e.id)) { continue } # 画面で直したものが、同梱の同じ項目に優先する
            if ($null -eq $e.params -and $null -ne $e.args) {
                try { $e | Add-Member -NotePropertyName params -NotePropertyValue (ConvertFrom-LegacyArgs $e.args) -Force } catch { $problems += "$($source.path): $($e.id) — $($_.Exception.Message)"; continue }
            }
            $why = Test-CatalogEntry $e
            if ($why) { $problems += "$($source.path): $($e.id) — $why"; continue }
            $e | Add-Member -NotePropertyName origin -NotePropertyValue $source.origin -Force
            # メモは表示言語の文言にする: 自動作成の項目はいつも同じ文言、同梱の設定は "@キー" の形で書いてある
            # 元の "@キー" は noteRef に残す: 画面で設定を直して保存するとき、メモを書き換えていなければ "@キー" のまま保存して、
            # 言語を変えたらメモも変わるようにする (文言で保存すると、保存したときの言語のまま残る)
            $noteRef = if ($e.source -eq 'auto') { '@note.auto' } elseif ([string]$e.note -like '@*') { [string]$e.note } else { '' }
            $e | Add-Member -NotePropertyName noteRef -NotePropertyValue $noteRef -Force
            if ($noteRef) { $e | Add-Member -NotePropertyName note -NotePropertyValue (Resolve-LangRef $noteRef) -Force }
            $imageIds[[string]$e.id] = $true
            $image += $e
        }
        foreach ($c in @($data.chat)) {
            if ($null -eq $c) { continue }
            if ($c.file -and $chatFiles.ContainsKey([string]$c.file)) { continue }
            $why = Test-ChatEntry $c
            if ($why) { $problems += "$($source.path): $($c.file) — $why"; continue }
            $c | Add-Member -NotePropertyName origin -NotePropertyValue $source.origin -Force
            $chatFiles[[string]$c.file] = $true
            $chat += $c
        }
    }
    $script:modelCatalogSignature = $signature
    $script:modelCatalogCache = @{ image = $image; chat = $chat; problems = $problems }
    return $script:modelCatalogCache
}

# 書き換えは別のファイルに書いてから置き換える (途中で止まっても、壊れたカタログを残さない)。
# 置き換える前にディスクまで書き切る (停電などで、置き換え後のファイルが空や 0 埋めにならないように)
function Save-CatalogFile($data) {
    $script:modelCatalogCache = $null
    $script:modelInventoryCache = $null
    $json = $data | ConvertTo-Json -Depth 10
    $target = $script:userCatalogPath
    [void][IO.Directory]::CreateDirectory((Split-Path $target -Parent))
    $temp = "$target.tmp"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream = [IO.FileStream]::new($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    # 控えは作らない。PowerShell 5.1 で $null を渡すと空文字になって失敗するので [NullString]::Value を使う
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temp, $target, [NullString]::Value) } else { [IO.File]::Move($temp, $target) }
}

# 書き換える対象 (画面で直した設定のファイル) の中身。同梱のカタログは書き換えない
function Get-CatalogData {
    $data = $null
    try { $data = Read-CatalogFile $script:userCatalogPath } catch { throw (L 'catalog.broken' @{ path = $script:userCatalogPath }) }
    if ($null -eq $data) { $data = [pscustomobject]@{} }
    foreach ($key in "image", "chat") { if ($null -eq $data.$key) { $data | Add-Member -NotePropertyName $key -NotePropertyValue @() -Force } }
    return $data
}

# 自動作成した項目を足す (すでにある id は触らない)。足したものがあるときだけ書く
function Add-CatalogEntries($images, $chats) {
    if (-not $images.Count -and -not $chats.Count) { return }
    try { $data = Get-CatalogData } catch { return }
    $imageIds = @($data.image | ForEach-Object { $_.id }); $chatFiles = @($data.chat | ForEach-Object { $_.file })
    $newImages = @($images | Where-Object { $imageIds -notcontains $_.id }); $newChats = @($chats | Where-Object { $chatFiles -notcontains $_.file })
    if (-not $newImages.Count -and -not $newChats.Count) { return }
    $data.image = @($data.image) + $newImages
    $data.chat = @($data.chat) + $newChats
    try { Save-CatalogFile $data } catch { }
}

# 画面から: 保存 (同じ id / file を置き換える) と削除
function Set-CatalogEntry([string]$kind, $entry) {
    if ($kind -eq "image") {
        if ($null -ne $entry.params) { $entry.params = [pscustomobject]$entry.params }
        $why = Test-CatalogEntry $entry
        if ($why) { throw $why }
        $note = [string]$entry.note
        $noteRef = [string]$entry.noteRef
        if ($noteRef -like '@*' -and $note -ceq (Resolve-LangRef $noteRef)) { $note = $noteRef } # メモを書き換えていない: "@キー" のまま保存する
        $clean = [ordered]@{ id = [string]$entry.id; label = [string]$entry.label; note = $note; source = "user"; verified = [bool]$entry.verified
            diffusion = [string]$entry.diffusion; match = [string]$entry.match; folder = [string]$entry.folder
            files = $(if ($null -ne $entry.files) { $entry.files } else { [pscustomobject]@{} }); modes = @($entry.modes); translate = [bool]$entry.translate
            params = $(if ($null -ne $entry.params) { $entry.params } else { [pscustomobject]@{} }); editSteps = $entry.editSteps; negative = [string]$entry.negative }
        $data = Get-CatalogData
        $data.image = @(@($data.image | Where-Object { $_.id -cne $clean.id }) + [pscustomobject]$clean)
    } elseif ($kind -eq "chat") {
        $why = Test-ChatEntry $entry
        if ($why) { throw $why }
        $sampling = [ordered]@{}
        if ($null -ne $entry.sampling) { foreach ($p in @($entry.sampling.PSObject.Properties)) { if ("$($p.Value)" -ne "") { $sampling[$p.Name] = [double]::Parse("$($p.Value)", [Globalization.CultureInfo]::InvariantCulture) } } }
        $clean = [ordered]@{ file = [string]$entry.file; label = [string]$entry.label; source = "user"; sampling = [pscustomobject]$sampling; applyOnSwitch = [bool]$entry.applyOnSwitch }
        $data = Get-CatalogData
        $data.chat = @(@($data.chat | Where-Object { $_.file -cne $clean.file }) + [pscustomobject]$clean)
    } else { throw (L 'catalog.badKind') }
    Save-CatalogFile $data
    Clear-ImageInventoryCache
}

function Remove-CatalogEntry([string]$kind, [string]$key) {
    $data = Get-CatalogData
    if ($kind -eq "image") { $before = @($data.image).Count; $data.image = @($data.image | Where-Object { $_.id -cne $key }); $after = $data.image.Count }
    elseif ($kind -eq "chat") { $before = @($data.chat).Count; $data.chat = @($data.chat | Where-Object { $_.file -cne $key }); $after = $data.chat.Count }
    else { throw (L 'catalog.badKind') }
    if ($after -eq $before) { throw (L 'catalog.cannotDeleteBundled') }
    Save-CatalogFile $data
    Clear-ImageInventoryCache
}

# --- 一覧 ------------------------------------------------------------------------
function Get-ChatModelDirs { @((Join-Path (Split-Path $PSScriptRoot -Parent) "models"), (Join-Path (Split-Path $PSScriptRoot -Parent) "models\chat"), $script:modelDir, (Join-Path $script:modelDir "chat")) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique }
function Get-ImageModelDirs { @((Join-Path (Split-Path $PSScriptRoot -Parent) "models\image"), (Join-Path $script:modelDir "image")) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique }

# チャット用の候補 (起動時に使うので、名前だけで軽く決める。中身の確認は一覧の画面を開いたときに行う)
function Find-ModelFiles([string[]]$folders) {
    $list = foreach ($folder in $folders) {
        foreach ($sub in @($folder, (Join-Path $folder "chat"))) {
            # 起動のたびに通るので、Sort-Object と Where-Object のパイプラインを使わない (start.ps1 の New-Object の注記と同じ理由)
            if (-not [IO.Directory]::Exists($sub)) { continue } # 無いフォルダ (chat を作っていない、など) で Get-ChildItem にエラーを作らせない
            $found = @(Get-ChildItem -LiteralPath $sub -Filter *.gguf -File -ErrorAction SilentlyContinue)
            if ($found.Count -gt 1) { [Array]::Sort([string[]]@(foreach ($f in $found) { $f.Name }), $found, [StringComparer]::CurrentCultureIgnoreCase) }
            foreach ($f in $found) {
                if ($f.Name -notmatch "mmproj" -and $f.Name -notmatch "-(?!00001)\d{5}-of-\d{5}\.gguf$" -and -not (Test-PartialDownload $f)) { $f }
            }
        }
    }
    # 同じファイルを 2 回数えない (モデルのフォルダとアプリの models が同じときなど)
    $seen = @{}
    @($list | Where-Object { if ($seen.ContainsKey($_.FullName)) { $false } else { $seen[$_.FullName] = $true; $true } })
}

function Get-ChatInventory($catalog, $autoChats) {
    $out = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($dir in Get-ChatModelDirs) {
        foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
            if ($seen.ContainsKey($file.FullName)) { continue }
            $seen[$file.FullName] = $true
            $partial = Test-PartialDownload $file
            if (-not $partial -and $file.Extension -ne ".gguf") { continue }
            if ($file.Name -match "mmproj" -or $file.Name -match "-(?!00001)\d{5}-of-\d{5}\.gguf$") { continue }
            $id = $file.BaseName -replace "[\[\]\r\n]", "_"
            $item = [ordered]@{ id = $id; file = $file.Name; dir = $dir; bytes = $file.Length; label = $id; state = "ok"; note = ""; arch = ""; context = 0; sampling = ""; entry = $null }
            if ($partial) { $item.state = "partial"; $item.note = (L 'model.partialDownload'); $item.id = ""; $out.Add($item); continue }
            $kind = Get-ComponentKind $file
            if ($kind -ne "chat") { continue } # 画像用やエンコーダは、チャットの一覧に出さない
            $h = Get-ModelHeader $file
            if (-not $h.Complete) { $item.state = "partial"; $item.note = (L 'model.truncated') }
            $arch = $h.Get("general.architecture")
            $item.arch = $arch
            $ctx = 0; [void][int]::TryParse($h.Get("$arch.context_length"), [ref]$ctx); $item.context = $ctx
            $meta = [ordered]@{}
            foreach ($pair in @(@("temp", "temperature"), @("top_p", "top_p"), @("top_k", "top_k"), @("min_p", "min_p"))) {
                $v = $h.Get("general.sampling.$($pair[0])")
                if ($v) { $meta[$pair[1]] = [math]::Round([double]::Parse($v, [Globalization.CultureInfo]::InvariantCulture), 3) }
            }
            $item.sampling = ($meta.Keys | ForEach-Object { "$_=$($meta[$_])" }) -join " "
            $name = $h.Get("general.name"); if ($name) { $item.label = $name }
            $entry = $null
            foreach ($c in $catalog.chat) { if ($file.Name -like [string]$c.file) { $entry = $c; break } }
            if ($null -eq $entry -and $item.state -eq "ok") {
                # 新しいモデル: 中の推奨値 (あれば) を入れた項目を作る。切り替え時に自動で使うかは、既定では「使わない」
                $entry = [pscustomobject][ordered]@{ file = $file.Name; label = $item.label; source = "auto"; sampling = [pscustomobject]$meta; applyOnSwitch = $false }
                $autoChats.Add($entry)
            }
            if ($null -ne $entry) {
                if ($entry.label) { $item.label = [string]$entry.label }
                $item.entry = $entry
            }
            $out.Add($item)
        }
    }
    return $out.ToArray()
}

# 画像用のフォルダの中身を役割ごとにまとめる。本体は大きいものを優先する
function Get-FolderParts($folder) {
    $files = @(Get-ChildItem -LiteralPath $folder.FullName -File -Recurse -Depth 1 -ErrorAction SilentlyContinue)
    $parts = [ordered]@{}; $diffusion = $null; $partial = ""
    foreach ($f in $files) {
        if (Test-PartialDownload $f) { $partial = (L 'model.partialFile' @{ file = $f.Name }); continue }
        if ($f.Extension -ne ".gguf" -and $f.Extension -ne ".safetensors") { continue }
        $kind = Get-ComponentKind $f
        if (-not (Get-ModelHeader $f).Complete -and -not $partial) { $partial = (L 'model.truncatedFile' @{ file = $f.Name }) }
        if ($kind -eq "chat") { $kind = "text:llm" } # 画像用のフォルダにある言語モデルは、テキストエンコーダ
        if ($kind -like "diffusion:*" -or $kind -eq "checkpoint") {
            if ($null -eq $diffusion -or $f.Length -gt $diffusion.file.Length) { $diffusion = @{ kind = $kind; file = $f } }
        } elseif (($kind -like "text:*" -or $kind -like "vae:*") -and -not $parts.Contains($kind)) { $parts[$kind] = $f.FullName }
    }
    return @{ parts = $parts; diffusion = $diffusion; partial = $partial }
}

# 知らないモデル用の標準的な設定 (自動作成・未確認)。テキストエンコーダと VAE は、フォルダにある種類から割り当てる
function New-AutoImageEntry([string]$id, $folder, $found) {
    $files = [ordered]@{}
    foreach ($kind in $found.parts.Keys) {
        if ($kind -eq "text:t5" -and -not $files.Contains("t5xxl")) { $files.t5xxl = $kind }
        elseif (($kind -eq "text:llm" -or $kind -eq "text:qwen3vl") -and -not $files.Contains("llm")) { $files.llm = $kind }
        elseif ($kind -eq "text:clip" -and -not $files.Contains("clip_l")) { $files.clip_l = $kind }
        elseif ($kind -like "vae:*" -and -not $files.Contains("vae")) { $files.vae = $kind }
    }
    $family = if ($found.diffusion.kind -eq "checkpoint") { "checkpoint" } else { $found.diffusion.kind.Substring(10) }
    return [pscustomobject][ordered]@{
        id = "auto-$id"; label = $folder.Name; note = (L 'note.auto'); noteRef = '@note.auto'; source = "auto"; verified = $false
        diffusion = $family; match = ""; folder = $folder.Name; files = [pscustomobject]$files; modes = @("generate")
        translate = [bool]($files.Contains("t5xxl") -or $files.Contains("clip_l"))
        params = [pscustomobject][ordered]@{ steps = 20; "cfg-scale" = 5.0; "sampling-method" = "euler" }; negative = ""
    }
}

function Get-ImageInventory($catalog, $autoImages, [string]$modelId = "") {
    $out = [Collections.Generic.List[object]]::new()
    $ids = @{}
    foreach ($root in Get-ImageModelDirs) {
        foreach ($folder in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $id = $folder.Name -replace '[^A-Za-z0-9._-]', '_'
            if ($ids.ContainsKey($id)) { $id = "$id-$($ids.Count)" }
            $ids[$id] = $true
            if ($modelId -and $id -cne $modelId) { continue } # 実行時は選んだモデルの中だけ調べる
            $item = [ordered]@{ id = $id; label = $folder.Name; dir = $folder.FullName; note = ""; modes = @(); translate = $false; state = "ok"; problem = ""
                catalog = ""; verified = $false; source = ""; kinds = @(); entry = $null }
            $found = Get-FolderParts $folder
            if ($modelId) { $item.found = $found } # 実行時 (Resolve-ImageModel) に同じフォルダを調べ直さない。画面には送らない
            $item.kinds = @($found.parts.Keys)
            if ($found.partial) { $item.state = "partial"; $item.problem = $found.partial }
            if ($null -eq $found.diffusion) {
                if ($item.state -eq "ok") { $item.state = "unsupported"; $item.problem = (L 'image.noDiffusion') }
                $out.Add($item); continue
            }
            $family = if ($found.diffusion.kind -eq "checkpoint") { "checkpoint" } else { $found.diffusion.kind.Substring(10) }
            # 合う定義: フォルダ名で指定したもの → 系統 (と、ファイル名の一部) が合うもの
            $entry = $catalog.image | Where-Object { $_.folder -and $_.folder -ceq $folder.Name } | Select-Object -First 1
            if ($null -eq $entry) {
                foreach ($e in $catalog.image) {
                    if ($e.folder -or [string]$e.diffusion -ne $family) { continue }
                    if ($e.match -and $found.diffusion.file.Name -notlike "*$($e.match)*") { continue }
                    $entry = $e; break
                }
            }
            if ($null -eq $entry) {
                if ($item.state -ne "ok") { $out.Add($item); continue } # ダウンロードの途中では、役割を決めつけない
                $entry = New-AutoImageEntry $id $folder $found
                if (Test-CatalogEntry $entry) { $item.state = "unsupported"; $item.problem = (L 'image.autoFailed'); $out.Add($item); continue }
                $autoImages.Add($entry)
            }
            $item.entry = $entry
            $item.catalog = [string]$entry.id
            $item.verified = [bool]($entry.verified -ne $false -and $entry.source -ne "auto")
            $item.source = [string]$entry.source
            if ($entry.label -and $entry.folder) { $item.label = [string]$entry.label }
            $item.note = [string]$entry.note
            $item.autoNote = ([string]$entry.noteRef -ceq '@note.auto') # メモが「自動作成・未確認」の文言 (画面で「未確認」を重ねて出さない)
            $item.translate = [bool]$entry.translate
            $item.modes = @($entry.modes)
            $missing = @()
            if ($null -ne $entry.files) {
                foreach ($p in @($entry.files.PSObject.Properties)) {
                    $want = [string]$p.Value
                    if (-not $found.parts.Contains($want)) { $missing += (Get-KindLabel $want) }
                }
            }
            if ($missing.Count -and $item.state -eq "ok") { $item.state = "missing"; $item.problem = (L 'image.missingFiles' @{ list = ($missing -join (L 'common.listSep')) }) }
            $out.Add($item)
        }
    }
    return $out.ToArray()
}

# sd-cli に渡すファイルと引数。使えないときは例外
function Resolve-ImageModel([string]$id, [string]$mode) {
    $catalog = Get-ModelCatalog
    $none = New-Object System.Collections.Generic.List[object]
    $item = @(Get-ImageInventory $catalog $none $id) | Select-Object -First 1
    if ($null -eq $item) { throw (L 'image.modelNotFound' @{ id = $id }) }
    if ($item.state -ne "ok") { throw (L 'image.modelUnusable' @{ label = $item.label; problem = $item.problem }) }
    if (@($item.modes) -notcontains $mode) { throw (L $(if ($mode -eq 'edit') { 'image.modelNoEdit' } else { 'image.modelNoGenerate' }) @{ label = $item.label }) }
    $entry = $item.entry
    $found = $item.found
    $params = [ordered]@{}
    if ($null -ne $entry.params) { foreach ($p in $entry.params.PSObject.Properties) { $params[$p.Name] = $p.Value } }
    if ($mode -eq "edit" -and $null -ne $entry.editSteps) { $params.steps = [int]$entry.editSteps }
    $result = [ordered]@{ label = $item.label; diffusion = $found.diffusion.file.FullName; checkpoint = ($found.diffusion.kind -eq "checkpoint"); roles = [ordered]@{}
        args = (ConvertTo-ImageParamArgs ([pscustomobject]$params)); negative = [string]$entry.negative }
    if ($null -ne $entry.files) { foreach ($p in @($entry.files.PSObject.Properties)) { $result.roles[$p.Name] = $found.parts[[string]$p.Value] } }
    return $result
}

# 画像モデルの一覧 (フォルダとファイルの先頭を調べる)。画面は「画像の状態」と「モデルの一覧」を続けて求めるので、
# フォルダの中身とカタログが変わっていなければ前の結果を使い回す。設定やフォルダを変えたときは Clear-ImageInventoryCache で捨てる
# $treeStamp: 呼び出し側が調べたばかりのフォルダの印 (同じ依頼の中で 2 度調べない)
$script:imageInventoryCache = $null
function Get-SharedImageInventory($catalog = $null, [string]$treeStamp = '') {
    if ($null -eq $catalog) { $catalog = Get-ModelCatalog }
    if (-not $treeStamp) { $treeStamp = Get-ModelTreeStamp }
    $signature = $treeStamp + '|' + $script:modelCatalogSignature
    $c = $script:imageInventoryCache
    if ($null -ne $c -and $c.signature -ceq $signature) { return $c }
    $autos = New-Object System.Collections.Generic.List[object]
    $items = @(Get-ImageInventory $catalog $autos)
    $script:imageInventoryCache = @{ signature = $signature; items = $items; autos = $autos }
    return $script:imageInventoryCache
}
function Clear-ImageInventoryCache { $script:imageInventoryCache = $null; $script:modelInventoryCache = $null }

# File metadata is cheap to enumerate; do not repeat classification, catalog validation
# and UI-view construction when the directory tree has not changed.
# The directory listing already carries size and time (no extra call per file). A folder that
# cannot be listed (no access, broken junction) is recorded as such instead of failing the whole list.
function Get-ModelTreeStamp {
    $stamp = [Text.StringBuilder]::new([string]$script:language)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $dirs = [Collections.Generic.List[string]]::new()
    $imageRoots = @(Get-ImageModelDirs)
    foreach ($dir in @(Get-ChatModelDirs) + $imageRoots) { if ($seen.Add($dir)) { $dirs.Add($dir) } }
    foreach ($root in $imageRoots) {
        try {
            foreach ($dir in [IO.Directory]::GetDirectories($root)) {
                if ($seen.Add($dir)) { $dirs.Add($dir) }
                try { foreach ($sub in [IO.Directory]::GetDirectories($dir)) { if ($seen.Add($sub)) { $dirs.Add($sub) } } } catch { }
            }
        } catch { }
    }
    foreach ($dir in $dirs) {
        [void]$stamp.Append('|').Append($dir)
        try {
            foreach ($f in [IO.DirectoryInfo]::new($dir).GetFiles()) {
                [void]$stamp.Append('|').Append($f.Name).Append(':').Append($f.Length).Append(':').Append($f.LastWriteTimeUtc.Ticks)
            }
        } catch { [void]$stamp.Append('|?') }
    }
    return $stamp.ToString()
}
# 一覧を JSON のバイト列で返す。一覧が変わっていなければ、変換した結果も使い回す
# (PowerShell 5.1 の ConvertTo-Json は遅く、画面は設定を開くたびに一覧を求める)
function Get-ModelInventoryJson {
    $inventory = Get-ModelInventory
    if ($null -eq $script:modelInventoryJson -or -not [object]::ReferenceEquals($script:modelInventoryJsonOf, $inventory)) {
        $script:modelInventoryJson = [Text.UTF8Encoding]::new($false).GetBytes(($inventory | ConvertTo-Json -Compress -Depth 8))
        $script:modelInventoryJsonOf = $inventory
    }
    return , $script:modelInventoryJson
}
function Get-ModelInventory {
    $catalog = Get-ModelCatalog
    $treeStamp = Get-ModelTreeStamp
    $signature = $treeStamp + '|' + $script:modelCatalogSignature
    if ($null -ne $script:modelInventoryCache -and $script:modelInventorySignature -ceq $signature) { return $script:modelInventoryCache }
    $autoImages = New-Object System.Collections.Generic.List[object]
    $autoChats = New-Object System.Collections.Generic.List[object]
    $chat = @(Get-ChatInventory $catalog $autoChats)
    $shared = Get-SharedImageInventory $catalog $treeStamp
    $image = $shared.items
    foreach ($e in $shared.autos) { $autoImages.Add($e) }
    $kindLabels = @{}
    foreach ($kind in $script:kindNames) { $kindLabels[$kind] = Get-KindLabel $kind }
    Add-CatalogEntries $autoImages $autoChats # 新しいモデルの項目を model-catalog.json に足す (足すものがあるときだけ書く)
    if ($autoImages.Count) { Clear-ImageInventoryCache } # 足した項目を次の一覧に反映する
    $script:modelInventorySignature = $signature
    $script:modelInventoryCache = [ordered]@{
        chat = $chat; image = $image; problems = @($catalog.problems)
        chatDirs = @(Get-ChatModelDirs); imageDirs = @(Get-ImageModelDirs); modelDir = $script:modelDir
        paramSpec = @(Get-ParamSpecView); roles = @($script:roleFlags.Keys | ForEach-Object { [ordered]@{ name = $_; label = (L "role.$_") } })
        kindLabels = $kindLabels; chatSamplingKeys = $script:chatSamplingKeys
    }
    return $script:modelInventoryCache
}
