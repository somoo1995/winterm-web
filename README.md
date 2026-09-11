# winterm-web

**Windows 셸을 브라우저에서 쓰는 터미널.** ConPTY 를 직접 쥐고 WebSocket 으로 흘려보내기 때문에
화면을 긁어오는 미러가 아니라 **진짜 터미널**이다 — TUI 도, 자동완성도, 컬러도 그대로 동작한다.
PC 에서 열어둔 그 셸에 폰으로 붙어 이어서 칠 수 있다.

> 실행 파일·로그·API 는 초기 개발명인 `webterm` 을 그대로 쓴다.

---

## ⚠ 보안 — 먼저 읽을 것

**이 프로그램은 브라우저에게 셸을 준다. 접근할 수 있는 사람은 당신 계정으로 무엇이든 실행할 수 있다.**

접근 통제는 **네트워크에 맡기는 설계**다. 로그인 화면도 토큰도 없다.

- 기본 바인딩은 `127.0.0.1` 이다 — 그 PC 밖에서는 아예 도달하지 않는다
- 폰이나 다른 기기에서 쓰려면 **Tailscale 같은 사설망 위에 올린다.** tailnet 밖에서는
  도달 자체가 안 되므로 그것이 인증 역할을 한다
- **`WEBTERM_HOST` 를 `0.0.0.0` 으로 바꾸지 말 것.** 공용 인터넷이나 회사 LAN 에 그대로 열면
  인증 없는 원격 셸이 된다

### 사설망으로 막을 수 없는 것 — 그래서 코드로 막았다

당신 **자신의 브라우저**가 loopback 으로 때리는 공격은 공격자가 tailnet 안에 있을 필요가 없다.
VPN 이 관여하지 못하는 경로라 서버가 직접 봐야 한다. 격리 인스턴스에서 실측한 결과:

| 공격 | 가드 이전 | 현재 |
| --- | --- | --- |
| `Host` 위조(DNS 리바인딩) → `/api/sessions` 로 sid 획득 | 200, sid 유출 | **403** |
| 교차출처 WebSocket `/ws/{sid}` | 수락, 셸 읽기·쓰기 | **403** |
| 교차출처 multipart `POST /api/upload` | 200, 파일 심어짐 | **403** |
| `/api/send` 에 `text/plain` 로 고전 CSRF | 422 (원래 막힘) | 422 |

`config.json` 의 `security.allowedHosts` 로 조정한다. 기본값은
`127.0.0.1` · `localhost` · `[::1]` · `*.ts.net`(Tailscale MagicDNS)이다.
**Origin 헤더가 없는 요청(curl·스크립트)은 통과**시키므로 API 자동화는 영향받지 않는다.

## 왜 만들었나

기존에는 네이티브 터미널(WezTerm)을 `get-text` 로 1.5초마다 **폴링해서** 웹에 비췄다.
PTY master 는 한 프로세스가 독점하므로 그 구조로는 더 빨라질 수 없고, 슬래시 자동완성 같은
"입력에 즉시 반응하는" 것들은 **원리상 못 한다.**

winterm-web 은 PTY 를 직접 소유한다. 그래서 실시간이 노력의 결과가 아니라 기본값이다.

| 항목 | 폴링 미러 | **winterm-web (PTY 직결)** |
| --- | --- | --- |
| 키 입력 왕복 | 79ms | **0.26ms** |
| 화면 갱신 | 229ms + 1.5초 폴링 | **4.6ms** (push) |
| 자동완성 등 즉시 반응 UI | ❌ 구조상 불가 | ✅ |

## 구조

```
[세션 데몬 daemon.py]   ← PTY 를 소유하고 계속 산다 (tmux server 역할).  127.0.0.1:8771
      ↕ 로컬 TCP (NDJSON)
[웹서버 server.py]      ← 순수 중계기. 세션 상태를 하나도 갖지 않는다.   127.0.0.1:8767
      ↕ HTTP + WebSocket
[브라우저 xterm.js]     ← 닫아도 세션은 살아있다
```

**웹서버와 데몬이 분리돼 있다는 것이 이 구조의 요점이다.** 코드를 고쳐 웹서버를 재시작해도
열려있는 셸과 그 안의 변수가 그대로 살아남는다. 브라우저를 닫아도 마찬가지고, 다시 붙으면
링버퍼에서 화면을 복원한다.

## 요구사항

- **Windows 10 1809+ / 11** — ConPTY 가 필요하다. 다른 OS 는 지원하지 않는다
- **Python 3.12 권장** (3.10+ 면 동작한다). 유일한 네이티브 의존성인 `pywinpty` 의
  휠이 준비된 버전을 쓰는 편이 안전하다 — 너무 최신 파이썬은 소스 빌드로 넘어갈 수 있다
