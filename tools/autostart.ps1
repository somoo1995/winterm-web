<#
  로그온 자동시작 진입점 (시작프로그램 폴더 방식).

  예약작업을 쓰면 지연·창숨김을 OS 가 해주지만 **일반 사용자 권한으로는 등록이 안 된다**
  (Register-ScheduledTask → Access is denied). 그래서 관리자 없이도 되는 이 경로를 둔다.
  지연은 여기서 직접 준다.
#>
$ErrorActionPreference = "SilentlyContinue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# 로그온 직후는 네트워크·디스크가 바쁘다. 바로 띄우면 실패하기 쉬워 30초 기다린다.
Start-Sleep -Seconds 30

$port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
# ⚠ 127.0.0.1 바인딩만 본다 — tailscale serve 가 같은 포트를 100.x 에도 리슨한다
$live = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
if (-not $live) { & (Join-Path $ROOT "start.ps1") | Out-Null }
