# Update winterm-web in place (Windows).
#
#     powershell -ExecutionPolicy Bypass -File tools\update.ps1        (by hand)
#     POST /api/update  ->  the in-app "Update" button runs this file detached (updatecheck.py)
#
# Two install shapes exist and only one of them can pull:
#   - cloned with git      -> git pull
#   - unpacked from a zip  -> no .git at all, so re-download and copy over the top
#
# It deliberately does NOT restart anything. Which process needs restarting depends on what
# changed, and one of the answers closes every shell you have open - so it is reported, not done
# (on the console here, and by the in-app banner after a reload).
#
# Writes .installed-commit (the sha of main these files came from) so the "new version available"
# check has something exact to compare. Progress also goes to update.log, since the in-app path
# has no console to read.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$REPO = "somoo1995/winterm-web"
$LOG = Join-Path $root "update.log"
function Say($m) {
    Write-Host $m
    try { Add-Content -Path $LOG -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) -Encoding UTF8 } catch {}
}
Say "winterm-web update  ($root)"

function Find-Python {
    $c = Get-Command python -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -and $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}
$py = Find-Python

function Get-Code($which) {
    if (-not $py) { return "?" }
    try { & $py -c "import version; print(version.$which())" 2>$null } catch { "?" }
}

$beforeServer = Get-Code "server_code"
$beforeDaemon = Get-Code "daemon_code"

$tmp = $null
try {
    if (Test-Path ".git") {
        Say "== git pull =="
        git pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
    } else {
        Say "== downloading the latest zip (this install has no .git) =="
        # The sha first, so the marker matches what is downloaded (best effort: offline = no marker).
        $sha = ""
        try {
            $j = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$REPO/commits/main" `
                 -Headers @{ "User-Agent" = "webterm-update" } -TimeoutSec 15
            $sha = $j.sha
        } catch { Say "  (could not read the latest commit sha: $($_.Exception.Message))" }

        $tmp = Join-Path $env:TEMP ("winterm-update-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $zip = Join-Path $tmp "src.zip"
        # curl.exe and tar.exe ship with Windows 10 1803+, same as the one-click installer relies on.
        & curl.exe -fsSL -o $zip "https://github.com/$REPO/archive/refs/heads/main.zip"
        if ($LASTEXITCODE -ne 0) { throw "download failed" }
        & tar.exe -xf $zip -C $tmp
        if ($LASTEXITCODE -ne 0) { throw "extract failed" }
        $inner = Get-ChildItem -Path $tmp -Directory -Filter "winterm-web-*" | Select-Object -First 1
        if (-not $inner) { throw "no winterm-web-* folder inside the zip" }

        # robocopy, not Copy-Item: user data must survive (config.json, logs, the marker, session
        # files), and a locked file (webterm.exe while it runs) must not hang the copy - /R:2 /W:1.
        # No /XO: the zip carries commit-time mtimes, which can be OLDER than the files here.
        robocopy $inner.FullName $root /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP `
            /XF config.json .installed-commit *.log webterm-sessions*.json `
            /XD __pycache__ .git build _backup docs | Out-Null
        $rc = $LASTEXITCODE
        # robocopy: < 8 is success (1 = copied, 2/4 = extras/mismatches). 8+ = some file failed,
        # which here is normally just the running webterm.exe; it updates on its next launch.
        if ($rc -ge 8) { Say "  copied with failures (robocopy $rc) - a locked file such as webterm.exe is expected" }
        else           { Say "  copied (robocopy $rc)" }

        if ($sha) {
            Set-Content -Path (Join-Path $root ".installed-commit") -Value $sha -Encoding ASCII -NoNewline
            Say "  installed commit: $($sha.Substring(0, 8))"
        }
    }

    Say ""
    Say "== dependencies =="
    if ($py) {
        # python -m pip, never pip.exe: Scripts\ is a separate PATH entry and is often missing.
        $env:PYTHONUTF8 = "1"
        & $py -m pip install --disable-pip-version-check -q -r requirements.txt
        Say "ok"
    } else {
        Say "  python not found - skipped (run install.bat if the server fails to start)"
    }

    $afterServer = Get-Code "server_code"
    $afterDaemon = Get-Code "daemon_code"

    Say ""
    Say "== what to restart =="
    if ($beforeDaemon -ne $afterDaemon) {
        Say "  SESSION DAEMON changed -> restarting it CLOSES EVERY SHELL."
        Say "      webterm.exe --stop-all   then   webterm.exe"
    } elseif ($beforeServer -ne $afterServer) {
        Say "  Web server changed -> restart it. Your open shells survive."
        Say "      webterm.exe --restart"
    } else {
        Say "  No Python change - reload the page in the browser and you are done."
    }
    Say "  (The app also shows this as a banner, with a button for the web server.)"
} catch {
    Say "FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
