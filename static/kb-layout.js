/* 가상 키보드 레이아웃 정의 — 배치를 바꾸고 싶으면 이 파일만 고치면 된다.
   (렌더·제스처·한글조합 엔진은 keyboard.js)

   ── 키 객체 ────────────────────────────────────────────────
     c    탭했을 때 동작 (필수)
     n ne e se s sw w nw    그 방향으로 스와이프했을 때 동작 (Unexpected Keyboard 와 같은 8방향)
     l    표시 라벨 (생략하면 c 를 그대로 표시)
     wd   폭 배수 (기본 1) — ⚠️ 방향키 `w`(서쪽 스와이프)와 충돌하므로 width 는 `wd`
     cls  추가 CSS 클래스 — "fn"(기능키 회색) / "act"(강조)

   ── 동작 문자열 3종 ────────────────────────────────────────
     "k:esc"      터미널로 즉시 전송. 이름은 wezterm_bridge.py `_KEY_MAP` 의 키.
                  (esc tab shifttab enter space backspace delete up down left right
                   home end pgup pgdn ctrla ctrlb ctrlc ctrld ctrle ctrlf ctrlg
                   ctrlk ctrll ctrln ctrlo ctrlp ctrlr ctrlu ctrlw ctrly ctrlz)
     "a:xxx"      앱 액션 — enter / bs / shift / layer:en|ko|sym|toggle
                  / send:<명령>(입력창 무시하고 그 명령 즉시 실행) / move(Tab 자동완성)
     그 외 문자    입력창에 삽입. 한글 자모면 엔진이 조합해준다.

   ⚠️ 문자 동작에 두 글자 이상을 쓰면 그 문자열이 통째로 삽입된다("k:"/"a:" 접두사만 예약).
*/
"use strict";

/* ⭐ 특수키 바 모드 (webterm 기본값)
   webterm 은 폴링 미러가 아니라 **PTY 직결**이라, 폰 기본 키보드로 터미널에 바로 쳐도
   즉시 반영된다(`/we` 까지만 쳐도 슬래시 자동완성이 실시간으로 뜬다).
   그래서 문자 자판과 조합 입력창은 필요 없고, **폰에 없는 키만** 제공하면 된다.

   (wezterm-web 은 미러가 1.5초 지연이라 "입력창에 모았다가 전송"이 불가피했다.
    그 전제가 사라져서 문자 레이어를 통째로 걷어냈다.) */

// 액션 바는 없앴다(2026-08-20). `▶ claude` · `↻ resume` 는 폰 기본 키보드로 치면 되고,
// `✦ 렌더`(WebGL 토글)는 실측에서 체감 차이가 없어 남길 이유가 없었다.
// 도크가 한 줄 줄어든 만큼을 방향키를 크게 만드는 데 썼다.
const KB_ACTIONBAR = [];

