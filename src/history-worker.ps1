# A single persistent runspace preserves write ordering, without blocking image
# progress/cancel or the browser lifetime loop on history disk/network I/O.
# The routes themselves live in Invoke-BackgroundRoute: the worker runs it, and the
# control thread runs the same function when the worker is gone (it failed to start,
# died, or was stopped with work still queued).

function Test-BackgroundRoute([string]$route) {
    return $route -match '^(GET|POST) /history' -or $route -ceq 'GET /models/inventory' -or $route -ceq 'GET /image/status' -or $route -ceq 'POST /models/catalog' -or $route -ceq 'POST /model-dir/browse'
}

function Read-BackgroundJson($request, [int]$maxBytes) {
    if ($request.ContentLength64 -le 0 -or $request.ContentLength64 -gt $maxBytes) { throw (L 'common.badBodySize') }
    return ([Text.UTF8Encoding]::new($false)).GetString((Read-HistoryBody $request $maxBytes)) | ConvertFrom-Json
}

# Always answers the request (errors included), so a caller never leaves a context open.
function Invoke-BackgroundRoute($context, [string]$route, [bool]$modelFixed) {
    try {
        if ($route -ceq 'GET /models/inventory') { Send-ControlBytes $context (Get-ModelInventoryJson) 'application/json; charset=utf-8'; return }
        if ($route -ceq 'GET /image/status') { [void](Invoke-ImageRoute $context $route); return }
        if ($route -ceq 'POST /model-dir/browse') {
            if ($modelFixed) { throw (L 'models.fixed') }
            $body = Read-BackgroundJson $context.Request 8192
            Send-ControlResponse $context 200 @{ path = (Select-ModelFolder ([string]$body.path) (L 'models.browseTitle')) }
            return
        }
        if ($route -ceq 'POST /models/catalog') {
            # 設定画面から、モデルの設定を保存・削除する。内容は models.ps1 が検証してから model-settings.json に書く
            # (画像の処理中に保存しても、使われるのは次の処理から)
            $body = Read-BackgroundJson $context.Request 65536
            switch ([string]$body.action) {
                'save' { Set-CatalogEntry ([string]$body.kind) $body.entry }
                'delete' { Remove-CatalogEntry ([string]$body.kind) ([string]$body.key) }
                default { throw (L 'control.badAction') }
            }
            Send-ControlBytes $context (Get-ModelInventoryJson) 'application/json; charset=utf-8'
            return
        }
        if (-not (Invoke-HistoryRoute $context $route)) { Send-ControlResponse $context 404 @{ error = (L 'common.notFound') } }
    } catch {
        # 読み書きの失敗 (ファイルが一時的に使用中・ディスクがいっぱい) は 503。UI は 400 だけを「受け付けられない内容」として再送しない
        $status = 400
        for ($e = $_.Exception; $null -ne $e; $e = $e.InnerException) {
            if ($e -is [IO.IOException] -or $e -is [UnauthorizedAccessException]) { $status = 503; break }
        }
        Send-ControlResponse $context $status @{ error = $_.Exception.Message }
    }
}

