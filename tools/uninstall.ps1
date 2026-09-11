<#
  winterm-web 제거 — 자동시작 해제 + 서버 정지.

  ⚠ 소스 폴더나 파이썬 패키지는 지우지 않는다. 폴더를 통째로 지우면 끝이고,
     그 전에 이 스크립트로 예약작업과 돌고 있는 프로세스를 먼저 정리한다.
#>
param([switch]$KeepRunning)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

Write-Host ""
Write-Host "  winterm-web 정리" -ForegroundColor White

# 1. 자동시작 해제
Write-Host ""
Write-Host "[1] 자동시작 해제" -ForegroundColor Cyan
# ⚠ 이름만 보고 지우면 안 된다. 같은 이름의 작업이 **다른 설치본**을 가리킬 수 있고,
#   그걸 지우면 남의(또는 내 다른 폴더의) 자동시작을 말없이 없애버린다.
#   실제로 개발 중 이 버그로 다른 설치본의 작업을 지울 뻔했다(2026-09-11).
#   → 이 폴더를 가리키는 작업일 때만 지운다.
$t = Get-ScheduledTask -TaskName "WebtermServer" -ErrorAction SilentlyContinue
if (-not $t) {
    Write-Host "  등록돼 있지 않다" -ForegroundColor DarkGray
} else {
    $paths = @($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" })
    $mine = $paths | Where-Object { $_ -like "*$ROOT*" }
    if (-not $mine) {
        Write-Host "  건너뜀 — 등록된 작업이 다른 폴더를 가리킨다:" -ForegroundColor Yellow
        $paths | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Host "    (이 폴더: $ROOT)" -ForegroundColor DarkGray
        Write-Host "    정말 지우려면: Unregister-ScheduledTask WebtermServer -Confirm:`$false" -ForegroundColor DarkGray
    } else {
        try {
            Unregister-ScheduledTask -TaskName "WebtermServer" -Confirm:$false -ErrorAction Stop
            Write-Host "  예약작업 WebtermServer 제거 완료" -ForegroundColor Green
        } catch {
            # 실패를 성공으로 찍으면 사용자는 해제된 줄 알고 넘어간다. 그게 더 나쁘다.
            Write-Host "  제거 실패: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "  관리자 PowerShell 에서 다시 시도해라:" -ForegroundColor Yellow
            Write-Host "    Unregister-ScheduledTask WebtermServer -Confirm:`$false" -ForegroundColor DarkGray
        }
    }
}

# 1.5 바로가기 제거 — 이 설치본을 가리키는 것만
Write-Host ""
Write-Host "[1.5] 바탕화면 바로가기" -ForegroundColor Cyan
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "winterm-web.lnk"
if (Test-Path $lnk) {
    $tgt = ""
    try { $tgt = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).Arguments } catch {}
    if ($tgt -like "*$ROOT*") {
        Remove-Item $lnk -Force
        Write-Host "  제거 완료" -ForegroundColor Green
    } else {
        Write-Host "  건너뜀 — 다른 설치본을 가리킨다" -ForegroundColor Yellow
    }
} else {
    Write-Host "  없다" -ForegroundColor DarkGray
}

# 2. 서버 정지
Write-Host ""
Write-Host "[2] 서버 정지" -ForegroundColor Cyan
if ($KeepRunning) {
    Write-Host "  -KeepRunning 이라 건드리지 않는다" -ForegroundColor DarkGray
} else {
    # ⚠ 반드시 127.0.0.1 바인딩만 고른다. tailscale serve 가 같은 포트를 100.x / IPv6 에도
    #   리슨하므로, 포트만 보고 첫 리스너를 죽이면 tailscaled 를 죽인다(실제 사고 이력).
    $port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
    $dport = if ($env:WEBTERM_DAEMON_PORT) { [int]$env:WEBTERM_DAEMON_PORT } else { 8771 }
    foreach ($p in $port, $dport) {
        $l = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
             Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
        if ($l) {
            $name = (Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
            $what = if ($p -eq $dport) { "세션 데몬" } else { "웹서버" }
            Write-Host "  $what 정지 (포트 $p, PID $($l.OwningProcess) $name)" -ForegroundColor Green
        } else {
            Write-Host "  포트 $p : 떠 있지 않다" -ForegroundColor DarkGray
        }
    }
    Write-Host "  ⚠ 데몬을 죽였으므로 열려 있던 셸도 함께 종료됐다" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  정리 끝. 완전히 지우려면 이 폴더를 삭제해라:" -ForegroundColor Green
Write-Host "    $ROOT" -ForegroundColor DarkGray
Write-Host ""
