# clipboard_paste.ps1
# 클립보드 내용을 stdout 으로 출력.
#  - 이미지면 %TEMP%\wezterm_clip\ 에 PNG 저장 후 경로 반환
#  - 파일 드롭이면 파일 경로(들) 반환
#  - 텍스트면 텍스트 그대로 반환
#
# winterm-web 의 `GET /api/clipboard` 에서 호출한다.
# ⚠ `-Sta` 필수 — System.Windows.Forms.Clipboard 는 STA 스레드에서만 동작한다.
# 호출 예: powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File clipboard_paste.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    # WinForms 로드 실패 시 폴백 — 텍스트만이라도
    try { [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText()) } catch {}
    exit 0
}

try {
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img) {
            $dir = Join-Path $env:TEMP 'wezterm_clip'
            if (-not (Test-Path $dir)) {
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
            }
            # 1일 이상 된 임시 파일 정리
            try {
                Get-ChildItem $dir -Filter '*.png' -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
                    Remove-Item -Force -ErrorAction SilentlyContinue
            } catch {}

            $stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
            $path = Join-Path $dir ("clip_{0}.png" -f $stamp)
            $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            $img.Dispose()
            [Console]::Out.Write($path)
            exit 0
        }
    }

    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        if ($files -and $files.Count -gt 0) {
            # 여러 파일이면 공백 구분. 경로에 공백 있는 경우 호출자가 처리.
            $joined = ($files | ForEach-Object { $_ }) -join ' '
            [Console]::Out.Write($joined)
            exit 0
        }
    }

    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())
        exit 0
    }
} catch {
    # 무엇이든 실패하면 텍스트 폴백
    try { [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText()) } catch {}
}
