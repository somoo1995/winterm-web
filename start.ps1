# webterm 기동/정지
#
# 구조: [세션 데몬 8771] ← PTY 보관, 거의 안 건드림
#       [웹서버 8767]    ← 재시작 자유 (세션은 안 죽는다)
#
# 사용: .\start.ps1            웹서버 (재)기동. 데몬은 없으면 자동 기동
#       .\start.ps1 -fg        웹서버를 포그라운드로 (로그 보면서)
#       .\start.ps1 -Stop      웹서버만 정지 (세션은 계속 살아있음)
#       .\start.ps1 -StopAll   데몬까지 정지 ⚠ 열려있는 셸이 전부 종료된다
#       .\start.ps1 -Status    현재 상태만 확인
param([switch]$fg, [switch]$Stop, [switch]$StopAll, [switch]$Status)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8767
$daemonPort = 8771

function Get-Listener($p) {
    # ⚠ 반드시 127.0.0.1 바인딩만 고른다.
    # tailscale serve 가 같은 포트를 100.x / IPv6 에 리슨하고 있어서, 포트만 보고 첫 리스너를
    # 잡으면 tailscaled 를 죽인다(실제로 한 번 죽였다). 우리 프로세스는 항상 loopback 바인딩이다.
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
}

function Find-Pythonw {
    # ⚠ PATH 의 WindowsApps\pythonw.exe 는 Microsoft Store 스텁이라 즉시 죽는다 → 실제 설치본을 찾는다
    $py = (Get-Command python -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1).Source
    if (-not $py) { return $null }
    $pyw = Join-Path (Split-Path $py) "pythonw.exe"
    if (Test-Path $pyw) { return $pyw }
    return $py
}

function Show-Status {
    $d = Get-Listener $daemonPort
    $w = Get-Listener $port
    if ($d) { Write-Host "세션 데몬 : 실행중 (PID $($d.OwningProcess), 포트 $daemonPort)" -ForegroundColor Green }
    else    { Write-Host "세션 데몬 : 정지" -ForegroundColor DarkGray }
    if ($w) { Write-Host "웹서버    : 실행중 (PID $($w.OwningProcess)) → http://127.0.0.1:$port" -ForegroundColor Green }
    else    { Write-Host "웹서버    : 정지" -ForegroundColor DarkGray }
    if ($d -and $w) {
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:$port/api/sessions" -TimeoutSec 5
            Write-Host "열린 세션 : $($h.sessions.Count)개" -ForegroundColor Cyan
            foreach ($s in $h.sessions) { Write-Host "            - $($s.name)  ($($s.cwd))" -ForegroundColor DarkCyan }
        } catch { Write-Host "열린 세션 : 조회 실패" -ForegroundColor Yellow }
    }
}

function Stop-Web {
    $w = Get-Listener $port
    if ($w) {
        Write-Host "웹서버 종료: PID $($w.OwningProcess)"
        Stop-Process -Id $w.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
    }
}

if ($Status)  { Show-Status; return }

if ($StopAll) {
    Stop-Web
    $d = Get-Listener $daemonPort
    if ($d) {
        Write-Host "⚠ 세션 데몬 종료: PID $($d.OwningProcess) — 열려있던 셸이 모두 종료됩니다" -ForegroundColor Yellow
        Stop-Process -Id $d.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Write-Host "webterm 전체 정지됨"
    return
}

if ($Stop) {
    Stop-Web
    if (Get-Listener $daemonPort) { Write-Host "웹서버 정지됨 (세션 데몬은 계속 실행중 — 세션 살아있음)" -ForegroundColor Cyan }
    else { Write-Host "웹서버 정지됨" }
    return
}

# ── 기동 ─────────────────────────────────────────────
$pyw = Find-Pythonw
if (-not $pyw) { Write-Host "python 을 찾지 못했습니다" -ForegroundColor Red; return }

# 1) 데몬이 없으면 먼저 띄운다 (있으면 절대 건드리지 않는다 — 세션이 살아있으므로)
if (-not (Get-Listener $daemonPort)) {
    Write-Host "세션 데몬 기동중..."
    # ⚠ daemon.py 를 pythonw 로 직접 띄우면 안 된다 — 콘솔이 없어 ConPTY 생성이 패닉한다.
    #   spawn_daemon.py 가 python.exe + CREATE_NO_WINDOW 로 다시 띄워준다(콘솔 O, 창 X).
    Start-Process -FilePath $pyw -ArgumentList "spawn_daemon.py" -WorkingDirectory $root -WindowStyle Hidden
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        if (Get-Listener $daemonPort) { break }
    }
    if (Get-Listener $daemonPort) { Write-Host "세션 데몬 기동 완료 (포트 $daemonPort)" -ForegroundColor Green }
    else { Write-Host "세션 데몬 기동 실패 — daemon.log 확인" -ForegroundColor Red; return }
} else {
    Write-Host "세션 데몬 이미 실행중 — 유지 (세션 보존)" -ForegroundColor Cyan
}

# 2) 웹서버는 항상 새로 띄운다
Stop-Web
$env:WEBTERM_PORT = "$port"
$env:WEBTERM_HOST = "127.0.0.1"

if ($fg) {
    Set-Location $root
    python server.py
} else {
    # pythonw = 콘솔 창 없이 (예약작업 콘솔 flash 사고 이력 때문에 창을 띄우지 않는다)
    Start-Process -FilePath $pyw -ArgumentList "server.py" -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 2
    if (Get-Listener $port) {
        Write-Host "webterm 기동 완료 → http://127.0.0.1:$port" -ForegroundColor Green
        # 외부(폰) 주소는 하드코딩하지 않는다 — 사람마다 다르고, 공개 저장소에 남으면 안 된다.
        # tailscale 이 있으면 이 머신의 MagicDNS 이름을 물어서 보여준다.
        $ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
        if ($ts) {
            $dns = (& $ts.Source status --json 2>$null | ConvertFrom-Json).Self.DNSName
            if ($dns) {
                Write-Host "                  → https://$($dns.TrimEnd('.')):$port (폰/외부)" -ForegroundColor DarkGreen
            }
        }
    } else {
        Write-Host "웹서버 기동 실패 — webterm.log 확인" -ForegroundColor Red
    }
}
