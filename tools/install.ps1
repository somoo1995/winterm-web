<#
  winterm-web 설치 스크립트

  install.bat 이 이 파일을 ExecutionPolicy Bypass 로 부른다.
  .bat 을 경유하는 이유: 새 Windows 의 기본 정책(Restricted)에서는 .ps1 을 직접 못 돌린다.
  그게 첫 실행 실패의 1순위라, 사용자가 정책을 건드리지 않아도 되게 만든다.

  하는 일
    1) 파이썬 확인 → 없으면 winget 으로 3.12 설치 (PATH 갱신 없이 직접 찾아 쓴다)
    2) 의존성 설치 (python -m pip)
    3) 자동시작 등록 여부를 묻는다 (기본 아니오)
    4) 서버 기동 + 브라우저 열기

  옵션
    -Autostart     묻지 않고 자동시작 등록
    -NoAutostart   묻지 않고 건너뜀
    -NoStart       설치만 하고 기동하지 않음
#>
param([switch]$Autostart, [switch]$NoAutostart, [switch]$NoStart, [switch]$NoBrowser, [switch]$NoShortcut)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host ""; Write-Host "X $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  winterm-web 설치" -ForegroundColor White
Write-Host "  $ROOT" -ForegroundColor DarkGray

# ── 1. 파이썬 ────────────────────────────────────────────────────────────────
Step 1 "파이썬 확인"

function Find-Python {
    # PATH 의 WindowsApps\python.exe 는 Microsoft Store 스텁이라 실행하면 스토어만 열린다
    $c = Get-Command python -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -and $_.Source -notlike "*WindowsApps*" } |
         Select-Object -First 1
    if ($c) { return $c.Source }
    # winget 으로 방금 설치한 경우 PATH 가 아직 이 세션에 없다 → 설치 위치를 직접 뒤진다
    foreach ($base in "$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python") {
        if (Test-Path $base) {
            $p = Get-ChildItem $base -Filter "Python3*" -Directory -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending |
                 ForEach-Object { Join-Path $_.FullName "python.exe" } |
                 Where-Object { Test-Path $_ } | Select-Object -First 1
            if ($p) { return $p }
        }
    }
    return $null
}

$py = Find-Python
if ($py) {
    $ver = & $py --version 2>&1
    Say "  찾음: $py  ($ver)" "Green"
} else {
    Say "  파이썬이 없다. winget 으로 3.12 를 설치한다." "Yellow"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Die "winget 이 없어 자동 설치를 못 한다. https://www.python.org/downloads/windows/ 에서 3.12 를 설치하고 다시 실행해라 (설치 시 'Add to PATH' 체크)."
    }
    winget install --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    $py = Find-Python
    if (-not $py) {
        winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
        $py = Find-Python
    }
    if (-not $py) { Die "설치는 됐는데 python.exe 를 못 찾겠다. PowerShell 을 새로 열고 다시 실행해라." }
    Say "  설치 완료: $py" "Green"
}

# ── 2. 의존성 ────────────────────────────────────────────────────────────────
Step 2 "의존성 설치 (1~3분 걸릴 수 있다)"
# ⚠ pip 는 requirements.txt 를 UTF-8 이 아니라 **로케일 인코딩**(한국어 Windows=cp949)으로
#   읽는다. 파일에 비ASCII 가 있으면 UnicodeDecodeError 로 죽는다(실측 2026-09-11, 한국어 노트북).
#   requirements.txt 는 ASCII 로 유지하되, 안전망으로 UTF-8 모드도 켜둔다.
$env:PYTHONUTF8 = "1"
& $py -m pip install --disable-pip-version-check -q -r (Join-Path $ROOT "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    Die "pip 설치 실패. 사내 프록시 환경이면 프록시 설정이 필요할 수 있다 (README '설치가 막힐 때' 참조)."
}
Say "  완료" "Green"

# ── 3. 자동시작 ──────────────────────────────────────────────────────────────
Step 3 "자동시작 등록"
$TASK = "WebtermServer"
$want = $false
if ($Autostart) { $want = $true }
elseif ($NoAutostart) { $want = $false }
else {
    Write-Host "  로그온할 때 자동으로 띄울까?" -ForegroundColor White
    Write-Host "  (인증이 없는 셸 서버라, 자주 안 쓸 거면 아니오를 권한다)" -ForegroundColor DarkGray
    $want = (Read-Host "  등록? [y/N]") -match "^(y|Y)"
}

