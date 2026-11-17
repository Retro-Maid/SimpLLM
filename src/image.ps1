# 画像の生成・編集 (start.ps1 から読み込む)
# stable-diffusion.cpp の sd-cli.exe を 1 回の処理ごとに起動する。sd-server は使わない:
#   sd-server は任意の Origin を許可し認証もないため、起動中に他のページから画像を読まれうる。sd-cli はポートを開かない。
# 入出力の画像は .run\image\<ランダム>\ に一時的に置き、処理が済んだら消す (起動時と終了時にも掃除する)。
# 指示文はユーザー専用ACLの名前付きパイプで渡す。引数・通常ファイルには書かない。

if (-not $function:L) { . (Join-Path $PSScriptRoot 'lang.ps1') } # 文言 (L 'キー')。start.ps1 から読み込んだときは読み込み済み
$script:imageEngine = Join-Path (Split-Path $PSScriptRoot -Parent) "bin\sd\sd-cli.exe"
$script:imageTemp = Join-Path (Split-Path $PSScriptRoot -Parent) ".run\image"
$script:imageJob = $null
$script:imageGpu = $null
$script:imageMaxBody = 25MB
$script:imageTimeoutMin = 20 # HDD から初めて読み込むと 5 分以上かかるので長めにする

# start.ps1 から読み込んだときはコンパイル結果を使い回す (Import-CSharp は session.ps1)。単体で読み込んだとき (テスト) はその場でコンパイルする
$imageSource = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

public static class SimpllmArgs {
    // CommandLineToArgvW の規則で 1 つの引数として読まれるように囲む (引用符の前と末尾の \ は 2 倍にする)
    public static string Quote(string a) {
        if (a == null) a = "";
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        StringBuilder sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(c); }
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
    public static string Join(string[] list) {
        List<string> parts = new List<string>();
        foreach (string a in list) parts.Add(Quote(a));
        return string.Join(" ", parts.ToArray());
    }
}

// sd-cli の出力を読みながら進み具合だけを覚える。出力はファイルにもコンソールにも残さない
public sealed class SimpllmImage {
    static readonly Regex Bar = new Regex(@"\|\s*(\d+)/(\d+)\s*-\s*[\d.]+\s*(MB/s|it/s|s/it)", RegexOptions.Compiled);
    static readonly Regex Decoding = new Regex(@"^\[I\] decoding \d+ latents", RegexOptions.Compiled); // "encoding / decoding" の行と区別する
    readonly object gate = new object();
    readonly LinkedList<string> problems = new LinkedList<string>();
    public Process Proc;
    public string Phase = "loading"; // loading, sampling, decoding
    public int Done, Total;
    public bool OutOfMemory;

