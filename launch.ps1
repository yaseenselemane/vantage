# Open vantage: show the dashboard, starting the agent in the background first
# if it is not already running. This is what the desktop shortcut runs.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:8123"

try {
  # 127.0.0.1, not localhost: the agent listens on IPv4 only and localhost tries ::1 first (~2s).
  Invoke-WebRequest "http://127.0.0.1:8123/api/v1/snapshot" -UseBasicParsing -TimeoutSec 3 | Out-Null
  Start-Process $url
  exit
} catch {}

# Not running: start it hidden. The agent opens the browser itself once it is up.
Start-Process node -ArgumentList "`"$here\agent.mjs`"" -WorkingDirectory $here -WindowStyle Hidden
