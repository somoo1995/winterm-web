# Build webterm.exe
#
#   .\build.ps1              regenerate icon + build exe + place it at the root
#   .\build.ps1 -NoIcon      exe only, leave the icon as-is
#   .\build.ps1 -Shortcut    build, then also create a Desktop shortcut
#
# Result: <root>\webterm.exe  <- double-click to start the daemon + web server and open the app window
#
# Save this file as UTF-8 with a BOM - PowerShell 5.1 reads BOM-less UTF-8 as ANSI, which
# garbles non-ASCII and breaks parsing.
param([switch]$NoIcon, [switch]$Shortcut)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Find-Python {
    # WindowsApps\python.exe on PATH is a Microsoft Store stub that dies instantly
    $c = Get-Command python -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

$py = Find-Python
if (-not $py) { Write-Host "Python not found" -ForegroundColor Red; return }

if (-not $NoIcon) {
    Write-Host "Generating icon..." -ForegroundColor Cyan
    & $py "$root\tools\make_icon.py"
}

# A running exe can't be overwritten - if it's up, say so first
$target = Join-Path $root "webterm.exe"
if (Test-Path $target) {
    try { Move-Item $target "$target.old" -Force; Remove-Item "$target.old" -Force -ErrorAction SilentlyContinue }
    catch { Write-Host "Can't replace webterm.exe (it may be running)" -ForegroundColor Yellow }
}

Write-Host "PyInstaller build..." -ForegroundColor Cyan
# --noconsole: no black console window.
#   Why the launcher can be console-less: the daemon creates the ConPTY, and the launcher starts
#   the daemon with CREATE_NO_WINDOW (which allocates a new console for the child). Starting the
#   daemon itself without a console makes ConPTY creation panic.
& $py -m PyInstaller `
    --onefile --noconsole --clean --noconfirm `
    --name webterm `
    --icon "$root\assets\webterm.ico" `
    --distpath "$root\build\dist" --workpath "$root\build\work" --specpath "$root\build" `
    "$root\launcher.py"
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; return }

Copy-Item "$root\build\dist\webterm.exe" $target -Force
$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "Build done: $target ($size MB)" -ForegroundColor Green

if ($Shortcut) {
    $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "webterm.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $target
    $s.WorkingDirectory = $root
    $s.IconLocation = Join-Path $root "assets\webterm.ico"
    $s.Description = "webterm - a direct-PTY web terminal"
    $s.Save()
    Write-Host "Shortcut created: $lnk" -ForegroundColor Green
}
