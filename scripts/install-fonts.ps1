# webterm 의 내장 글꼴을 이 PC 에 "설치"한다 (현재 사용자 전용, 관리자 권한 불필요).
#
# 왜 설치하나: webterm 은 글꼴을 서브셋 웹폰트로 내장해 쓰는데(JetBrains Mono 라틴만, Sarasa 108조각),
# 조각이 늦게 도착하면 렌더러가 폴백 글리프로 굳거나(WebGL 아틀라스) 박스문자가 다른 폰트로 그려진다.
# 설치된 글꼴이 있으면 브라우저가 그것을 먼저 쓴다(fonts/*.css 의 local() 우선) — 통째로, 전 굵기, 지연 없이.
# Windows Terminal 이 이 문제를 겪지 않는 이유가 바로 "설치된 글꼴을 쓴다"는 것이다.
#
# 사용:  .\scripts\install-fonts.ps1            JetBrains Mono 만
#        .\scripts\install-fonts.ps1 -Sarasa    Sarasa Fixed K 까지 (약 50MB 7z, Windows 의 tar.exe 로 푼다)
# 설치 후 브라우저를 새로고침하면 적용된다. 확인은 webterm.log 의 diag 줄 `loaded` / `widthM` 항목.
param([switch]$Sarasa)

$ErrorActionPreference = "Stop"
$fontDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$regKey  = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts"
New-Item -ItemType Directory -Force $fontDir | Out-Null
if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
$tmp = Join-Path $env:TEMP ("webterm-fonts-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null

Add-Type -AssemblyName System.Drawing

function Install-Ttf($path) {
  # 글꼴의 실제 이름(예: "JetBrains Mono Medium")으로 등록해야 브라우저의 local() 이 찾는다.
  $pfc = New-Object System.Drawing.Text.PrivateFontCollection
  $pfc.AddFontFile($path)
  $family = $pfc.Families[0].Name
  $leaf = Split-Path $path -Leaf
  $dest = Join-Path $fontDir $leaf
  Copy-Item $path $dest -Force
  # 파일명에서 굵기/스타일을 뽑아 이름에 붙인다 (Regular 는 생략). 정확한 전체 이름은 파일에 있지만
  # 읽으려면 별도 파서가 필요하고, 브라우저는 PostScript 이름(파일명과 같음)으로도 매칭하므로 충분하다.
  $style = [IO.Path]::GetFileNameWithoutExtension($leaf) -replace '^[^-]*-?', ''
  $style = $style -replace '([a-z])([A-Z])', '$1 $2'
  $name = if ($style -and $style -ne 'Regular') { "$family $style (TrueType)" } else { "$family (TrueType)" }
  New-ItemProperty -Path $regKey -Name $name -Value $dest -PropertyType String -Force | Out-Null
  Write-Host "  + $name"
}

try {
  # ---- JetBrains Mono (GitHub 릴리스, zip) ----
  $jbVer = "2.304"
  $zip = Join-Path $tmp "jbm.zip"
  Write-Host "JetBrains Mono $jbVer 내려받는 중..."
  Invoke-WebRequest -UseBasicParsing "https://github.com/JetBrains/JetBrainsMono/releases/download/v$jbVer/JetBrainsMono-$jbVer.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath (Join-Path $tmp "jbm") -Force
  Get-ChildItem (Join-Path $tmp "jbm") -Recurse -Filter "JetBrainsMono-*.ttf" |
    Where-Object { $_.FullName -notmatch "\\NL\\" } |          # 'NL' 변종(리가처 없음)은 제외
    ForEach-Object { Install-Ttf $_.FullName }

  # ---- Sarasa Fixed K (선택, 7z) ----
  if ($Sarasa) {
    Write-Host "Sarasa Fixed K 최신 릴리스 확인 중..."
    $rel = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/be5invis/Sarasa-Gothic/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -match '^SarasaFixedK-TTF-.*\.7z$' } | Select-Object -First 1
    if (-not $asset) { throw "릴리스에서 SarasaFixedK-TTF-*.7z 를 찾지 못했습니다" }
    $sz = Join-Path $tmp $asset.name
    Write-Host "$($asset.name) 내려받는 중 ($([math]::Round($asset.size / 1MB)) MB)..."
    Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $sz
    $out = Join-Path $tmp "sarasa"
    New-Item -ItemType Directory -Force $out | Out-Null
    # Windows 10 1803+ 의 tar.exe(bsdtar) 는 7z 읽기를 지원한다. 안 되면 7-Zip 으로 직접 풀어 ttf 를 $fontDir 에 복사.
    & tar.exe -xf $sz -C $out
    if ($LASTEXITCODE -ne 0) { throw "tar.exe 가 7z 를 풀지 못했습니다. 7-Zip 으로 직접 풀어 주세요: $sz" }
    Get-ChildItem $out -Recurse -Filter "SarasaFixedK-*.ttf" | ForEach-Object { Install-Ttf $_.FullName }
  }

  # 실행 중인 앱에 글꼴 변경을 알린다 (WM_FONTCHANGE). 브라우저는 새로고침이 확실하다.
  $sig = '[DllImport("user32.dll")] public static extern int SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);'
  $u32 = Add-Type -MemberDefinition $sig -Name U32 -Namespace W -PassThru
  [IntPtr]$r = [IntPtr]::Zero
  $u32::SendMessageTimeout([IntPtr]0xFFFF, 0x1D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$r) | Out-Null
  Write-Host "완료. 브라우저(webterm 창)를 새로고침하세요."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
