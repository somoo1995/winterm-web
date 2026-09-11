<#
  바탕화면 바로가기가 부르는 진입점.
  서버가 꺼져 있으면 띄우고, 이미 떠 있으면 건드리지 않고 브라우저만 연다.
#>
$ErrorActionPreference = "SilentlyContinue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
$url  = "http://127.0.0.1:$port"

# ⚠ 반드시 127.0.0.1 바인딩만 본다 — tailscale serve 가 같은 포트를 100.x 에도 리슨한다
$live = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1

if (-not $live) {
    # 떠 있지 않을 때만 띄운다. 떠 있는데 start.ps1 을 돌리면 웹서버가 재시작돼
    # 붙어 있던 브라우저가 잠깐 끊긴다(세션은 안 죽지만 굳이 흔들 이유가 없다).
    & (Join-Path $ROOT "start.ps1") | Out-Null
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        try { if ((Invoke-RestMethod "$url/api/health" -TimeoutSec 2).ok) { break } } catch {}
    }
}
Start-Process $url
