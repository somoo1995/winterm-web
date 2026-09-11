<#
  Entry point called by the Desktop shortcut.
  Starts the server if it's down; if it's already up, opens the browser without touching it.
#>
$ErrorActionPreference = "SilentlyContinue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
$url  = "http://127.0.0.1:$port"

# Match ONLY the 127.0.0.1 binding - tailscale serve listens on the same port on 100.x too.
$live = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1

if (-not $live) {
    # Only start it when it's down. Running start.ps1 while it's up restarts the web server
    # and briefly drops any attached browser (sessions survive, but there's no reason to jolt it).
    & (Join-Path $ROOT "start.ps1") | Out-Null
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        try { if ((Invoke-RestMethod "$url/api/health" -TimeoutSec 2).ok) { break } } catch {}
    }
}
Start-Process $url
