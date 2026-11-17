# セッションの後片付け (start.ps1 から読み込む)
#   - 起動・終了時に旧履歴と専用プロファイルを上書き削除する。
#   - 保存アーカイブ・バックアップは作らない。残すかどうかの確認も出さない。
#   - 異常終了で残った作業領域は次回起動で片付け、失敗したら知らせる。

if (-not $function:L) { . ([IO.Path]::Combine($PSScriptRoot, 'lang.ps1')) } # 文言 (L 'キー')。start.ps1 から読み込んだときは読み込み済み
# C# の型を読み込む。コンパイル (C# コンパイラの起動で 1 回 0.2〜0.3 秒) は内容が変わったときだけ行い、
# 結果を .run\compiled に置いて次からはそれを読む (数十ミリ秒)。置けないときは、これまでどおりメモリ上でコンパイルする
function Import-CSharp([string]$typeName, [string]$source, [string[]]$references = @()) {
    if ($typeName -as [type]) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$source|$($references -join ',')|$([Environment]::Version)"))
    } finally { $sha.Dispose() }
    $hash = [BitConverter]::ToString($digest, 0, 8).Replace("-", "").ToLowerInvariant()
    $dir = [IO.Path]::Combine([IO.Path]::GetDirectoryName($PSScriptRoot), ".run\compiled") # Join-Path は使わない (ウィンドウを開く前に通る。Test-Exists の説明を参照)
    $dll = [IO.Path]::Combine($dir, "$typeName-$hash.dll")
    $refs = @{}
    if ($references.Count) { $refs.ReferencedAssemblies = $references }
    try {
        if (-not [IO.File]::Exists($dll)) {
            New-Item -ItemType Directory -Force $dir | Out-Null
            Get-ChildItem -LiteralPath $dir -Filter "$typeName-*.dll" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
            Add-Type -TypeDefinition $source @refs -OutputAssembly $dll -OutputType Library
        }
        [void][Reflection.Assembly]::LoadFrom($dll) # Add-Type -LiteralPath より初回が速い (起動時の4件で約70ms)
    } catch {
        if (-not ($typeName -as [type])) { Add-Type -TypeDefinition $source @refs }
    }
}

$script:WipingSuffix = ".wiping"

# ファイル・フォルダ・リンクがあるか。起動のたびに通る片付けの確認で Test-Path を使わないためのもの
# (Test-Path は最初の 1 回で Management モジュールを読み込む。約 60ms。実測)。
# リンク先が消えたリンクも「ある」と答える (Test-Path と同じ。片付けの対象から漏らさない)。確かめられないときも「ある」
function Test-Exists([string]$path) {
    if ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) { return $true }
    try { [void][IO.File]::GetAttributes($path); return $true }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $false }
    catch { return $true }
}

# WMI/CIMを使わず、問い合わせ可能なブラウザのコマンドラインを取得する。
$profileProcessSource = @'
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SimpllmProfileProcess {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr buffer, int size, out int needed);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    static bool UsesProfile(string command, string profile) {
        int count; IntPtr argv = CommandLineToArgvW(command, out count);
        if (argv == IntPtr.Zero) return false;
        try {
            for (int i = 1; i < count; i++) {
                string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
                if (arg.Equals("--user-data-dir=" + profile, StringComparison.OrdinalIgnoreCase)) return true;
                if (arg == "--user-data-dir" && i + 1 < count &&
                    Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, (i + 1) * IntPtr.Size)).Equals(profile, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        } finally { LocalFree(argv); }
    }
    public static Process[] Find(string profile) {
        List<Process> found = new List<Process>();
        foreach (string name in new string[] { "chrome", "msedge" }) {
            foreach (Process p in Process.GetProcessesByName(name)) {
                bool keep = false;
                IntPtr h = OpenProcess(0x1000, false, p.Id);
                if (h != IntPtr.Zero) {
                    IntPtr buffer = IntPtr.Zero;
                    try {
                        int needed;
                        NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out needed);
                        if (needed > 0 && needed < 1024 * 1024) {
                            buffer = Marshal.AllocHGlobal(needed);
                            if (NtQueryInformationProcess(h, 60, buffer, needed, out needed) == 0) {
                                int length = (ushort)Marshal.ReadInt16(buffer);
                                IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4);
                                long offset = text.ToInt64() - buffer.ToInt64();
                                if (offset >= 0 && offset + length <= needed) {
                                    string command = Marshal.PtrToStringUni(text, length / 2);
                                    keep = UsesProfile(command, profile);
                                }
                            }
                        }
                    } catch { } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); CloseHandle(h); }
                }
                if (keep) found.Add(p); else p.Dispose();
            }
        }
        return found.ToArray();
    }
}
'@

