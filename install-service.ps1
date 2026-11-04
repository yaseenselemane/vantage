# Runs the vantage agent in the background at every login, so it monitors
# 24/7 instead of only while a console window is open.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$here\agent.mjs`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "vantage-agent" -Action $action -Trigger $trigger -Settings $settings -Description "vantage network monitor" -Force | Out-Null

Start-ScheduledTask -TaskName "vantage-agent"
Write-Host "vantage is now installed. It starts at login and restarts if it crashes."
Write-Host "Dashboard: http://localhost:8123"
Write-Host "Remove with: Unregister-ScheduledTask -TaskName vantage-agent -Confirm:`$false"