function Start-HistoryWorker {
    param([string]$HistoryRoot = $historyDir)
    if ($null -eq $control) { return }
    $queue = [Collections.Concurrent.BlockingCollection[object]]::new(256)
    $shared = [hashtable]::Synchronized(@{ stopping = $false })
    $runspace = [RunspaceFactory]::CreateRunspace()
    $runspace.ApartmentState = 'STA'
    $runspace.Open()
    $pipeline = [PowerShell]::Create()
    $pipeline.Runspace = $runspace
    [void]$pipeline.AddScript({
        param($src, $appOrigin, $problem, $queue, $shared, $respond, $send, $browse, $store)
        # A new runspace starts with 'Continue': a failed cmdlet would be reported as success.
        $ErrorActionPreference = 'Stop'
        $utf8 = [Text.UTF8Encoding]::new($false)
        Set-Item Function:Send-ControlResponse ([scriptblock]::Create($respond))
        Set-Item Function:Send-ControlBytes ([scriptblock]::Create($send))
        Set-Item Function:Select-ModelFolder ([scriptblock]::Create($browse))
        . (Join-Path $src 'session.ps1')
        . (Join-Path $src 'history.ps1')
        . (Join-Path $src 'models.ps1')
        . (Join-Path $src 'image.ps1')
        . (Join-Path $src 'history-worker.ps1')
        $historyDir = $store
        $historyChats = Join-Path $store 'chats'
        $historyImages = Join-Path $store 'images'
        $historyMeta = Join-Path $store 'meta.json'
        $script:historyProblem = $problem
        $script:historyShared = $shared
        foreach ($work in $queue.GetConsumingEnumerable()) {
            $context = $work.context
            try {
                # While shutting down only the writes matter; nobody is left to read an answer.
                if ($shared.stopping -and $context.Request.HttpMethod -ceq 'GET') { Send-ControlResponse $context 503 @{ error = '' }; continue }
                $requestedLanguage = if ($work.language) { $work.language } elseif ($work.languageHint) { Resolve-Language $work.languageHint } else { $script:language }
                if ($script:modelDir -cne $work.modelDir -or $script:language -cne $requestedLanguage) { Clear-ImageInventoryCache }
                $script:modelDir = $work.modelDir
                if ($requestedLanguage) { $script:language = $requestedLanguage }
                Invoke-BackgroundRoute $context "$($context.Request.HttpMethod) $($context.Request.Url.AbsolutePath)" ([bool]$work.modelFixed)
            } catch {
                Send-ControlResponse $context 503 @{ error = $_.Exception.Message }
            }
        }
    }.ToString()).AddArgument($PSScriptRoot).AddArgument($appOrigin).AddArgument($historyProblem).AddArgument($queue).AddArgument($shared).AddArgument(${function:Send-ControlResponse}.ToString()).AddArgument(${function:Send-ControlBytes}.ToString()).AddArgument(${function:Select-ModelFolder}.ToString()).AddArgument($HistoryRoot)
    $script:historyWorker = @{ queue = $queue; shared = $shared; pipeline = $pipeline; runspace = $runspace; pending = $pipeline.BeginInvoke() }
}

# Hands a request to the worker. $false: there is no live worker, and the caller handles the
# request itself. A worker that ended on its own is retired here, together with what it left queued.
function Send-HistoryWork($work) {
    $worker = $script:historyWorker
    if ($null -eq $worker) { return $false }
    if ($worker.pending.IsCompleted) { Stop-HistoryWorker -KeepReads; return $false }
    if (-not $worker.queue.TryAdd($work)) { Send-ControlResponse $work.context 503 @{ error = (L 'common.incomplete') } }
    return $true
}

# -KeepReads: the session goes on without the worker, so queued reads are answered too.
function Stop-HistoryWorker([switch]$KeepReads) {
    $worker = $script:historyWorker
    if ($null -eq $worker) { return }
    $script:historyWorker = $null
    $worker.shared.stopping = -not $KeepReads
    $worker.queue.CompleteAdding()
    # Queued saves are finished, not dropped. A healthy worker drains in well under a second;
    # the long wait is for a first-time index build or a large save.
    $stopped = $worker.pending.AsyncWaitHandle.WaitOne(30000)
    if (-not $stopped) {
        # Stop() does not return while the worker sits in a modal dialog, so do not wait on it forever.
        try { $stopped = $worker.pipeline.BeginStop($null, $null).AsyncWaitHandle.WaitOne(2000) } catch { }
    }
    # Whatever is still queued (the worker died, or is stuck) is written here, in order.
    $work = $null
    while ($worker.queue.TryTake([ref]$work)) {
        $context = $work.context
        if (-not $KeepReads -and $context.Request.HttpMethod -ceq 'GET') { Send-ControlResponse $context 503 @{ error = '' }; continue }
        Invoke-BackgroundRoute $context "$($context.Request.HttpMethod) $($context.Request.Url.AbsolutePath)" ([bool]$work.modelFixed)
    }
    if ($stopped) {
        try { [void]$worker.pipeline.EndInvoke($worker.pending) } catch { }
        $worker.pipeline.Dispose(); $worker.runspace.Dispose(); $worker.queue.Dispose()
    }
}
