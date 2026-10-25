# CodeFlowKotlin native folder picker.
# Fixed, self-contained script: it takes NO arguments and interpolates no
# user-controlled values. It shows the native Windows FolderBrowserDialog on the
# current interactive desktop and writes a single compact JSON object to stdout:
#   {"status":"ok","path":"C:\\chosen\\folder"}  |  {"status":"cancel"}  |  {"status":"error","message":"..."}
# Run with:  powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File pick-folder.ps1
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select a project folder for CodeFlow'
    $dialog.ShowNewFolderButton = $true

    # A hidden, top-most owner form pulls the dialog to the foreground.
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.Opacity = 0
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.StartPosition = 'CenterScreen'
    $owner.Show()
    $owner.Activate()

    $result = $dialog.ShowDialog($owner)
    $owner.Close()
    $owner.Dispose()

    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
        $out = [ordered]@{ status = 'ok'; path = $dialog.SelectedPath }
    } else {
        $out = [ordered]@{ status = 'cancel' }
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Compress))
} catch {
    $err = [ordered]@{ status = 'error'; message = $_.Exception.Message }
    [Console]::Out.Write(($err | ConvertTo-Json -Compress))
}