# プロファイルを使う主プロセスをハンドルで終了管理。取得できない子はファイル削除の再試行で扱う。
function Get-ProfileProcess([string]$profileDir) {
    if (-not ('SimpllmProfileProcess' -as [type])) { Import-CSharp 'SimpllmProfileProcess' $profileProcessSource }
    @([SimpllmProfileProcess]::Find($profileDir))
}

# 全プロセスの終了を待つ。残っていれば強制終了する (ファイルが開かれていると消せない)
# 列挙したProcessのハンドルは毎回解放し、長い終了待ちでも溜め込まない。
function Wait-ProfileClosed([string]$profileDir, [int]$timeoutSeconds = 10) {
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
        $killDeadline = $null
        while ($true) {
            $left = @(Get-ProfileProcess $profileDir)
            try {
                if ($left.Count -eq 0) { return }
                if ([DateTime]::UtcNow -ge $deadline) {
                    foreach ($process in $left) { try { $process.Kill() } catch { } }
                    if ($null -eq $killDeadline) { $killDeadline = [DateTime]::UtcNow.AddSeconds(5) }
                    elseif ([DateTime]::UtcNow -ge $killDeadline) { return }
                }
            } finally { foreach ($process in $left) { $process.Dispose() } }
            Start-Sleep -Milliseconds 200
        }
    } catch { } # 列挙に失敗しても削除を試す。使用中ならRemove-Wipedが再試行し、失敗を返す。
}

# --- 専用ウィンドウが閉じたかの判定 -------------------------------------------------------
# 起動したブラウザの Process だけに頼らない。2026-11-12・13 に、起動スクリプトがブラウザの参照を持たないまま
# 終了待ちを続け、ウィンドウを閉じてもサーバーが止まらないことがあった (原因は start.ps1 の引数 $Browser と変数 $browser が
# 同じ変数だったこと。変数名を分けて直した)。同じ種類の見落としに備えて、専用プロファイルを使うブラウザのプロセスも数え、一度見えた後に 2 回続けて見えなくなったら閉じたとみなす。
# 一度も見えないうちは (プロセスの列挙がうまくいかない PC でも誤って終了しないよう) プロファイルでは判定しない。
# プロセスの列挙は 1 回 約 11ms (実測。ブラウザのプロセス 19 個)。一度見えた後は備えでしかないので、間隔を 5 倍 (10 秒) に空ける
function New-BrowserWatch($process, [string]$profileDir, [double]$intervalSeconds = 2) {
    return @{ process = $process; profile = $profileDir; interval = $intervalSeconds; next = [DateTime]::MinValue; seen = $false; missing = 0; reason = '' }
}

# 閉じたら $true。理由は $watch.reason に入る
function Test-BrowserGone($watch) {
    if ($null -ne $watch.process) {
        try {
            if ($watch.process.HasExited) { $watch.reason = 'the started browser process exited'; return $true }
        } catch { } # 参照が使えなくなっていても、下のプロファイルで判定する
    }
    $now = [DateTime]::UtcNow
    if ($now -lt $watch.next) { return $false }
    $watch.next = $now.AddSeconds($(if ($watch.seen) { $watch.interval * 5 } else { $watch.interval }))
    $found = @()
    try { $found = @(Get-ProfileProcess $watch.profile) } catch { return $false } # 数えられないときは判定しない
    try {
        if ($found.Count -gt 0) {
            if (-not $watch.seen) {
                $watch.seen = $true
                $ids = ($found | ForEach-Object { $_.Id }) -join ','
                $started = if ($null -eq $watch.process) { 'none' } else { try { [string]$watch.process.Id } catch { 'unavailable' } }
                Write-SessionLog "browser seen through the profile: pids=$ids (started process: $started)"
            }
            $watch.missing = 0
            return $false
        }
    } finally { foreach ($p in $found) { $p.Dispose() } }
    if (-not $watch.seen) { return $false }
    $watch.missing++
    if ($watch.missing -lt 2) { return $false }
    $state = if ($null -eq $watch.process) { 'no started process' } else { try { "started process $($watch.process.Id) still reported running" } catch { 'started process unavailable' } }
    $watch.reason = "no browser uses the profile any more ($state)"
    return $true
}