// 문자행 "위"에 붙는 기능줄 — 물리 키보드처럼 Esc/Tab 이 맨 위에 오게.
// 방향키를 하나로 합치며 자리가 남아, Esc/^C 의 좌우 스와이프에 셸 줄편집을 몰아뒀다.
// ⭐ 특수키 도크 — **한 줄**(사용자 지시 2026-08-24).
//
// 예전에는 두 줄이었고 `⌨`(키보드 토글)·`⏎` 가 도크 안에 있었다. 이제 도크는
// **소프트 키보드가 떠 있을 때만 함께 뜨므로** 그 둘이 필요 없다 —
// 키보드를 켜는 것은 화면 더블탭이고, `⏎` 는 폰 기본 키보드에 이미 있다.
// 그 자리를 줄바꿈(`↵`)에 내줬다.
const KB_TOP = [
  [
    // s 는 원래 k:ctrlg(Unix 취소)였으나 Windows PSReadLine 에 없어 실행취소로 바꿨다
    { c: "k:esc", l: "Esc", n: "k:ctrll", s: "k:ctrlz", wd: 0.95, cls: "fn" },
    { c: "k:tab", l: "Tab", n: "k:shifttab", wd: 0.95, cls: "fn" },
    // 진짜 modifier — 탭하면 다음 글자가 Ctrl+글자가 된다. 더블탭 = 잠금.
    // ⚠ 스와이프 조합은 **Windows PSReadLine 기준**이다(wezterm-web 원본은 Unix 기준이라
    //   Ctrl+U/E/D/O 가 절반쯤 헛돌았다 — 실측: 바인딩 자체가 없다).
    //   Unix 의 Ctrl+U(줄 전체 지우기) 자리는 Windows 에선 Escape(RevertLine)다.
    // ⭐ Shift — Ctrl 과 같은 3단 modifier(탭=한 번만 / 더블탭=잠금 / 다시=해제).
    //   문자 자판이 없으니 대문자용이 아니라 **특수키 조합용**이다:
    //     Shift+Tab(역방향 이동) · Shift+방향키 · **Shift+Enter = 줄바꿈**.
    //   조합 시퀀스는 app.js 의 `KEY_SEQ` 에 `shift*` 이름으로 있다.
    { c: "a:shift", l: "⇧", wd: 0.85, cls: "fn" },
    { c: "a:ctrl", l: "Ctrl", cls: "fn",
      n: "k:ctrlc",   s: "k:ctrld",      // 중단 / EOF
      w: "k:home",    e: "k:end",        // 줄 처음 / 줄 끝
      nw: "k:ctrlr",  ne: "k:ctrlz",     // 히스토리 검색 / 실행취소
      sw: "k:esc",    se: "k:ctrlw" },   // 줄 전체 지우기 / 단어 지우기
    // Alt — 터미널로 가는 키가 아니라 **앱 기능**(pane 줌·이동·탭 전환)이다.
    // PC 의 `Alt+숫자`/`Alt+←→`/`Alt+X` 계층인데 폰엔 Alt 키가 없어서 `a:app:*` 으로 직접 부른다.
    { c: "a:app:unzoom", l: "Alt", cls: "fn",
      w: "a:app:pane:-1", e: "a:app:pane:1",     // 이전 / 다음 패널
      n: "a:app:zoomCur", s: "a:app:close",      // 현재 패널 줌 토글 / 닫기(확인창 뜬다)
      nw: "a:app:tab:-1", ne: "a:app:tab:1",     // 이전 / 다음 탭
      sw: "a:app:zoom:1", se: "a:app:zoom:2" },  // 1번 / 2번 패널 전체화면
    // ⚠ 꾹 누르기에 `k:pgup` 을 넣었다가 "눌러도 스크롤이 안 된다"는 제보를 받았다.
    //   당연한 결과다 — `k:*` 는 **터미널로 키를 보내는 것**이라 화면(스크롤백)은 안 움직인다.
    //   스크롤백을 움직이는 주체는 xterm 이므로 `a:app:scroll` 로 직접 부른다(Alt 계층과 같은 부류).
    //   반대로 Home/End 는 커서를 옮기는 진짜 터미널 키라 `k:*` 가 맞다.
    { c: "k:left",  l: "←", lp: "k:home",          wd: 0.8, cls: "fn nav2" },   // 꾹 = 줄 처음
    { c: "k:up",    l: "↑", lp: "a:app:scroll:-1", wd: 0.8, cls: "fn nav2" },   // 꾹 = 화면 한 페이지 위
    { c: "k:down",  l: "↓", lp: "a:app:scroll:1",  wd: 0.8, cls: "fn nav2",
      s: "a:app:bottom" },                                             // 아래 스와이프 = 맨 아래로
    { c: "k:right", l: "→", lp: "k:end",           wd: 0.8, cls: "fn nav2" },   // 꾹 = 줄 끝
    // ⭐ 줄바꿈 — **전송하지 않고 다음 줄로**.
    //   claude 는 Shift+Enter 를 줄바꿈으로 쓰는데, 터미널에는 Shift+Enter 라는 신호가 없다
    //   (그래서 iTerm2·VSCode 는 별도 키바인딩을 설치한다). 대신 claude 가 화면 힌트로
    //   안내하는 **`ctrl+j for newline`** 이 있고, Ctrl+J 는 곧 라인피드(0x0A)라
    //   어느 터미널에서나 그대로 통한다 — 폰에서 줄바꿈이 안 되던 것이 이걸로 풀린다.
    { c: "k:ctrlj", l: "↵", cls: "fn act" },
    // ⭐ 붙여넣기 — 폰에는 **Ctrl+V 를 만들 방법이 없다.** Ctrl 은 진짜 modifier 지만
    //   조합할 문자 자판을 걷어냈고(위 주석), 폰 기본 키보드가 치는 글자는 xterm 의
    //   textarea 로 바로 들어가므로 우리 Ctrl 상태와 만나지 않는다. → 전용 키를 둔다.
    //   ⚠ 터미널로 보내는 키가 아니라 **앱 액션**이다(클립보드를 읽어 bracketed paste 로 감싼다).
    //     `k:ctrlv` 로 0x16 을 보내는 길은 claude 가 `chat:imagePaste` 로 해석해 텍스트가 안 붙는다.
    //   탭 = 폰 클립보드 먼저 / 위로 스와이프 = PC 클립보드 먼저(이미지면 PNG 경로가 온다).
    { c: "a:app:paste", l: "📋", n: "a:app:pastePC", wd: 0.8, cls: "fn" },
    // ⭐ 파일 업로드 — 폰에서 고른 파일을 PC 임시폴더로 올리고 **그 경로**를 붙인다.
    //   (claude 에 사진·로그·문서를 물릴 때. 붙여넣기와 같은 원리 — 바이트는 못 보내니 경로로.)
    { c: "a:app:upload", l: "📎", wd: 0.8, cls: "fn" },
  ],
];

// 문자 자판은 없다 — 폰 기본 키보드가 터미널에 직접 친다(PTY 직결이라 즉시 반영된다).
// 예전에는 KB_EN / KB_KO / KB_SYM(3개 레이어 약 110줄)과 하단 줄(space·한/영·입력·⏎)이 있었고
// keyboard.js 의 두벌식 조합기가 그것을 받쳤는데, `KB_SPECIAL_ONLY` 로 꺼둔 채 죽은 코드로 남아 있었다.
// 2026-08-20 에 삭제했다. 원본은 wezterm-web 과 `_backup/` 에 있다
// (wezterm-web 은 폴링 미러라 1.5초 지연 탓에 "입력창에 모았다가 전송"이 불가피했다 —
//  그 전제가 사라진 것이 삭제의 근거다).
const KB_BOTTOM = [];

const KB_LAYERS = { en: [] };   // 문자 레이어 없음(특수키 바 전용)