if ($want) {
    # ⚠ 자동시작은 부가 기능이다. 여기서 실패해도 설치 전체가 죽으면 안 된다.
    #   (실측 2026-09-11: Register-ScheduledTask 가 Access denied 로 터지면서
    #    $ErrorActionPreference="Stop" 때문에 설치가 통째로 중단됐다)
    $done = $false

    # ① 예약작업 — 지연·창숨김을 OS 가 해주므로 가능하면 이쪽. 단 보통 관리자 권한이 필요하다.
    try {
        $exe = Join-Path $ROOT "webterm.exe"
        if (Test-Path $exe) {
            $action = New-ScheduledTaskAction -Execute $exe -Argument "--no-browser" -WorkingDirectory $ROOT
        } else {
            $ps1 = Join-Path $ROOT "start.ps1"
            $action = New-ScheduledTaskAction -Execute "powershell.exe" `
                      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`"" `
                      -WorkingDirectory $ROOT
        }
        $trig = New-ScheduledTaskTrigger -AtLogOn
        $trig.Delay = "PT30S"
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew

        $prev = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
        if ($prev) {
            $where = @($prev.Actions | ForEach-Object { "$($_.Execute) $($_.WorkingDirectory)" })
            if (-not ($where | Where-Object { $_ -like "*$ROOT*" })) {
                Say "  주의: 기존 $TASK 작업이 다른 폴더를 가리킨다 — 덮어쓴다" "Yellow"
                $where | ForEach-Object { Say "    $_" "DarkGray" }
            }
            Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue
        }
        Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $trig -Settings $set `
            -Description "winterm-web 자동 기동 (로그온 30초 후, 창 없이)" -ErrorAction Stop | Out-Null
        Say "  예약작업 등록 완료 (로그온 30초 후)" "Green"
        $done = $true
    } catch {
        Say "  예약작업 등록 불가 ($($_.Exception.Message.Trim())) — 시작프로그램 방식으로 전환" "DarkYellow"
    }

    # ② 시작프로그램 폴더 — 관리자 권한이 필요 없다. 지연은 autostart.ps1 이 직접 준다.
    if (-not $done) {
        try {
            $startup = [Environment]::GetFolderPath("Startup")
            $lnk = Join-Path $startup "winterm-web.lnk"
            $auto = Join-Path $ROOT "toolsutostart.ps1"
            $ws = New-Object -ComObject WScript.Shell
            $sc = $ws.CreateShortcut($lnk)
            $sc.TargetPath = "powershell.exe"
            $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$auto`""
            $sc.WorkingDirectory = $ROOT
            $ico = Join-Path $ROOT "assets\webterm.ico"
            if (Test-Path $ico) { $sc.IconLocation = $ico }
            $sc.Description = "winterm-web 자동 기동"
            $sc.Save()
            Say "  시작프로그램에 등록 완료 (관리자 권한 불필요)" "Green"
            Say "    $lnk" "DarkGray"
            $done = $true
        } catch {
            Say "  자동시작 등록 실패: $($_.Exception.Message)" "Red"
            Say "  설치는 계속한다. 나중에 install.bat -Autostart 로 다시 시도할 수 있다." "DarkGray"
        }
    }
} else {
    Say "  건너뜀 (나중에 원하면 install.bat -Autostart)" "DarkGray"
}

# ── 3.5 바로가기 ─────────────────────────────────────────────────────────────
# 자동시작을 안 걸면 여는 방법이 없어진다. 바탕화면에 하나 둔다.
# 서버가 꺼져 있어도 되게 start.ps1 을 먼저 돌리고 브라우저를 연다.
if (-not $NoShortcut) {
    Step "3.5" "바탕화면 바로가기"
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "winterm-web.lnk"
        $open = Join-Path $ROOT "tools\open.ps1"
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath = "powershell.exe"
        $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$open`""
        $sc.WorkingDirectory = $ROOT
        $ico = Join-Path $ROOT "assets\webterm.ico"
        if (Test-Path $ico) { $sc.IconLocation = $ico }
        $sc.Description = "winterm-web 열기"
        $sc.Save()
        Say "  바탕화면에 winterm-web 바로가기 생성" "Green"
    } catch {
        Say "  바로가기 생성 실패(무시 가능): $($_.Exception.Message)" "DarkGray"
    }
}

# ── 4. 기동 ──────────────────────────────────────────────────────────────────
if ($NoStart) {
    Step 4 "기동 생략 (-NoStart)"
    Write-Host ""; Say "설치 끝. 실행하려면 start.ps1" "Green"
    exit 0
}

Step 4 "기동"
$port = if ($env:WEBTERM_PORT) { $env:WEBTERM_PORT } else { "8767" }
& (Join-Path $ROOT "start.ps1")

$url = "http://127.0.0.1:$port"
$ok = $false
foreach ($i in 1..15) {
    Start-Sleep -Milliseconds 700
    try { if ((Invoke-RestMethod "$url/api/health" -TimeoutSec 3).ok) { $ok = $true; break } } catch {}
}

Write-Host ""
if ($ok) {
    Say "  설치 완료 → $url" "Green"
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host ""
    Write-Host "  주의: 인증이 없다. 127.0.0.1 로만 쓰고 WEBTERM_HOST 는 건드리지 마라." -ForegroundColor Yellow
    Write-Host "  외부에서 쓰려면 Tailscale 같은 사설망 위에서만 열어야 한다." -ForegroundColor Yellow
} else {
    Say "  기동 확인 실패. webterm.log 를 봐라:" "Red"
    Write-Host "    Get-Content `"$ROOT\webterm.log`" -Tail 30"
    exit 1
}