# 終了の手順を調べるための記録 (.run\last-session.log。起動のたびに上書き)。
# 書くのは時刻・手順・プロセス番号だけ。URL・キー・コマンドライン・会話の内容は書かない
$script:sessionLogPath = $null
function Write-SessionLog([string]$text) {
    if (-not $script:sessionLogPath) { return }
    try { [IO.File]::AppendAllText($script:sessionLogPath, ('{0:yyyy-MM-dd HH:mm:ss.fff} {1}' -f [DateTime]::Now, $text) + "`r`n") } catch { }
}

# 乱数で上書きしてから消す。HDD では中身の復元を難しくするが、SSD や NTFS のジャーナルまでは保証できない
# 名前を変えられない (= 誰かが開いている) ときは、何も壊さず $false を返す
function Remove-Wiped([string]$path) {
    $doomed = "$path$($script:WipingSuffix)"
    if (Test-Exists $path) {
        if ((Test-Path -LiteralPath $doomed) -and -not (Remove-Doomed $doomed)) { return $false }
        try { Rename-Item -LiteralPath $path -NewName (Split-Path $doomed -Leaf) -Force -ErrorAction Stop } catch { return $false }
    }
    return Remove-Doomed $doomed
}

# 名前を変えた後の実体を消す。ここに来たものは、もう保存データとして使われない
function Remove-Doomed([string]$doomed) {
    if (-not (Test-Exists $doomed)) { return $true }
    # ジャンクション・シンボリックリンクなら、リンクだけを消す (リンク先のアプリ外のファイルを上書きしない)
    $item = Get-Item -LiteralPath $doomed -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        try {
            if ($item.PSIsContainer) { [IO.Directory]::Delete($doomed, $false) } else { [IO.File]::Delete($doomed) }
        } catch { }
        return -not (Test-Path -LiteralPath $doomed)
    }
    $files = if ($item.PSIsContainer) {
        @(Get-ChildItem -LiteralPath $doomed -Recurse -Force -File -ErrorAction SilentlyContinue |
            Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    } else { @($item) }
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buffer = New-Object byte[] 1048576
    foreach ($file in $files) {
        try {
            $stream = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
            try {
                $left = $stream.Length
                while ($left -gt 0) {
                    $count = [int][Math]::Min($left, $buffer.Length)
                    $rng.GetBytes($buffer, 0, $count) # 小さいファイルのために 1MB 分の乱数を作らない
                    $stream.Write($buffer, 0, $count)
                    $left -= $count
                }
            } finally { $stream.Dispose() }
        } catch { } # 上書きできなくても、下の削除は試す
    }
    $rng.Dispose()
    for ($i = 0; $i -lt 10; $i++) {
        try { Remove-Item -LiteralPath $doomed -Recurse -Force -ErrorAction Stop } catch { }
        if (-not (Test-Path -LiteralPath $doomed)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# 初回の起動時に、デスクトップへアイコン付きのショートカットを作る (.bat / .ps1 自体はアイコンを持てない)
# 作成済みの記録を残し、利用者が消したショートカットは作り直さない。フォルダを移動したときだけ、もう一度作る
# 失敗しても起動は止めない
function Install-DesktopShortcut([string]$root, [string]$markerPath, [string]$desktop = [Environment]::GetFolderPath("Desktop")) {
    try {
        # 記録の 2 は「最小化で開く」設定のショートカット。以前の記録なら、残っているものだけ更新する
        $current = "$root|2"
        $recorded = if (Test-Path -LiteralPath $markerPath) { [IO.File]::ReadAllText($markerPath) } else { "" }
        if ($recorded -eq $current) { return }
        if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { return }
        $target = [IO.Path]::Combine($root, "start.bat")
        $link = [IO.Path]::Combine($desktop, "simpllm.lnk")
        if ($recorded -eq $root -and -not (Test-Path -LiteralPath $link)) { # 利用者が消したものは作り直さない
            [IO.File]::WriteAllText($markerPath, $current)
            return
        }
        $shell = New-Object -ComObject WScript.Shell
        $replace = $true
        if (Test-Path -LiteralPath $link) {
            # 同じ名前の別のショートカットは上書きしない (移動前の simpllm を指す、切れたものは置き換える)
            $existing = $shell.CreateShortcut($link).TargetPath
            if ($existing -ne $target -and $existing -and (Test-Path -LiteralPath $existing)) { $replace = $false }
        }
        if ($replace) {
            $shortcut = $shell.CreateShortcut($link)
            $shortcut.TargetPath = $target
            $shortcut.WorkingDirectory = $root
            $shortcut.Description = (L 'shortcut.description')
            $shortcut.WindowStyle = 7 # 最小化: 起動用の黒い画面を一瞬でも見せない
            $icon = [IO.Path]::Combine($root, "simpllm.ico")
            if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
            $shortcut.Save()
            Write-Host (L 'shortcut.created' @{ path = $link })
        }
        New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($markerPath)) | Out-Null
        [IO.File]::WriteAllText($markerPath, $current)
    } catch {
        Write-Host (L 'shortcut.failed' @{ error = $_.Exception.Message }) -ForegroundColor Yellow
    }
}

# --- 独自デザインのポップアップ -------------------------------------------------------
# 枠なしのウィンドウにチャット画面と同じ配色で描く。通知が必要なときだけ読み込む。
function Initialize-Dialog {
    if ("SimpllmDialog" -as [type]) { return }
    Import-CSharp "SimpllmDialog" -references @("System.Windows.Forms", "System.Drawing") -source @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SimpllmDialog {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);

    static bool ready;
    // 文字のフォント。表示言語に合わせて呼び出し側が入れる (無いフォントの名前なら Windows が代わりを選ぶ)
    public static string FontName = "Segoe UI";
    static readonly Color Back = Color.FromArgb(0x17, 0x17, 0x17);
    static readonly Color Line = Color.FromArgb(0x2a, 0x2a, 0x2a);
    static readonly Color TextColor = Color.FromArgb(0xec, 0xec, 0xec);
    static readonly Color Sub = Color.FromArgb(0xb4, 0xb4, 0xb4);

    // 押されたボタンの番号を返す。Esc と Alt+F4 は cancelIndex を返す
    public static int Show(string title, string heading, string body, string[] labels, int defaultIndex, int cancelIndex, string iconPath) {
        if (!ready) {
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            ready = true;
        }
        using (var form = new DialogForm(title, heading, body, labels, defaultIndex, cancelIndex, iconPath)) {
            form.ShowDialog();
            return form.Result;
        }
    }

    sealed class Pill : Button {
        public bool Primary;
        bool hover;
        public Pill() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Cursor = Cursors.Hand;
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Back);
            Color fill = Primary ? (hover ? Color.FromArgb(0xd4, 0xd4, 0xd4) : Color.FromArgb(0xf5, 0xf5, 0xf5)) : (hover ? Color.FromArgb(0x33, 0x33, 0x33) : Color.FromArgb(0x26, 0x26, 0x26));
            Color ink = Primary ? Color.Black : TextColor;
            var r = new RectangleF(1, 1, Width - 3, Height - 3);
            float d = r.Height;
            using (var path = new GraphicsPath()) {
                path.AddArc(r.X, r.Y, d, d, 90, 180);
                path.AddArc(r.Right - d, r.Y, d, d, 270, 180);
                path.CloseFigure();
                using (var b = new SolidBrush(fill)) g.FillPath(b, path);
                if (Focused) using (var p = new Pen(Color.FromArgb(0x8a, 0x8a, 0x8a), 1.5f)) g.DrawPath(p, path);
            }
            TextRenderer.DrawText(g, base.Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    sealed class DialogForm : Form {
        public int Result;
        readonly string heading, body;
        readonly Bitmap icon;
        readonly Font headingFont, bodyFont;
        readonly Rectangle iconRect, headingRect, bodyRect;

        protected override CreateParams CreateParams {
            get { var p = base.CreateParams; p.ClassStyle |= 0x20000; return p; } // 影を付ける
        }

        public DialogForm(string title, string headingText, string bodyText, string[] labels, int defaultIndex, int cancelIndex, string iconPath) {
            heading = headingText;
            body = bodyText;
            Result = cancelIndex;
            Text = title;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            ShowInTaskbar = true;
            BackColor = Back;
            DoubleBuffered = true;
            KeyPreview = true;
            float s;
            using (var g = CreateGraphics()) s = g.DpiX / 96f;
            headingFont = new Font(FontName, 13f, FontStyle.Bold);
            bodyFont = new Font(FontName, 10f);
            Font = new Font(FontName, 10f);
            if (!string.IsNullOrEmpty(iconPath) && System.IO.File.Exists(iconPath)) {
                try {
                    int size = (int)(48 * s);
                    using (var ic = new Icon(iconPath, size, size)) icon = ic.ToBitmap();
                    Icon = new Icon(iconPath);
                } catch { icon = null; }
            }
            int pad = (int)(24 * s), gap = (int)(16 * s), width = (int)(460 * s);
            int iconSize = icon == null ? 0 : (int)(48 * s);
            int textLeft = pad + (icon == null ? 0 : iconSize + gap);
            int textWidth = width - textLeft - pad;
            var flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
            var hs = TextRenderer.MeasureText(heading, headingFont, new Size(textWidth, 0), flags);
            var bs = string.IsNullOrEmpty(body) ? Size.Empty : TextRenderer.MeasureText(body, bodyFont, new Size(textWidth, 0), flags);
            iconRect = new Rectangle(pad, pad, iconSize, iconSize);
            headingRect = new Rectangle(textLeft, pad, textWidth, hs.Height);
            bodyRect = new Rectangle(textLeft, pad + hs.Height + (int)(8 * s), textWidth, bs.Height);
            int contentBottom = Math.Max(iconRect.Bottom, bodyRect.Bottom);
            int buttonH = (int)(36 * s), buttonTop = contentBottom + (int)(20 * s);
            ClientSize = new Size(width, buttonTop + buttonH + pad);
            int right = width - pad;
            for (int i = labels.Length - 1; i >= 0; i--) {
                var b = new Pill { Text = labels[i], Primary = i == defaultIndex };
                int w = Math.Max((int)(84 * s), TextRenderer.MeasureText(labels[i], Font).Width + (int)(36 * s));
                b.SetBounds(right - w, buttonTop, w, buttonH);
                right -= w + (int)(8 * s);
                int index = i;
                b.Click += delegate { Result = index; Close(); };
                Controls.Add(b);
                if (i == defaultIndex) { AcceptButton = b; ActiveControl = b; }
                if (i == cancelIndex) CancelButton = b;
            }
            MouseDown += delegate(object o, MouseEventArgs e) { // 枠がないので、どこを持っても動かせるようにする
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
            };
        }

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            int round = 2;
            try { DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch { } // Windows 11 の角丸 (古い Windows では無視される)
            // 裏で動いているプロセスからは前面に出せないことがあるので、前面のスレッドに一時的につなぐ
            uint other = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            uint self = GetCurrentThreadId();
            bool attached = other != 0 && other != self && AttachThreadInput(self, other, true);
            SetForegroundWindow(Handle);
            Activate();
            if (attached) AttachThreadInput(self, other, false);
            if (ActiveControl != null) ActiveControl.Focus();
        }

        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            var g = e.Graphics;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            using (var p = new Pen(Line)) g.DrawRectangle(p, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
            if (icon != null) g.DrawImage(icon, iconRect);
            var flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
            TextRenderer.DrawText(g, heading, headingFont, headingRect, TextColor, flags);
            if (!string.IsNullOrEmpty(body)) TextRenderer.DrawText(g, body, bodyFont, bodyRect, Sub, flags);
        }

        protected override void Dispose(bool disposing) {
            if (disposing) {
                if (icon != null) icon.Dispose();
                headingFont.Dispose();
                bodyFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
"@
}

# エラーなどの知らせ。コンソールがない起動でも読めるようにする
function Show-MessageDialog([string]$heading, [string]$body = "") {
    try {
        Initialize-Dialog
        [SimpllmDialog]::FontName = L 'dialog.font'
        [void][SimpllmDialog]::Show("simpllm", $heading, $body, [string[]]@((L 'dialog.close')), 0, 0, (Join-Path ([IO.Path]::GetDirectoryName($PSScriptRoot)) "simpllm.ico"))
    } catch { }
}

# 専用プロファイルを消す (ブラウザ側のデータは残さない)。消すのは start.bat のあるフォルダの browser-profile だけ
function Close-Session([string]$profileDir) {
    $workspace = [IO.Path]::GetFullPath(([IO.Path]::GetDirectoryName($PSScriptRoot))).TrimEnd('\') + '\' # start.bat のあるフォルダ
    $profile = [IO.Path]::GetFullPath($profileDir)
    if (-not $profile.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($profile) -ine 'browser-profile') { throw (L 'cleanup.badTarget') }
    if (Test-Exists $profileDir) { Wait-ProfileClosed $profileDir }
    # 前回の削除が途中で止まっていたら、その残りから片付ける
    if (-not (Remove-Doomed "$profileDir$($script:WipingSuffix)")) { return $false }
    return Remove-Wiped $profileDir
}
