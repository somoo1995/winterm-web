# Update winterm-web in place (Windows).
#
#     powershell -ExecutionPolicy Bypass -File tools\update.ps1
#
# Two install shapes exist and only one of them can pull:
#   - cloned with git      -> git pull
#   - unpacked from a zip  -> no .git at all, so re-download and unpack over the top
#
# It deliberately does NOT restart anything. Which process needs restarting depends on what
# changed, and one of the answers closes every shell you have open - so it is reported, not done.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "winterm-web update  ($root)"
Write-Host ""

function Get-Code($which) {
    try { & python -c "import version; print(version.$which())" 2>$null } catch { "?" }
}

$beforeServer = Get-Code "server_code"
$beforeDaemon = Get-Code "daemon_code"

if (Test-Path ".git") {
    Write-Host "== git pull =="
    git pull --ff-only
} else {
    Write-Host "== downloading the latest zip (this install has no .git) =="
    $tmp = Join-Path $env:TEMP ("winterm-update-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp "src.zip"
    # curl.exe and tar.exe ship with Windows 10 1803+, same as the one-click installer relies on.
    & curl.exe -fsSL -o $zip "https://github.com/somoo1995/winterm-web/archive/refs/heads/main.zip"
    & tar.exe -xf $zip -C $tmp
    $inner = Get-ChildItem -Path $tmp -Directory -Filter "winterm-web-*" | Select-Object -First 1
    Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $root -Recurse -Force
    Remove-Item -Recurse -Force $tmp
}

Write-Host ""
Write-Host "== dependencies =="
# python -m pip, never pip.exe: Scripts\ is a separate PATH entry and is often missing.
& python -m pip install -q -r requirements.txt
Write-Host "ok"

$afterServer = Get-Code "server_code"
$afterDaemon = Get-Code "daemon_code"

Write-Host ""
Write-Host "== what to restart =="
if ($beforeDaemon -ne $afterDaemon) {
    Write-Host "  SESSION DAEMON changed -> restarting it CLOSES EVERY SHELL."
    Write-Host "      webterm.exe --stop-all   then   webterm.exe"
} elseif ($beforeServer -ne $afterServer) {
    Write-Host "  Web server changed -> restart it. Your open shells survive."
    Write-Host "      webterm.exe --restart"
} else {
    Write-Host "  No Python change - reload the page in the browser and you are done."
}
Write-Host "  (The app also shows this as a banner once you reload.)"
