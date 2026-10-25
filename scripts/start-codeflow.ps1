param(
    [switch]$NoBrowser,
    [string]$ProjectsRoot = (Join-Path $env:USERPROFILE 'AndroidStudioProjects')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$codeflowRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$codeflowUrl = 'http://127.0.0.1:4173/'
$mutex = New-Object Threading.Mutex($false, 'Local\CodeFlowKotlin.Port4173.Launch')
$acquired = $false

function Get-CodeFlowRuntime {
    try {
        return Invoke-RestMethod -Uri ($codeflowUrl + '__codeflow/runtime') -TimeoutSec 2
    } catch {
        return $null
    }
}

function Assert-CodeFlowRuntime($Runtime) {
    if ($Runtime.app -ne 'CodeFlowKotlin' -or
        [IO.Path]::GetFullPath($Runtime.uiRoot).TrimEnd('\','/') -ne $codeflowRoot.TrimEnd('\','/')) {
        throw 'Port 4173 belongs to another application or another CodeFlow checkout. It was left untouched.'
    }
}

try {
    try { $acquired = $mutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (!$acquired) { throw 'Another CodeFlow launch is still in progress. Try again shortly.' }

    $runtime = Get-CodeFlowRuntime
    $started = $false
    if ($null -eq $runtime) {
        $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw 'Port 4173 is already occupied. No existing process was stopped.' }
        if (!(Test-Path -LiteralPath $ProjectsRoot -PathType Container)) {
            throw 'The projects directory is missing. Set ProjectsRoot when running this launcher.'
        }
        $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
        $entryPoint = Join-Path $codeflowRoot 'server\projects-server.mjs'
        $logDirectory = Join-Path $env:LOCALAPPDATA 'CodeFlowKotlin'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        # Windows Start-Process joins arguments; quote these two known paths so
        # spaces and Unicode survive. The server is independent of this launcher/IDE.
        $serverProcess = Start-Process -FilePath $nodePath `
            -ArgumentList @(('"' + $entryPoint + '"'), ('"' + [IO.Path]::GetFullPath($ProjectsRoot) + '"')) `
            -WorkingDirectory $codeflowRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDirectory 'server.log') `
            -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        do {
            Start-Sleep -Milliseconds 300
            $runtime = Get-CodeFlowRuntime
            if ($null -ne $runtime) { break }
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) { throw "CodeFlow could not start. See $logDirectory\server-error.log" }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -eq $runtime) { throw "CodeFlow did not become ready. See $logDirectory\server-error.log" }
        $started = $true
    }
    Assert-CodeFlowRuntime $runtime
    if (!$NoBrowser) { Start-Process -FilePath $codeflowUrl }
    [pscustomobject]@{ Url = $codeflowUrl; StartedServer = $started; ProcessId = $runtime.processId; BrowserRequested = !$NoBrowser }
} catch {
    if (!$NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'CodeFlowKotlin', 'OK', 'Error') | Out-Null
    }
    throw
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