- 브라우저: Chrome / Edge 계열 권장 (PWA 설치와 Window Controls Overlay 를 쓴다)

> 새 venv 에 `pip install -r requirements.txt` 로 받은 최신 조합
> (fastapi 0.141 / starlette 1.6 / anyio 4.15 / websockets 17 / pywinpty 3.0)에서
> 기동·셸 실행·WebSocket 까지 동작을 확인했다.

## 설치

### 1. 파이썬 (이미 있으면 건너뛴다)

```powershell
python --version
```

`Python 3.12.x` 가 나오면 됐다. 없거나 Microsoft Store 가 열리면 설치한다:

```powershell
winget install Python.Python.3.12
```

⚠ 설치 후 **PowerShell 창을 새로 열어야 한다.** 기존 창에는 PATH 가 반영되지 않는다.
새 창에서 다시 `python --version` 으로 확인하고, `(Get-Command python).Source` 가
`WindowsApps` 를 가리키면 그건 Store 스텁이라 실패다(트러블슈팅 2번 참조).

관리자 권한이 막히면 `winget install Python.Python.3.12 --scope user`.

### 2. 받아서 설치

```powershell
git clone https://github.com/somoo1995/winterm-web.git
cd winterm-web
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r requirements.txt
```

`Set-ExecutionPolicy` 는 **처음 한 번만** 하면 된다. Windows 기본값(`Restricted`)에서는
`.ps1` 이 전부 차단되어 다음 단계의 `start.ps1` 이 실행되지 않는다. 관리자 권한은 필요 없다.

