# webterm.exe 빌드
#
#   .\build.ps1              아이콘 재생성 + exe 빌드 + 루트에 배치
#   .\build.ps1 -NoIcon      아이콘은 그대로 두고 exe 만
#   .\build.ps1 -Shortcut    빌드 후 바탕화면 바로가기까지 생성
#
# 결과: <루트>\webterm.exe  ← 더블클릭하면 데몬·웹서버 기동 후 앱 창이 열린다
#
# ⚠ 이 파일은 UTF-8 **BOM** 으로 저장해야 한다 — PowerShell 5.1 은 BOM 없는 UTF-8 을
#   ANSI 로 읽어 한글 주석이 깨지고 파싱이 어긋난다.
param([switch]$NoIcon, [switch]$Shortcut)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Find-Python {
    # ⚠ PATH 의 WindowsApps\python.exe 는 Microsoft Store 스텁이라 즉시 죽는다
    $c = Get-Command python -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

$py = Find-Python
if (-not $py) { Write-Host "python 을 찾지 못했습니다" -ForegroundColor Red; return }

if (-not $NoIcon) {
    Write-Host "아이콘 생성..." -ForegroundColor Cyan
    & $py "$root\tools\make_icon.py"
}

# 실행 중인 exe 는 덮어쓸 수 없다 — 켜져 있으면 먼저 알려준다
$target = Join-Path $root "webterm.exe"
if (Test-Path $target) {
    try { Move-Item $target "$target.old" -Force; Remove-Item "$target.old" -Force -ErrorAction SilentlyContinue }
    catch { Write-Host "webterm.exe 를 교체할 수 없습니다(실행 중일 수 있음)" -ForegroundColor Yellow }
}

Write-Host "PyInstaller 빌드..." -ForegroundColor Cyan
# --noconsole : 검은 콘솔 창이 뜨지 않는다.
#   ⚠ 런처가 콘솔이 없어도 되는 이유 — ConPTY 를 만드는 것은 데몬이고, 런처는 데몬을
#     CREATE_NO_WINDOW 로 띄운다(자식에게 새 콘솔이 할당된다). 데몬 자체를 콘솔 없이
#     띄우면 ConPTY 생성이 패닉한다.
& $py -m PyInstaller `
    --onefile --noconsole --clean --noconfirm `
    --name webterm `
    --icon "$root\assets\webterm.ico" `
    --distpath "$root\build\dist" --workpath "$root\build\work" --specpath "$root\build" `
    "$root\launcher.py"
if ($LASTEXITCODE -ne 0) { Write-Host "빌드 실패" -ForegroundColor Red; return }

Copy-Item "$root\build\dist\webterm.exe" $target -Force
$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "빌드 완료: $target ($size MB)" -ForegroundColor Green

if ($Shortcut) {
    $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "webterm.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $target
    $s.WorkingDirectory = $root
    $s.IconLocation = Join-Path $root "assets\webterm.ico"
    $s.Description = "webterm - PTY 직결 웹 터미널"
    $s.Save()
    Write-Host "바로가기 생성: $lnk" -ForegroundColor Green
}