    // --prompt-fileはWindowsの名前付きパイプも読める。ディスク上に本文を作らない。
    static NamedPipeServerStream PromptPipe(string name) {
        PipeSecurity acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 4096, 4096, acl);
    }
    static void SendPrompt(NamedPipeServerStream pipe, string prompt) {
        byte[] bytes = Encoding.UTF8.GetBytes(prompt);
        try {
            IAsyncResult pending = pipe.BeginWaitForConnection(null, null);
            using (WaitHandle ready = pending.AsyncWaitHandle) {
                if (!ready.WaitOne(30000)) return;
                pipe.EndWaitForConnection(pending);
            }
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        } catch { } finally { Array.Clear(bytes, 0, bytes.Length); pipe.Dispose(); }
    }

    public static SimpllmImage Start(string exe, string[] args, string workDir, string gpu) {
        SimpllmImage run = new SimpllmImage();
        List<string> safeArgs = new List<string>();
        List<NamedPipeServerStream> pipes = new List<NamedPipeServerStream>();
        List<string> prompts = new List<string>();
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "-p" || args[i] == "-n") {
                string flag = args[i];
                if (++i >= args.Length) throw new ArgumentException("Missing prompt");
                string name = "simpllm-prompt-" + Guid.NewGuid().ToString("N");
                pipes.Add(PromptPipe(name)); prompts.Add(args[i]);
                safeArgs.Add(flag == "-p" ? "--prompt-file" : "--negative-prompt-file");
                safeArgs.Add(@"\\.\pipe\" + name);
            } else safeArgs.Add(args[i]);
        }
        ProcessStartInfo info = new ProcessStartInfo(exe, SimpllmArgs.Join(safeArgs.ToArray()));
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WorkingDirectory = workDir;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        if (gpu != null && gpu.Length > 0) {
            info.EnvironmentVariables["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID";
            info.EnvironmentVariables["CUDA_VISIBLE_DEVICES"] = gpu;
        }
        Process p = new Process();
        p.StartInfo = info;
        p.EnableRaisingEvents = true;
        p.Exited += delegate { foreach (NamedPipeServerStream pipe in pipes) { try { pipe.Dispose(); } catch { } } };
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { run.Read(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { run.Read(e.Data); };
        try { p.Start(); } catch { foreach (NamedPipeServerStream pipe in pipes) pipe.Dispose(); throw; }
        for (int i = 0; i < pipes.Count; i++) {
            NamedPipeServerStream pipe = pipes[i]; string prompt = prompts[i];
            ThreadPool.QueueUserWorkItem(delegate { SendPrompt(pipe, prompt); });
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        run.Proc = p;
        return run;
    }

    void Read(string line) {
        if (line == null) return;
        line = line.Replace("\u001b[K", "").Trim();
        if (line.Length == 0) return;
        lock (gate) {
            Match m = Bar.Match(line);
            if (m.Success) {
                bool load = m.Groups[3].Value == "MB/s";
                if (load && Phase != "loading") return; // 仕上げ用の VAE の読み込みは、仕上げ中のまま扱う
                if (!load) Phase = "sampling";
                Done = int.Parse(m.Groups[1].Value);
                Total = int.Parse(m.Groups[2].Value);
                return;
            }
            if (Decoding.IsMatch(line)) { Phase = "decoding"; Done = 0; Total = 0; }
            string low = line.ToLowerInvariant();
            if (low.Contains("out of memory") || low.Contains("cudamalloc") || low.Contains("failed to allocate") ||
                low.Contains("cannot make enough memory available") || low.Contains("failed during workspace capacity check")) OutOfMemory = true;
            if (line.StartsWith("[E]") || line.StartsWith("[W]") || low.Contains("error") || low.Contains("failed")) {
                problems.AddLast(line.Length > 300 ? line.Substring(0, 300) : line);
                while (problems.Count > 6) problems.RemoveFirst();
            }
        }
    }

    public string[] Snapshot() {
        lock (gate) { return new string[] { Phase, Done.ToString(), Total.ToString() }; }
    }
    public string Problems() {
        lock (gate) { return string.Join("\n", new List<string>(problems).ToArray()); }
    }
}
"@
if (Get-Command Import-CSharp -ErrorAction SilentlyContinue) { Import-CSharp "SimpllmImage" $imageSource } elseif (-not ("SimpllmImage" -as [type])) { Add-Type -TypeDefinition $imageSource }

function Clear-ImageTemp {
    Remove-ImagePath $script:imageTemp
}

# session.ps1 の上書き削除を使う。対象は画像用一時領域内だけに限定する。
# 削除できなかったときは成功扱いにせず、呼び出し元へ知らせる。
function Remove-ImagePath([string]$path) {
    if (-not $path) { return }
    $base = [IO.Path]::GetFullPath($script:imageTemp).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($path)
    if ($target -ine $base -and -not $target.StartsWith("$base\", [StringComparison]::OrdinalIgnoreCase)) {
        throw (L 'temp.notTemp')
    }
    if (-not (Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath "$target.wiping")) { return }
    foreach ($candidate in @($target, "$target.wiping")) {
        if (Test-Path -LiteralPath $candidate) {
            $items = @(Get-Item -LiteralPath $candidate -Force)
            if (Test-Path -LiteralPath $candidate -PathType Container) { $items += @(Get-ChildItem -LiteralPath $candidate -Force -Recurse) }
            if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
                throw (L 'temp.isLink')
            }
        }
    }
    if (-not (Remove-Wiped $target)) { throw (L 'temp.deleteFailed' @{ path = $target }) }
}

# VRAM がいちばん大きい GPU を使う (nvidia-smi の番号は PCI バスの順。CUDA 側も同じ順にそろえる)
function Get-ImageGpu {
    if ($null -ne $script:imageGpu) { return $script:imageGpu }
    $script:imageGpu = @{ index = ""; name = "" }
    try {
        $rows = @(& nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>$null)
        $best = $rows | ForEach-Object { $c = $_ -split ",\s*"; [pscustomobject]@{ index = $c[0].Trim(); name = $c[1].Trim(); mem = [int]$c[2] } } |
            Sort-Object mem -Descending | Select-Object -First 1
        if ($null -ne $best) { $script:imageGpu = @{ index = $best.index; name = $best.name } }
    } catch { }
    return $script:imageGpu
}

# 指示文: 改行などの制御文字を除き、sd-cli が別のファイルを読みに行く書式 (<lora:名前:重み> など) を取り除く
function ConvertTo-ImagePrompt([string]$text) {
    $t = [regex]::Replace([string]$text, "[\x00-\x1F\x7F]", " ")
    $t = [regex]::Replace($t, "<[^<>]*:[^<>]*>", " ")
    $t = [regex]::Replace($t, "\s{2,}", " ").Trim()
    if ($t.StartsWith("-")) { $t = " $t" }
    return $t
}

# 受け取った依頼を検証して、sd-cli の引数を作る。問題があれば例外
# $model は Resolve-ImageModel (models.ps1) の結果: 本体・役割ごとのファイル・定義の引数 (定義は読み込み時に検証済み)
function New-ImageArgs($params, [string]$inputPath, [string]$outputPath, $model) {
    $mode = [string]$params.mode
    if ($mode -ne "generate" -and $mode -ne "edit") { throw (L 'image.badMode') }
    $prompt = ConvertTo-ImagePrompt $params.prompt
    if ($prompt.Length -eq 0) { throw (L 'image.emptyPrompt') }
    if ($prompt.Length -gt 2000) { throw (L 'image.promptTooLong') }
    $w = 0; $h = 0; $seed = 0L
    if (-not [int]::TryParse([string]$params.width, [ref]$w) -or -not [int]::TryParse([string]$params.height, [ref]$h)) { throw (L 'image.badSize') }
    if ($w -lt 256 -or $h -lt 256 -or $w -gt 1536 -or $h -gt 1536 -or $w % 64 -or $h % 64 -or $w * $h -gt 1536 * 1024) { throw (L 'image.badSize') }
    if (-not [long]::TryParse([string]$params.seed, [ref]$seed) -or $seed -lt 0 -or $seed -gt 2147483647) { throw (L 'image.badSeed') }
    if ($mode -eq "edit" -and -not $inputPath) { throw (L 'image.noSource') }
    $list = if ($model.checkpoint) { @("-m", $model.diffusion) } else { @("--diffusion-model", $model.diffusion) } # 一体型のモデルは -m
    foreach ($role in $model.roles.Keys) { $list += @($script:roleFlags[$role], $model.roles[$role]) } # 役割と引数の対応はコードで決める
    $list += @($model.args) + @("--offload-to-cpu", "-W", "$w", "-H", "$h", "--seed", "$seed", "--disable-image-metadata")
    if ($model.negative) { $list += @("-n", $model.negative) }
    if ($mode -eq "edit") { $list += @("-r", $inputPath) }
    return $list + @("-p", $prompt, "-o", $outputPath)
}

# 画像エンジンに渡すファイルのパスを、日本語などを含まない形にする (llama.cpp 系の実行ファイルは、
# 日本語を含むパスの引数を読めない。実測は llama-server)。作業フォルダからの相対パスにすると、共通の部分 (アプリのフォルダ) が消える。
# 英数字だけのパスはそのまま使う。どうしても含んでしまうときは理由を示して止める
$script:enginePathFlags = @('-m', '--diffusion-model', '--t5xxl', '--llm', '--clip_l', '--clip_g', '--vae', '-r', '-o')
function ConvertTo-EngineArgs([string[]]$list, [string]$workDir) {
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $list.Count; $i++) {
        $out.Add($list[$i])
        if ($script:enginePathFlags -cnotcontains $list[$i] -or $i + 1 -ge $list.Count) { continue }
        $path = $list[++$i]
        if ($path -match '[^\x20-\x7E]') {
            $base = New-Object Uri ($workDir.TrimEnd('\') + '\')
            $uri = $base.MakeRelativeUri((New-Object Uri $path)) # 別のドライブなら相対にできない
            $relative = [Uri]::UnescapeDataString($uri.ToString()).Replace('/', '\')
            if ($uri.IsAbsoluteUri -or $relative -match '[^\x20-\x7E]') {
                throw (L 'image.nonAsciiPath' @{ path = $path })
            }
            $path = $relative
        }
        $out.Add($path)
    }
    return ,$out.ToArray()
}

function Test-ImageRunning { $null -ne $script:imageJob -and $script:imageJob.state -eq "running" }

function Remove-ImageJobFiles($job) {
    if ($null -eq $job) { return }
    if ($null -ne $job.result) { [Array]::Clear($job.result, 0, $job.result.Length); $job.result = $null }
    if ($job.handle -ne [IntPtr]::Zero) { [void][SimpllmJob]::CloseHandle($job.handle); $job.handle = [IntPtr]::Zero }
    if ($job.dir) { Remove-ImagePath $job.dir }
}

# 本文: [JSON の長さ (4 バイト, リトルエンディアン)][JSON (UTF-8)][元画像 (編集のときだけ)]
# 大きな画像を JSON (base64) で送ると PowerShell 5.1 の ConvertFrom-Json が遅いので分けて受ける
function Read-ImageRequest($request) {
    $length = $request.ContentLength64
    if ($length -le 4 -or $length -gt $script:imageMaxBody) { throw (L 'common.badBodySize') }
    $body = New-Object byte[] $length
    $read = 0
    while ($read -lt $length) {
        $n = $request.InputStream.Read($body, $read, $length - $read)
        if ($n -le 0) { throw (L 'common.incomplete') }
        $read += $n
    }
    $jsonLength = [BitConverter]::ToInt32($body, 0)
    if ($jsonLength -le 0 -or $jsonLength -gt 16384 -or 4 + $jsonLength -gt $length) { throw (L 'common.badFormat') }
    $params = [System.Text.Encoding]::UTF8.GetString($body, 4, $jsonLength) | ConvertFrom-Json
    $imageBytes = $null
    if ($length -gt 4 + $jsonLength) {
        $imageBytes = New-Object byte[] ($length - 4 - $jsonLength)
        [Array]::Copy($body, 4 + $jsonLength, $imageBytes, 0, $imageBytes.Length)
    }
    return @{ params = $params; image = $imageBytes }
}

function Get-ImageExtension([byte[]]$bytes) {
    if ($null -eq $bytes -or $bytes.Length -lt 8) { return $null }
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { return ".png" }
    if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF) { return ".jpg" }
    return $null
}

function Start-ImageJob($params, [byte[]]$imageBytes) {
    if (Test-ImageRunning) { throw (L 'image.busy') }
    if (-not (Test-Path -LiteralPath $script:imageEngine)) { throw (L 'image.noEngine' @{ path = $script:imageEngine }) }
    $mode = [string]$params.mode
    if ($mode -ne "generate" -and $mode -ne "edit") { throw (L 'image.badMode') }
    if ([string]$params.model -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw (L 'image.badModel') }
    $model = Resolve-ImageModel ([string]$params.model) $mode
    $old = $script:imageJob
    $script:imageJob = $null
    Remove-ImageJobFiles $old

    $bytes = New-Object byte[] 16
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $id = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    $dir = Join-Path $script:imageTemp $id
    $inputPath = ""
    if ([string]$params.mode -eq "edit") {
        $ext = Get-ImageExtension $imageBytes
        if ($null -eq $ext) { throw (L 'image.sourceType') }
        $inputPath = Join-Path $dir "input$ext"
    } elseif ($null -ne $imageBytes) { throw (L 'image.noSourceForGenerate') }
    $outputPath = Join-Path $dir "output.png"
    $cliArgs = ConvertTo-EngineArgs (New-ImageArgs $params $inputPath $outputPath $model) $dir # 検証が済むまでファイルを作らない

    New-Item -ItemType Directory -Force $dir | Out-Null
    $job = @{ id = $id; dir = $dir; output = $outputPath; result = $null; state = "running"; error = ""; oom = $false; handle = [IntPtr]::Zero; started = [Diagnostics.Stopwatch]::StartNew(); run = $null }
    try {
        if ($inputPath) { [IO.File]::WriteAllBytes($inputPath, $imageBytes) }
        $job.run = [SimpllmImage]::Start($script:imageEngine, [string[]]$cliArgs, $dir, (Get-ImageGpu).index)
        # このスクリプトが終わったら一緒に終わらせる。すぐ終わってしまったプロセスは登録できないが、それは下の確認で失敗として扱う
        try { $job.handle = [SimpllmJob]::KillOnClose($job.run.Proc.Handle) } catch { if (-not $job.run.Proc.HasExited) { throw } }
    } catch {
        if ($null -ne $job.run) { try { $job.run.Proc.Kill() } catch { } }
        Remove-ImageJobFiles $job
        throw
    }
    $script:imageJob = $job
    return $id
}

# 失敗・打ち切りのあとの片付け。ファイルが掴まれていて消せなくても、例外でアプリを止めない (次回の起動時に Clear-ImageTemp が消す)
function Remove-FailedImageFiles($job) {
    try { Remove-ImageJobFiles $job } catch { $job.error += ("`n" + (L 'image.cleanupLater' @{ error = $_.Exception.Message })) }
}

# 終わっていれば結果を確定する。時間がかかりすぎたら止める
function Update-ImageJob {
    $job = $script:imageJob
    if ($null -ne $job -and $job.state -eq 'done' -and ([DateTime]::UtcNow - $job.completedUtc).TotalSeconds -gt 60) { Stop-ImageJob $job.id; return }
    if ($null -eq $job -or $job.state -ne "running") { return }
    $proc = $job.run.Proc
    if (-not $proc.HasExited -and $job.started.Elapsed.TotalMinutes -gt $script:imageTimeoutMin) {
        try { $proc.Kill() } catch { }
        [void]$proc.WaitForExit(5000)
        $job.state = "failed"; $job.error = (L 'image.timeout' @{ min = $script:imageTimeoutMin })
        Remove-FailedImageFiles $job
        return
    }
    if (-not $proc.HasExited) { return }
    $proc.WaitForExit() # 出力の読み取りが終わるまで待つ
    $job.started.Stop()
    if ($proc.ExitCode -eq 0 -and (Test-Path -LiteralPath $job.output)) {
        $result = $null
        try {
            $result = [IO.File]::ReadAllBytes($job.output)
            Remove-ImageJobFiles $job
            $job.result = $result
            $job.completedUtc = [DateTime]::UtcNow
            $job.state = "done"
        } catch {
            if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
            $job.state = "failed"; $job.error = (L 'image.cleanupFailed' @{ error = $_.Exception.Message })
        }
        return
    }
    $job.state = "failed"
    $job.oom = $job.run.OutOfMemory
    $detail = $job.run.Problems()
    $job.error = if ($job.oom) { (L 'image.oom') } else { (L 'image.failed' @{ code = $proc.ExitCode }) }
    if ($detail) { $job.error += "`n$detail" }
    Remove-FailedImageFiles $job
}

function Get-ImageJobInfo([string]$id) {
    Update-ImageJob
    $job = $script:imageJob
    if ($null -eq $job -or $job.id -cne $id) { throw (L 'image.jobNotFound') }
    $snap = if ($null -ne $job.run) { $job.run.Snapshot() } else { @("", "0", "0") }
    return @{ id = $job.id; state = $job.state; phase = $snap[0]; done = [int]$snap[1]; total = [int]$snap[2]; elapsedMs = [int64]$job.started.Elapsed.TotalMilliseconds; error = $job.error; oom = $job.oom }
}

function Stop-ImageJob([string]$id) {
    $job = $script:imageJob
    if ($null -eq $job -or ($id -and $job.id -cne $id)) { return }
    if ($null -ne $job.run -and -not $job.run.Proc.HasExited) {
        try { $job.run.Proc.Kill() } catch { }
        [void]$job.run.Proc.WaitForExit(10000) # 書きかけのファイルを消せるよう、終わるまで待つ
    }
    if ($job.state -eq "running") { $job.state = "cancelled" }
    Remove-ImageJobFiles $job
    $script:imageJob = $null
}

# Invoke-ControlRequest が呼び元・キーを確かめたあとに呼ぶ。扱ったら $true
function Invoke-ImageRoute($context, [string]$route) {
    if ($route -eq 'POST /image/session/clear') {
        Stop-ImageJob ""
        Clear-ImageTemp
        Send-ControlResponse $context 200 @{ ok = $true }
        return $true
    }
    if ($route -eq "GET /image/status") {
        $models = @((Get-SharedImageInventory).items) # 直前に「モデルの一覧」で調べていれば、その結果を使う
        $usable = { param($m) @($models | Where-Object { $_.state -eq "ok" -and @($_.modes) -contains $m }).Count -gt 0 }
        $list = @($models | ForEach-Object { [ordered]@{ id = $_.id; label = $_.label; note = $_.note; modes = @($_.modes); translate = $_.translate; state = $_.state; problem = $_.problem; source = $_.source; verified = $_.verified; autoNote = [bool]$_.autoNote } })
        $engine = Test-Path -LiteralPath $script:imageEngine
        # GPU の名前は nvidia-smi を起動して調べる (実測 約 90ms、その間は受付が止まる)。画像を使える用意がある PC でだけ調べる
        $gpu = if ($engine -and $models.Count) { (Get-ImageGpu).name } else { "" }
        Send-ControlResponse $context 200 ([ordered]@{
            engine = $engine; generate = (& $usable "generate"); edit = (& $usable "edit")
            models = $list; dirs = (@(Get-ImageModelDirs) -join "`n"); gpu = $gpu
        })
        return $true
    }
    if ($route -eq "POST /image/jobs") {
        $req = Read-ImageRequest $context.Request
        $id = Start-ImageJob $req.params $req.image
        Send-ControlResponse $context 200 @{ id = $id }
        return $true
    }
    if ($route -match "^(GET|POST) /image/jobs/([0-9a-f]{32})(/result|/cancel)?$") {
        $id = $Matches[2]
        switch ("$($Matches[1]) $($Matches[3])") {
            "GET " { Send-ControlResponse $context 200 (Get-ImageJobInfo $id) }
            "GET /result" {
                $info = Get-ImageJobInfo $id
                if ($info.state -ne "done") { throw (L 'image.notReady') }
                $bytes = $script:imageJob.result
                $script:imageJob.result = $null
                try {
                    Stop-ImageJob $id
                    Send-ControlBytes $context $bytes "image/png"
                } finally { if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) } }
            }
            "POST /cancel" { Stop-ImageJob $id; Send-ControlResponse $context 200 @{ ok = $true } }
            default { Send-ControlResponse $context 404 @{ error = (L 'common.notFound') } }
        }
        return $true
    }
    return $false
}