`pip` 가 아니라 `python -m pip` 인 이유: `pip.exe` 는 `Scripts\` 라는 **별도 PATH 항목**에 있어
python 만 잡히고 pip 는 빠지는 경우가 흔하다. `python -m pip` 는 PATH 를 안 타서 항상 된다.

## 실행

```powershell
.\start.ps1              # 웹서버 (재)기동. 데몬이 없으면 같이 띄운다 → http://127.0.0.1:8767
.\start.ps1 -Status      # 데몬/웹서버/열린 세션 확인
.\start.ps1 -Stop        # 웹서버만 정지 (세션은 계속 살아있다)
.\start.ps1 -StopAll     # 데몬까지 정지  ⚠ 열려있는 셸이 전부 종료된다
.\start.ps1 -fg          # 포그라운드로 (로그 보면서)
```

**코드를 고쳤을 때는 `.\start.ps1` 만 하면 된다** — 데몬을 건드리지 않으므로 세션이 안 죽는다.

### GUI 런처 (선택)

콘솔 창 없이 아이콘으로 띄우고 싶으면 exe 런처를 빌드한다.

```powershell
.\build.ps1              # 아이콘 생성 + exe 빌드
.\build.ps1 -Shortcut    # 바탕화면 바로가기까지
```

```powershell
.\webterm.exe            # 기동 + 앱 창 열기  ← 더블클릭이 이것
.\webterm.exe --restart  # 웹서버만 재시작(세션 유지)
.\webterm.exe --status   # 상태 + 열린 세션 목록
.\webterm.exe --no-browser
.\webterm.exe --install  # PWA 설치용으로 일반 창에서 열기 (타이틀바 제거)
```

exe 는 **런처일 뿐 파이썬을 번들하지 않는다.** `server.py`/`app.js` 를 고쳐도 재빌드가 필요 없고,
`launcher.py` 를 고칠 때만 다시 빌드한다. `WEBTERM_PYTHON` / `WEBTERM_ROOT` 로 경로를 강제할 수 있다.

## 설정

`config.default.json` 이 기본값이다. **이 파일은 고치지 말고**, 같은 폴더에 `config.json` 을 만들어
바꿀 항목만 적는다. `config.json` 은 `.gitignore` 되어 있어 업데이트에 안 쓸린다.

```jsonc
{
  "defaultCwd": "C:/work",
  "fontSize": 16,
  "keymap": {
    "Ctrl+d": "pane.split.v",   // 조합 추가
    "Ctrl+]": "pane.split.v",   // 기본값 재정의
    "Ctrl+n": ""                // 끄기 — 앱이 안 가로채고 터미널로 흘려보낸다
  }
}
```

병합은 **키 단위**다. 위처럼 세 조합만 적으면 나머지 기본 단축키는 그대로 살아있다.
적용은 웹서버 재시작(`.\start.ps1`) 후 브라우저 새로고침.

| 항목 | 기본값 | 뜻 |
| --- | --- | --- |
| `defaultCwd` | `""`(홈) | 새 세션의 시작 폴더 |
| `shell` | `""` | 띄울 셸. 비우면 `powershell.exe -NoLogo` |
| `fontSize` | `14.7` | 기본 폰트 크기(브라우저에서 조절하면 그쪽이 이긴다) |
| `security.allowedHosts` | loopback + `*.ts.net` | 허용할 `Host`. `*.` 로 시작하면 와일드카드 |
| `security.allowedOrigins` | `[]` | WebSocket Origin 허용목록. 비우면 `allowedHosts` 를 따른다 |
| `security.enabled` | `true` | 위 검사 전체 스위치 |
| `keymap` | 아래 표 | 단축키 |

### 환경변수


| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `WEBTERM_PORT` | `8767` | 웹서버 포트 |
| `WEBTERM_DAEMON_PORT` | `8771` | 세션 데몬 포트 |
| `WEBTERM_HOST` | `127.0.0.1` | 바인딩 주소. **바꾸지 말 것** (위 보안 절 참조) |
| `WEBTERM_SHELL` | `powershell.exe -NoLogo` | 띄울 셸. 인자를 포함할 수 있다 |
| `WEBTERM_CWD` | 사용자 홈 | 새 세션의 시작 폴더 |
| `WEBTERM_ROOT` | (자동 탐지) | `server.py` 가 있는 폴더. exe 를 밖에 둘 때만 필요 |
| `WEBTERM_PYTHON` | (자동 탐지) | 쓸 파이썬 실행파일 |

> 우선순위: **요청값 → `config.json` → 환경변수 → 기본값.**
> 같은 항목이 양쪽에 있으면 `config.json` 이 이긴다.

## 단축키

전부 `config.json` 의 `keymap` 으로 바꿀 수 있다. 브라우저 콘솔에서 `webterm.actions()` 를 치면
쓸 수 있는 액션 목록이, `webterm.keymap()` 을 치면 지금 걸린 조합이 나온다.

| 키 | 기능 | 액션 이름 |
| --- | --- | --- |
| `Ctrl+]` / `Ctrl+\` | 패널 좌우 분할 / 상하 분할 | `pane.split.h` / `.v` |
| `Ctrl+N` | 새 탭 | `tab.new` |
| `Ctrl+T` / `Ctrl+P` | 탭 이름 / 패널 이름 | `tab.rename` / `pane.rename` |
| `Ctrl+←` `Ctrl+→` / `Ctrl+1~9` | 탭 이동 / 탭 번호로 이동 | `tab.prev` `.next` / `tab.select:N` |
| `Alt+1~9` / `Alt+0` | N번 패널 전체화면 / 해제 | `pane.zoom:N` / `pane.unzoom` |
| `Alt+←` `Alt+→` | 패널 순환 (줌 유지) | `pane.prev` `.next` |
| `Alt+X` | 패널 닫기 | `pane.close` |
| `Alt+B` | 세로 세션 레일 토글 | `rail.toggle` |
| `Ctrl+Shift+R` 또는 `Alt+R` | 화면 크기 다시 맞추기 | `view.refit` |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | 폰트 크기 | `font.inc` `.dec` `.reset` |

`Ctrl+W`(단어 지우기)·`Ctrl+R`(역방향 검색)은 **일부러 안 가로챈다** — PSReadLine 이 실제로 쓴다.
닫기가 `Alt+X` 인 이유는 `Ctrl+W` 계열을 브라우저가 먼저 먹어 창을 닫아버리기 때문이다.

## 폰에서 쓰기

같은 세션을 폰에서도 연다. 터미널 **내용**은 공유하고 **껍데기**만 기기에 맞춘다 —
폰에는 Ctrl·Esc·Tab·방향키가 없기 때문에 가상 특수키 바와 8방향 스와이프 키보드가 따로 있다.

`static/kb-layout.js` 하나만 고치면 키 배치를 바꿀 수 있다.

## HTTP API

스크립트에서 세션을 조작할 수 있다. 탭은 세션의 `name` 이고, **같은 `name` 을 가진 세션들이
한 탭의 패널**이 된다.

| 기능 | 엔드포인트 |
| --- | --- |
| 상태 확인 | `GET /api/health` |
| 세션 목록 / 탭 목록 | `GET /api/sessions` · `GET /api/tabs` |
| 세션 생성 | `POST /api/sessions` `{name, cwd, cols, rows}` |
| 텍스트 보내기 | `POST /api/send` `{target, text, submit}` |
| 화면 읽기 | `GET /api/capture?target=...` |
| 지목 확인 | `GET /api/resolve?target=3-2` |
| 이름 바꾸기 | `POST /api/tabs/{name}/rename` · `POST /api/panes/label` |
| 닫기 | `DELETE /api/sessions/{sid}` · `DELETE /api/tabs/{name}` |
| 터미널 스트림 | `WebSocket /ws/{sid}` |

`target` 지목 문법: `3-2`(3번 탭의 2번째 패널) · `탭:패널` · `탭:2` · sid 접두.
**부분 매칭은 일부러 막았다** — 엉뚱한 세션에 명령이 간 사고가 있었다. 모호하면 서버가 고르지 않고
`409` 와 함께 후보 목록을 돌려준다.

```powershell
Invoke-RestMethod "http://127.0.0.1:8767/api/send" -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"target":"1-1","text":"dir","submit":true}'))
```

## 설치가 막힐 때

깨끗한 Windows + 새 venv 에서 `pip install` → 기동 → 셸 실행까지 실측으로 확인했다(2026-09-10).
그래도 첫 실행에서 걸리는 자리는 대체로 아래 넷이다.

### 1. `.\start.ps1` 이 "이 시스템에서 스크립트를 실행할 수 없으므로..." 로 막힌다

Windows 클라이언트의 PowerShell 기본 실행 정책이 `Restricted` 라 **모든 .ps1 이 차단**된다.
가장 흔한 첫 관문이다. 현재 사용자 범위만 풀면 된다(관리자 권한 불필요):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

정책을 바꾸기 싫으면 그 실행에서만 우회할 수도 있다:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

### 2. `python` 을 못 찾는다 / 실행하면 Microsoft Store 가 열린다

`PATH` 의 `WindowsApps\python.exe` 는 실제 파이썬이 아니라 **스토어 스텁**이다.
`start.ps1` 과 `launcher.py` 는 그 경로를 걸러내지만, 진짜 파이썬이 하나도 없으면 당연히 실패한다.
[python.org](https://www.python.org/downloads/windows/) 설치본을 쓰고, 설치 시 **Add to PATH** 를 켠다.
경로를 직접 지정하려면 `WEBTERM_PYTHON` 환경변수를 쓴다.

### 3. `pip` 용어가 인식되지 않습니다

`python --version` 은 되는데 `pip` 만 안 되는 경우다. `python.exe` 는 `...\Python312\` 에,
`pip.exe` 는 `...\Python312\Scripts\` 에 있어서 **PATH 항목이 서로 다르고**, 설치 시 앞쪽만
등록되는 일이 흔하다.

```powershell
python -m pip install -r requirements.txt
```

`python -m pip` 는 PATH 를 타지 않고 파이썬이 자기 안의 pip 모듈을 직접 부르므로 항상 동작한다.
`pip` 명령 자체를 쓰고 싶으면 Scripts 를 PATH 에 추가한다(새 창부터 적용):

```powershell
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";" + (Split-Path (Get-Command python).Source) + "\Scripts", "User")
```

### 4. 포트 8767 / 8771 이 이미 쓰이고 있다

```powershell
.\start.ps1 -Status        # 우리 프로세스가 이미 떠 있는지 먼저 본다
$env:WEBTERM_PORT=9767; $env:WEBTERM_DAEMON_PORT=9771; .\start.ps1   # 다른 포트로
```

### 5. clone 이 26MB 라 좀 느리다

24MB 가 한글 폰트(Sarasa Fixed K woff2 서브셋 216개)다. 브라우저는 `unicode-range` 로
필요한 조각만 받으므로 **실행 성능과는 무관**하고, 받을 때만 무겁다.
CDN 을 안 쓰는 건 오프라인·사내망에서도 그대로 뜨게 하려는 의도적 선택이다.

### 확인용

```powershell
.\start.ps1 -Status
Invoke-RestMethod http://127.0.0.1:8767/api/health
```

## 알려진 한계

- Windows 전용 (ConPTY / pywinpty 의존)
- 로그인·토큰이 없다. 접근 통제는 네트워크(사설망/Tailscale)에 맡기는 설계다 — 위 보안 절 참조
- PTY 크기는 세션당 하나뿐이라 PC 와 폰이 같이 붙으면 **큰 쪽에 맞춘다**(PC 를 지키는 선택)
- WebGL 렌더러는 화면 배율이 1이 아닐 때 그림이 밀려 그려져서 **기본 비활성**이다 (`?webgl=1` 로 켬)

## 라이선스

MIT — [LICENSE](LICENSE) 참조. 동봉한 서드파티 구성요소는
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 에 정리했다.
