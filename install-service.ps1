# Makes vantage automatic:
#   1. starts the agent hidden at every login (and restarts it if it crashes)
#   2. puts a "vantage" shortcut on the Desktop and in the Start menu
#   3. saves the router login to config.local.json so the agent can use it
# Run once:  powershell -ExecutionPolicy Bypass -File install-service.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"

# Router login — typed here, stored only in this folder (gitignored).
$cfg = Join-Path $here "config.local.json"
if (-not (Test-Path $cfg)) {
  $sec = Read-Host "Router admin password (Enter to skip)" -AsSecureString
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ($pass) {
    @{ router = @{ user = "admin"; pass = $pass } } | ConvertTo-Json | Set-Content -Path $cfg -Encoding UTF8
    Write-Host "Saved router login to config.local.json"
  }
}

# Login task: hidden window, no browser pop-up at login.
$arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$node' '$here\agent.mjs' --no-browser; exit `$LASTEXITCODE`""
$action = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "vantage-agent" -Action $action -Trigger $trigger -Settings $settings -Description "vantage network monitor" -Force | Out-Null
Start-ScheduledTask -TaskName "vantage-agent"

# Shortcuts that open the dashboard (and start the agent if it is not running).
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "vantage.lnk"))
  $lnk.TargetPath = $ps
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\launch.ps1`""
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation = "$env:WINDIR\System32\shell32.dll,18"
  $lnk.Description = "Open the vantage network dashboard"
  $lnk.Save()
}

Write-Host "vantage is installed: it runs from login, and the 'vantage' shortcut opens the dashboard."
Write-Host "Dashboard: http://localhost:8123"
Write-Host "Remove with: Unregister-ScheduledTask -TaskName vantage-agent -Confirm:`$false"
