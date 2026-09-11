# clipboard_paste.ps1
# Print the clipboard contents to stdout.
#  - image: save a PNG under %TEMP%\wezterm_clip\ and return its path
#  - file drop: return the file path(s)
#  - text: return the text as-is
#
# Called by winterm-web's `GET /api/clipboard`.
# -Sta is required - System.Windows.Forms.Clipboard only works on an STA thread.
# Example: powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File clipboard_paste.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    # Fallback if WinForms fails to load - at least text
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
            # Clean up temp files older than a day
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
            # Space-separated for multiple files; the caller handles paths that contain spaces.
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
    # On any failure, fall back to text
    try { [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText()) } catch {}
}
