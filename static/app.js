/* webterm 프론트엔드 — xterm.js 를 WebSocket 으로 PTY 에 직결한다.
   외형은 .wezterm.lua 를 그대로 옮겼다(Powerline 탭바 / Tokyo Night / JetBrains Mono Medium).

   ── 탭 > pane 구조 ────────────────────────────────────────────────
   서버는 여전히 flat 한 세션 목록만 안다. **세션의 `name` 이 곧 탭 이름**이고,
   같은 이름을 가진 세션들이 한 탭의 pane 이 된다. 분할 = 같은 이름으로 세션 하나 더 만들기.
   → 데몬/서버 프로토콜을 안 건드려도 되고(재시작하면 열려있는 셸이 죽으므로 중요),
     pane 마다 독립 PTY 라 WezTerm 과 동작이 같다.

   ── 크기 규칙(중요) ───────────────────────────────────────────────
   **xterm 의 칸 수와 PTY 의 칸 수는 반드시 같아야 한다.** 다르면 앱은 A칸 기준으로 줄을 넘기는데
   화면은 B칸으로 배치해 글자가 겹쳐 그려진다. 그래서 클라는 두 역할 중 하나만 한다:
     · 주인(PC 기본)   : 자기 창 크기를 xterm 에 적용하고 그 크기를 PTY 에 요구 → 창 늘리면 늘어난다
     · 따라가기(폰 기본): 크기를 요구하지 않고 PTY 크기를 받아 그린다(가로 스크롤)
*/
(() => {
  const $ = (s) => document.querySelector(s);
  // 새 탭의 시작 폴더. **빈 값이면 서버가 정한다** —
  //   config.json 의 defaultCwd → 환경변수 WEBTERM_CWD → 사용자 홈 순.
  // ⚠ 여기에 개인 절대경로를 박지 않는다: 공개 저장소에 그대로 남고,
  //   다른 사람 PC 에는 존재하지 않아 조용히 홈으로 폴백된다.
  let DEFAULT_CWD = "";

  // .wezterm.lua 내장 "Tokyo Night" 과 동일한 16색 (wezterm-src/docs/colorschemes/data.json 대조)
  const THEME = {
    background: "#1a1b26", foreground: "#c0caf5",
    cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#283457",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
    brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  };
  // .wezterm.lua: JetBrains Mono weight="Medium", font_size=11(pt ≈ 14.7px), line_height=1.15
  let fontSize = +(localStorage.getItem("webterm.font") || 14.7);
  // font.reset 이 돌아갈 기준값. 설정(config.json 의 fontSize)이 있으면 부팅 때 갈아끼운다.
  let baseFont = 14.7;

  const isPhone = (() => {
    const f = /[?&]kb=([01])/.exec(location.search);
    return f ? f[1] === "1" : (matchMedia("(pointer: coarse)").matches && innerWidth < 900);
  })();
  // ⭐⭐ **원격 브라우저인가** — 붙여넣기의 출처를 가르는 유일한 기준이다.
  //
  // ⚠ 사고(2026-08-27): 다른 PC 에서 tailscale 로 붙어 Ctrl+V 를 누르면 **내 노트북에서 복사한 게
  //   아니라 집 PC 클립보드에 있던 옛 텍스트**가 붙었다. PC 경로가 무조건 `/api/clipboard`
  //   (= 서버가 도는 그 PC 의 클립보드)를 읽기 때문이다. 폰만 예외로 둔 것이 화근 —
  //   **"폰이냐"가 아니라 "브라우저가 서버와 같은 기계에 있느냐"가 진짜 갈림길이다.**
  //   `?clip=pc|browser` 로 강제할 수 있게 둔다(집 PC 에서 원격 판정이 틀릴 때의 탈출구).
  const isRemote = (() => {
    const f = /[?&]clip=(pc|browser)/.exec(location.search);
    if (f) return f[1] === "browser";
    const h = location.hostname;
    return !(h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]");
  })();
  // ⭐ `⤢`(화면 맞추기)는 **크기값이 아니라 "내가 주인이다"라는 상태**다.
  //
  // ⚠ 사고 기록(2026-08-24, 폴드8): 예전에는 누른 **그 순간의 크기를 서버에 박제**했다.
  //   폴더블은 접었다 펴는 것만으로 화면이 475px ↔ 2048px 로 바뀌는데, 박제된 값(51x30)은
  //   그대로라 펼친 뒤 **statusline 이 잘리고 아래가 텅 비었다.** 회전·분할화면도 같다.
  //   → 이제 `forced` 가 켜져 있으면 **크기를 보고할 때마다 force 를 함께 실어** 최신값으로
  //     갱신한다(`resizePane`). "어떤 레이아웃이든 맞는다"가 이 버튼의 약속이다.
  //   localStorage 에 남겨 새로고침·재접속 후에도 주인 자리를 잃지 않는다.
  // 브라우저 고유 ID — 재연결해도 같은 값이라 서버가 "같은 사람"임을 안다(WS 쿼리로 보낸다)
  const CID = (() => {
    let v = localStorage.getItem("webterm.cid");
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("webterm.cid", v); }
    return v;
  })();
  // ⚠ 고정 복원은 **폰에서만**. PC 는 기본이 크기의 주인이라 고정할 이유가 없고,
  //   PC 에 고정이 걸리면 폰이 크기를 못 가져갈 뿐 아니라 아래 폴링 동기화까지 막혀
  //   **칸 수 불일치가 영영 안 고쳐진다**(화면이 겹쳐 그려지는 원인).
  let forced = isPhone && localStorage.getItem("webterm.fit") === "1";
  // ⭐⭐ **PTY 크기를 고정하지 않는다**(사용자 지시 2026-08-24).
  //   PC 든 폰이든, 접든 펴든, 가로든 세로든 **브라우저가 알려주는 실제 크기**를 그대로 요구한다.
  //   예전에는 폰만 "따라가기"(PTY 크기를 받아 그리기)였는데, 그러면 폰 화면에 안 들어가는
  //   큰 PTY 를 그대로 그려 statusline 이 잘렸다. 보는 쪽이 자기 화면에 맞추는 것이 맞다.
  //   충돌(둘 다 붙어 있을 때)은 "마지막에 본 쪽이 주인" + 고정(`forced`)으로 푼다.
  // ⚠ `?observe=1` = **관찰 전용**. 크기를 보고하지 않아 남의 화면을 뺏지 않는다.
  //   검증하려고 브라우저를 하나 더 붙이면 "보고 있는 쪽이 주인" 규칙을 타고
  //   **사용자가 보던 화면이 그 창 크기로 좁아진다**(2026-08-24 실측: 사용자 화면이
  //   141칸 → 48칸으로 줄어 입력창이 반쪽만 그려졌다). 검증은 이 모드로 붙는다.
  const APP_VER = 109;   // ⚠ 정적 파일을 고칠 때마다 index.html 의 ?v= 와 함께 올린다
                         //   (100~104 는 index.html 만 올라가 어긋나 있었다 — 105 에서 다시 맞춤)
  const OBSERVE = /[?&]observe=1/.test(location.search);
  // ⭐⭐ **붙는 것만으로는 크기를 뺏지 않는다.**
  //
  // ⚠ 사고 기록(2026-08-24, 같은 사고 4회): 검증용으로 브라우저를 하나 더 열 때마다
  //   "보고 있는 쪽이 주인" 규칙을 타고 **사용자가 보던 화면이 그 창 크기로 찌그러졌다**
  //   (141칸 → 48칸 → 72칸…). `?observe=1` 플래그를 만들었지만 **붙이는 걸 잊으면 그만**이라
  //   규율로는 못 막는다. → 규칙 자체를 바꾼다:
  //     · 접속 직후에는 **관찰자** — PTY 크기를 받아 그리기만 한다(남의 화면을 안 건드린다)
  //     · 그 창에서 **실제로 상호작용**(클릭·키 입력)하면 그때 주인이 된다
  //   사람이 보고 만지는 창만 크기를 정한다. 창을 여러 개 띄워도 안전하다.
  let reportSize = false;
  const claimOwnership = () => {
    if (reportSize || OBSERVE) return;
    reportSize = true;
    scheduleResize();          // 이제부터 내 화면에 맞춘다
  };
  let typing = !isPhone;         // 폰 기본은 읽기 모드(소프트 키보드를 띄우지 않는다)
  let togglePhoneKb = () => {};  // 폰 초기화 시 실제 구현이 꽂힌다
  let setPhoneTyping = () => {}; // 폰 초기화 시 `setTyping` 이 꽂힌다(끄기 전용으로 쓴다)
  // ⚠ 소프트 키보드가 떠 있는 동안에는 **크기 협상을 하면 안 된다.**
  //   키보드에 눌려 줄어든 높이로 `fit()` 하면 그 값이 PTY 로 나가고(주인 모드일 때),
  //   claude 같은 TUI 가 그 크기로 화면을 다시 그린다. 키보드를 닫으면 또 되돌아가므로
  //   **입력할 때마다 화면이 깨지는 것처럼 보인다.** 키보드 높이는 화면을 가릴 뿐
  //   터미널이 실제로 좁아진 것이 아니다.
  let kbOpen = false;
  // 폰에서 "지금 화면에서 실제로 쓸 수 있는 높이"를 다시 계산한다(키보드 + 특수키 도크).
  // 폰 초기화 블록에서 실제 구현이 꽂히고, 도크 토글·키보드 여닫이가 함께 부른다.
  let applyViewport = () => {};
  // ⚠ pane 이 만들어지는 **즉시** 입력 모드를 반영해야 한다.
  //   폴링(2초)으로 뒤늦게 붙이면, 그 사이에 `focus()` 가 걸리는 경로(탭 전환 등)에서
  //   안드로이드가 소프트 키보드를 띄워버린다 — 읽기 모드인데 키보드가 튀어나오는 원인이었다.
  // ⭐ 한글은 **조합 중**이라는 상태가 있다(`ㄱ` → `가` → `강`). 그 사이에 textarea 를 건드리거나
  //   화면을 다시 그리면 IME 가 조합을 버리고 자모가 낱개로 새어 나간다
  //   (2026-08-24 제보: 한글을 치는데 `랴랴` 처럼 엉킨 글자가 들어감).
  //   → 조합 중임을 추적해 그 동안에는 **아무것도 건드리지 않는다.**
  let composing = false;
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => {
    composing = false;
    // 조합 중 미뤄둔 재측정이 있으면 이제 처리한다(안 하면 크기가 어긋난 채 남는다)
    if (typeof scheduleResize === "function") scheduleResize();
  }, true);

  const applyInputMode = (term) => {
    if (!isPhone || !term || !term.textarea) return;
    const ta = term.textarea;
    if (composing) return;                    // 조합 중 재설정은 조합을 취소시킨다
    // ⚠ **값이 다를 때만** 대입한다. 같은 값이라도 다시 넣으면 브라우저가 IME 를 초기화해
    //   조합이 끊긴다. 폴링(renderPanes → focusTerm → 여기)이 4초마다 지나가므로
    //   무조건 대입하면 한글을 치는 도중 주기적으로 글자가 깨진다.
    if (ta.inputMode !== (typing ? "text" : "none")) ta.inputMode = typing ? "text" : "none";
    // ⭐ 읽기 모드에서는 **포커스 자체가 불가능해야** 한다.
    //   `inputMode="none"` 도, 호출부를 막는 것도, `focusin` 에서 `blur()` 하는 것도
    //   전부 "이미 뜬 키보드를 내리는" 사후 대응이라 **탭·pane 전환 때 키보드가 번쩍였다**
    //   (사용자 제보 2026-08-24: "아직도 탭 전환하면 키보드가 활성화된다").
    //   `disabled` 면 안드로이드가 애초에 키보드를 올리지 않는다. 읽기 모드에서는 입력이
    //   필요 없고 특수키는 WebSocket 직결이라 잃는 것도 없다(`readOnly` 는 반대로 입력을 죽인다).
    if (ta.disabled === typing) ta.disabled = !typing;    // 같은 값 재대입 금지(위 주석 참조)
  };
  // ⚠ `inputMode="none"` 만으로는 부족하다. **탭 클릭 같은 사용자 제스처 핸들러 안에서 focus() 를
  //   부르면 안드로이드가 소프트 키보드를 띄워버린다.** 속성으로 막으려 하지 말고,
  //   읽기 모드에서는 **포커스 자체를 주지 않는다**(특수키는 WebSocket 직결이라 포커스가 필요 없다).
  const focusTerm = (term) => {
    if (!term) return;
    applyInputMode(term);
    // ⚠⚠ 창이 **뒤에 있으면 포커스를 주지 않는다.**
    //   `ws.onopen` 이 재연결마다 이 함수를 부르는데(웹서버 재시작·네트워크 끊김·절전 복귀),
    //   그때 사용자가 **다른 터미널에서 작업 중이면 커서를 빼앗긴다**
    //   (2026-08-24 제보: "다른 터미널에서 작업하는데 자꾸 포커스가 webterm 으로 뺏긴다").
    //   `hasFocus()` 는 이 문서가 OS 포커스를 쥐고 있는지를 답한다 — 사용자가 직접 pane 을
    //   클릭한 경우는 당연히 true 라 정상 동작에는 영향이 없다.
    if (document.hidden || !document.hasFocus()) return;
    // ⭐⭐ 2026-08-27 (사용자 제보 9회차): **폰에서는 이 함수가 절대 포커스를 주지 않는다.**
    //
    // ⚠ 지금까지의 방어는 전부 "읽기 모드일 때"만 막았다(`disabled` · `focusin` 되돌리기).
    //   그런데 실제로 터진 경로는 **입력 모드가 켜진 채로 남아 있는 상태**였다 —
    //   `⌨`/더블탭으로 한 번 켜고 안드로이드 **뒤로가기로 키보드만 내리면** 앱은 여전히
    //   `typing=true` 로 알고 있고, 다음 **탭 전환**의 `focusPane → focusTerm → term.focus()`
    //   가 키보드를 다시 올린다. 사용자에겐 "더블탭도 안 했는데 탭만 눌렀는데 키보드가 뜬다".
    //   그래서 서버 로그에 `focus-blocked` 가 한 줄도 안 남았다(읽기 모드가 아니었으니까).
    //   → 폰의 포커스 진입점을 **`setTyping(true)` 하나로** 줄인다. 탭·pane 전환·재연결·폴링은
    //     어떤 경우에도 포커스를 만들지 않는다.
    if (isPhone) return;
    if (typing) term.focus();
  };

  // ⭐ 최후의 방어선 — 읽기 모드에서 터미널 textarea 에 포커스가 잡히면 **즉시 되돌린다.**
  //   호출부를 하나씩 고쳐왔지만(focusPane · renderPanes · ws.onopen) 계속 새 경로가 나왔다.
  //   xterm 내부에서 부르는 것까지 있어 출처를 다 막는 건 현실적이지 않다 →
  //   **결과 지점 한 곳에서 막는다.** 어디서 오든 읽기 모드면 포커스가 유지되지 않는다.
  //   (동시에 출처를 서버 로그에 남겨 진짜 원인을 좁힌다)
  if (typeof window !== "undefined") {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains("xterm-helper-textarea")) return;
      if (typing) return;                       // 입력 모드면 정상이다
      t.blur();
      try {
        fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ev: "focus-blocked", typing,
                                 stack: String((new Error()).stack).slice(0, 400) }) });
      } catch (_) {}
    }, true);
  }

  // ---------- 상태 ----------
  let sessions = [];              // 서버가 아는 세션 전부
  let activeTab = null;           // 현재 탭 이름
  let activeSid = null;           // 현재 pane
  let zoomSid = null;             // 줌 중인 pane (**현재 탭** 기준)
  // 세로 세션 레일(PC 전용) — 켜면 가로 탭 목록·pane 칩을 대신한다. 상태는 브라우저에 남는다.
  let railOn = !isPhone && localStorage.getItem("webterm.rail") === "1";
  // ⭐ 줌은 **탭마다 따로 기억한다**(탭이름 → 줌 pane 의 sid).
  //   ⚠ 예전에는 `zoomSid` 하나뿐이고 `selectTab` 이 그것을 지웠다. 그래서 전체화면으로
  //     보던 탭을 떠났다 돌아오면 **줌이 풀려 분할 상태로 되돌아갔다**(제보 2026-09-07).
  //     `layouts`(탭별 분할 방향)와 같은 결의 상태이므로 같은 방식으로 탭에 매어 둔다.
  const zoomByTab = {};
  // 줌을 바꾸는 **유일한 통로** — 현재 탭의 기억까지 함께 갱신한다.
  // (`zoomSid` 에 직접 대입하면 탭을 떠나는 순간 그 값이 유실된다)
  const setZoom = (sid) => {
    zoomSid = sid || null;
    if (activeTab) zoomByTab[activeTab] = zoomSid;
  };
  // 현재 탭에 맞는 줌을 고른다 — 그 pane 이 닫혔으면 버린다.
  // `renderPanes` 가 매번 부르므로, 탭이 바뀌는 **어떤 경로**(selectTab · newTab ·
  // 폴링 중 탭 소멸)로 들어와도 줌이 다른 탭의 pane 을 가리킨 채 남지 않는다.
  //   ⚠ 남으면 그 탭의 pane 이 전부 `.dim` 이 되고(`renderPanes`), `.dim` 은 `isOff` 라
  //     **크기 협상까지 통째로 멈춘다** — 화면이 깨진 채 굳는 경로였다.
  const syncZoom = () => {
    const z = zoomByTab[activeTab] || null;
    zoomSid = (z && tabPanes(activeTab).some(p => p.sid === z)) ? z : null;
    if (activeTab) zoomByTab[activeTab] = zoomSid;
  };
  // ⭐ 폰에서 **꾹 눌러 텍스트 선택하는 중**이라는 표시.
  //   ⚠ 이 플래그가 없으면 `attachInertia` 가 같은 touchmove 로 화면을 스크롤해서,
  //     손가락 밑의 절대 행이 안 바뀌고 **한 줄만 잡힌다**(실제 제보 2026-08-26).
  let selecting = false;
  let pingAt = 0;
  const panes = new Map();        // sid -> { sid, el, host, term, fit, ws, retry, delay, attachedAt }
  const layouts = {};             // 탭이름 -> "h" | "v" (분할 방향)

  // 폰 특수키 바(keyboard.js)가 부를 수 있게 앱 기능을 노출한다.
  // ⚠ Alt 계층은 터미널로 보내는 키가 아니라 **앱이 처리하는 기능**이다(pane 줌·이동).
  //   PC 는 keydown 으로 잡지만 폰에는 Alt 키가 없으므로, 특수키 바가 여기를 직접 부른다.
  window.__wt = { panes, get tab() { return activeTab; }, get sid() { return activeSid; },
                  get sessions() { return sessions; },
                  app: {
                    pane:   (d) => cyclePane(d),
                    zoom:   (n) => zoomPane(n - 1),          // 화면에 보이는 번호(1-based)
                    zoomCur: () => {
                      const ps = tabPanes(activeTab);
                      zoomPane(ps.findIndex(p => p.sid === activeSid));
                    },
                    unzoom: () => { setZoom(null); renderPanes(); },
                    tab:    (d) => cycleTab(d),
                    close:  () => { if (activeSid) closePane(activeSid); },
                    webgl:  () => toggleWebgl(),   // 폰에는 우클릭 메뉴가 없어 특수키 바에서 부른다
                    kb:     () => togglePhoneKb(),  // 소프트 키보드 토글(도크 안 ⌨ 키)
                    // ⭐ 붙여넣기 — 폰 도크의 `📋` 키가 부른다.
                    //   PC 는 `Ctrl+V` keydown 으로 잡지만, 폰에는 **그 조합을 만들 문자 자판이 없다**
                    //   (kb-layout 의 문자 레이어를 2026-08-20 에 걷어냈다) → 이 앱 액션이 유일한 진입점이다.
                    //   `paste` = 폰 클립보드 먼저, `pastePC` = PC 클립보드 먼저(📋 위로 스와이프).
                    paste:   () => pasteClipboard(false),
                    pastePC: () => pasteClipboard(true),
                    // ⭐ 파일 업로드 — 도크의 `📎` 키. 폰에서 고른 파일을 PC 로 올리고
                    //   **그 경로**를 pane 에 붙인다(claude 가 경로를 받으면 읽는다).
                    upload:  () => pickAndUpload(),
                    // ⚠ 화면 스크롤은 **터미널로 보내는 키가 아니다**.
                    //   `↑`(ESC[A)는 셸·claude 에서 '히스토리 이전 명령'이고 PgUp 도 앱이 안 받으면 무반응이다.
                    //   스크롤백을 움직이는 것은 xterm 자신이므로 여기서 직접 부른다.
                    scroll: (d) => { const p = panes.get(activeSid); if (p) p.term.scrollPages(d); },
                    bottom: () => { const p = panes.get(activeSid); if (p) p.term.scrollToBottom(); },
                    font:   (d) => setFont(fontSize + d),
                  } };

  // 진단 한 줄을 서버 로그로 — 브라우저 콘솔은 사용자에게 열어달라 하기 번거롭다
  const diag = (obj) => {
    try {
      fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ ver: APP_VER }, obj)) });
    } catch (_) {}
  };

  // 짧은 알림 — 폰에는 콘솔도 우클릭 메뉴도 없어서 **탭바의 지연 표시 칸(`#lag`)을 1.5초 빌려 쓴다.**
  // ⚠ 같은 칸을 ping 에코가 쓰므로, `lagHold` 동안은 ping 이 손대지 않게 막아둔다(아래 onmessage).
  let lagHold = 0;
  const flash = (msg) => {
    const el = $("#lag");
    el.hidden = false;
    el.textContent = msg;
    lagHold = performance.now() + 1500;
    setTimeout(() => { if (performance.now() >= lagHold) el.hidden = true; }, 1600);
  };

  // ---------- API ----------
  const jpost = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" },
                                     body: JSON.stringify(b || {}) }).then(r => r.json());
  const api = {
    list:   () => fetch("/api/sessions").then(r => r.json()),
    create: (b) => jpost("/api/sessions", b),
    kill:   (sid) => fetch("/api/sessions/" + sid, { method: "DELETE" }).then(r => r.json()),
    rename: (sid, name) => jpost(`/api/sessions/${sid}/rename`, { name }),
    label:  (sid, label) => jpost(`/api/sessions/${sid}/label`, { label }),
    // 탭 이름은 **탭 단위 API** 로 바꾼다 — 서버가 중복·금지문자를 검사하고,
    // 그 탭의 모든 pane 에 한 번에 적용한다(pane 마다 rename 을 돌리면 검사를 건너뛴다).
    renameTab: (name, next) => jpost(`/api/tabs/${encodeURIComponent(name)}/rename`, { name: next }),
  };

  // ---------- 파생 ----------
  const tabNames = () => [...new Set(sessions.map(s => s.name))];
  const tabPanes = (name) => sessions.filter(s => s.name === name);
  const sessOf = (sid) => sessions.find(s => s.sid === sid);

  // 렌더러 선택. URL 파라미터가 localStorage 보다 **우선**한다 —
  // WebGL 을 켰다가 화면이 깨지면 메뉴를 못 누를 수도 있으니 `?webgl=0` 으로 탈출할 길을 둔다.
  function useWebgl() {
    const m = /[?&]webgl=([01])/.exec(location.search);
    if (m) return m[1] === "1";
    return localStorage.getItem("webterm.webgl") === "1";
  }
  function toggleWebgl() {
    localStorage.setItem("webterm.webgl", useWebgl() ? "0" : "1");
    // 렌더러 교체는 새로 붙는 편이 확실하다. 세션은 데몬에 있으므로 새로고침해도 안 죽는다.
    // ?webgl= 파라미터가 남아 있으면 저장값을 덮어쓰므로 경로만 남기고 지운다.
    location.href = location.pathname;
  }

  // ---------- pane 이름 (수동은 박제, 자동은 추종) ----------
  // wiki `pane-name-identity-auto-manual` 의 결론을 그대로 따른다:
  // **사용자가 명시한 이름(Ctrl+P)은 박제**하고, 지정하지 않은 pane 은 자동(번호+프로세스)이
  // 현재 상태를 따라간다. 자동분을 수동으로 굳히면 stale 이 재발한다.
  //
  // 세션의 두 이름은 역할이 다르다:
  //   name  = 탭 이름이자 **그룹 키** — 같은 name 을 가진 세션들이 한 탭의 pane (Ctrl+T)
  //   label = 이 pane 하나의 이름 — 그룹에 영향을 주지 않는다 (Ctrl+P)
  //
  // 저장은 **데몬**이 한다(2026-08-20에 localStorage 에서 승격). 브라우저에 두면
  // ① 서버·CLI·shim 이 그 이름을 모르고 ② 오리진이 다른 폰과 안 맞고
  // ③ 브라우저 데이터를 지우면 사라졌다. 이제 셸과 수명이 같다.
  const paneLabel = (sid) => { const s = sessOf(sid); return (s && s.label) || ""; };

  // ⭐⭐ 탭바의 "작업 중" 초록 점멸 — **claude 스피너 명시 판별**
  //
  // claude Code 는 창 제목(OSC)의 **첫 글자를 스피너로 회전**시킨다. 화면 본문의
  // `✢ Nucleating… (8m 59s · ↓ 16.8k tokens)` 줄과 같은 글자지만 채널이 다르다 —
  // 우리가 읽는 것은 제목 쪽(`session.py` 의 `_scan_title`)이고 거기엔 경과시간·토큰이 없다.
  //
  //   ✳ U+2733  = 대기 중        나머지 프레임 = 작업 중
  //   ◐◑◒◓ U+25D0~25D3 · ✢ U+2722 · ✻ U+273B · ✽ U+273D · ✶ U+2736 · ● U+25CF · * · ·
  //
  // ⚠ 예전에는 이 판정이 **우연히** 맞고 있었다: `✳`·`claude` 둘 다 없으면 떨어지는
  //   폴백이 `busy`(초록 점멸)였고, 작업 중 제목은 `◐ 작업요약` 이라 마침 폴백에 걸렸다.
  //   claude 가 프레임을 바꾸면 조용히 깨지는 구조여서 명시 판별로 바꾼다.
  //   ↳ 폴백도 `busy` → `shell` 로 내렸다. **초록 점멸은 이제 "정말 도는 중"만 뜻한다.**
  const SPIN_IDLE = "✳";                        // U+2733 — 입력 대기
  const SPIN_BUSY = "◐◑◒◓✢✻✽✶●*·";              // 회전 프레임 — 작업 중
  function spinState(title) {
    const t = (title || "").trim();
    if (!t) return "";
    if (t[0] === SPIN_IDLE) return "idle";
    // `*` `·` 같은 흔한 글자도 프레임이라 **뒤에 공백이 오는 형식**(`◐ 요약`)만 인정한다
    if (SPIN_BUSY.indexOf(t[0]) >= 0 && /\s/.test(t[1] || "")) return "busy";
    return "";
  }

  // 프로세스 종류 — 서버가 OSC 로 읽어준 창 제목이 출처(WezTerm 의 pane title 과 같은 곳)
  function kindOf(s) {
    const raw = (s && s.title) || "";
    const spin = spinState(raw);
    if (spin === "busy") return "busy";      // 초록 점멸 — claude 가 지금 돌고 있다
    if (spin === "idle") return "claude";    // 주황 — claude 는 떠 있지만 대기 중
    const t = raw.toLowerCase();
    if (!t) return "shell";
    if (t.includes("claude")) return "claude";
    if (/\b(node|npm|npx|yarn|pnpm|vite)\b/.test(t)) return "node";
    if (/\bgit\b/.test(t)) return "git";
    if (/\b(vim|nvim|nano|code)\b/.test(t)) return "edit";
    if (/(powershell|pwsh|cmd\.exe|^ps )/.test(t)) return "shell";
    return "shell";
  }

  // ---------- 탭바 ----------
  function renderTabs() {
    const box = $("#tabs");
    box.innerHTML = "";
    tabNames().forEach((name, i) => {
      const ps = tabPanes(name);
      const lead = ps.find(p => p.sid === activeSid) || ps[0];
      const el = document.createElement("div");
      el.className = "tab" + (name === activeTab ? " active" : "") +
                     (ps.some(p => p.alive) ? "" : " dead");
      el.title = `${name}\npane ${ps.length}개\n${lead ? lead.cwd : ""}`;
      el.innerHTML = `<span class="dot ${kindOf(lead)}"></span>` +
                     (i < 9 ? `<span class="n">${i + 1}</span>` : "") +
                     `<span class="label"></span>` +
                     (ps.length > 1 ? `<span class="n">▦${ps.length}</span>` : "");
      el.querySelector(".label").textContent = name;
      el.onclick = () => selectTab(name);
      el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(name); } };
      el.ondblclick = () => renameTab(name);
      el.oncontextmenu = (e) => { e.preventDefault(); openMenu(e, name, lead && lead.sid); };
      box.appendChild(el);
    });
    renderChips();
  }

  // 오른쪽 pane 번호 칩 — WezTerm 상태바의 패널 번호 목록과 같은 역할.
  // 번호는 **화면 위치 순**(pane_id 기준은 닫았다 열면 꼬인다 — wiki pane-zoom-navigation 교훈)
  function renderChips() {
    // ⭐ 폰 칩바·드로어의 갈고리는 **여기 하나**다 — `renderTabs`(목록 갱신)도 `focusPane`
    //   (활성 변경)도 결국 이 함수를 거친다. ⚠ 아래 `ps.length < 2` 조기 반환보다 **앞**에
    //   두어야 한다(pane 이 하나인 탭에서도 칩바는 그려져야 하므로).
    if (isPhone) { renderPhoneNav(); if (!$("#drawer").hidden) renderDrawer(); }
    else if (railOn) renderRail();      // PC 세로 레일도 같은 갈고리를 탄다(아래 조기 반환보다 앞)
    const box = $("#panechips");
    box.innerHTML = "";
    const ps = tabPanes(activeTab);
    if (ps.length < 2) return;
    ps.forEach((p, i) => {
      const c = document.createElement("div");
      c.className = "chip" + (p.sid === activeSid ? " on" : "") + (p.sid === zoomSid ? " zoomed" : "");
      const dot = document.createElement("span");
      dot.className = "dot " + kindOf(p);
      c.appendChild(dot);
      c.appendChild(document.createTextNode(String(i + 1)));
      // 이름을 붙인 pane 만 `N 이름` 으로 보여준다.
      // (wiki 교훈 "생략은 부재처럼 읽힌다" — 이름이 있는데 안 보이면 기능이 없는 줄 안다.
      //  반대로 이름==번호인 자동 pane 까지 쓰면 폭만 먹는다)
      const nm = paneLabel(p.sid);
      if (nm) {
        const s = document.createElement("span");
        s.className = "nm";
        s.textContent = nm;                 // ⚠ innerHTML 금지 — 사용자가 입력한 문자열이다
        c.appendChild(s);
      }
      c.title = `${i + 1}번 pane${nm ? ` — ${nm}` : ""} · Alt+${i + 1} 전체화면 · Ctrl+P 이름`;
      c.onclick = () => focusPane(p.sid);
      box.appendChild(c);
    });
  }

  // ---------- 세로 세션 레일 (PC 전용) ----------
  // ⭐ 세션을 10개씩 켜두면 가로 탭바는 **구조적으로** 이름을 담지 못한다 — 탭 하나의 고정 비용이
  //   65px(패딩 22 + Powerline 화살표 16 + 점·번호·gap 27)이라 10탭이면 글자 한 자 들어가기
  //   전에 650px 이 나가고, 남은 폭을 flexbox 가 균등 압축해 **보고 있는 탭 이름까지** 지운다
  //   (사용자 제보 2026-09-09 스크린샷: `5 c…` `6 claud…` `9 claude…`).
  //   → 목록을 옆으로 눕힌다. 폭 190px 이면 `이름 · pane 수 · 작업 제목`이 다 들어간다.
  //
  // ⚠ 폰에는 쓰지 않는다 — 칩바(`renderPhoneNav`)+드로어가 이미 그 역할이고, 폰 폭에서
  //   190px 을 떼면 터미널이 못 쓰게 된다. 갈고리도 `renderChips` 에서 폰과 배타로 갈랐다.

  // 서버가 OSC 로 읽어준 창 제목에서 **스피너 글자만 떼고** 작업 요약을 남긴다.
  // 상태(대기/작업중)는 점 색이 이미 말하므로 글자로 또 쓰지 않는다.
  const railDesc = (s) => {
    const t = ((s && s.title) || "").trim();
    return spinState(t) ? t.slice(1).trim() : t;
  };

  function renderRail() {
    const box = $("#rail");
    if (!box || box.hidden) return;
    // ⚠ 4초 폴링이 이 함수를 다시 부른다 — 통째로 다시 그리면 스크롤이 맨 위로 튄다.
    const keep = box.scrollTop;
    box.innerHTML = "";

    // 머리줄 — 10개를 켜놓고 실제로 궁금한 것은 "몇 개가 내 입력을 기다리나"다.
    const wait = sessions.filter(s => spinState(s.title) === "idle").length;
    const busy = sessions.filter(s => spinState(s.title) === "busy").length;
    const head = document.createElement("div");
    head.className = "rl-head";
    head.innerHTML = `세션 ${sessions.length}` +
                     (wait ? ` · <span class="wait">대기 ${wait}</span>` : "") +
                     (busy ? ` · 작업중 ${busy}` : "");
    box.appendChild(head);

    tabNames().forEach((name, ti) => {
      const ps = tabPanes(name);
      const isActive = name === activeTab;
      const lead = (isActive && ps.find(p => p.sid === activeSid)) || ps[0];
      const expand = isActive && ps.length > 1;      // pane 은 보고 있는 탭만 펼친다

      const t = document.createElement("div");
      t.className = "rl-tab" + (isActive ? " on" : "") + (ps.some(p => p.alive) ? "" : " dead");
      const l1 = document.createElement("div");
      l1.className = "l1";
      l1.innerHTML = `<span class="dot ${kindOf(lead)}"></span>` +
                     // Ctrl+1~9 와 같은 번호. 10번째부터는 단축키가 없으므로 `·` 로 **명시**한다
                     // (빈칸으로 두면 렌더 실패처럼 읽힌다 — wiki "생략은 부재처럼 읽힌다")
                     `<span class="num">${ti < 9 ? ti + 1 : "·"}</span>` +
                     `<span class="nm"></span>` +
                     (ps.length > 1 ? `<span class="cnt">▦${ps.length}</span>` : "");
      l1.querySelector(".nm").textContent = name;    // ⚠ innerHTML 금지 — 사용자가 입력한 이름이다
      t.appendChild(l1);
      const desc = railDesc(lead);
      // 펼친 탭은 아래 pane 줄들이 각자 제목을 들고 있으므로 여기서 또 쓰지 않는다
      if (desc && !expand) {
        const d = document.createElement("div");
        d.className = "desc";
        d.textContent = desc;                        // ⚠ 같은 이유로 textContent
        t.appendChild(d);
      }
      t.title = `${name}${ps.length > 1 ? ` · pane ${ps.length}개` : ""}` +
                (desc ? `\n${desc}` : "") +
                (lead && lead.cwd ? `\n${lead.cwd}` : "") +
                (ti < 9 ? `\nCtrl+${ti + 1}` : "\n(10번째부터는 Ctrl 번호가 없다 — 눌러서 이동)");
      t.onclick = () => selectTab(name);
      t.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(name); } };
      t.ondblclick = () => renameTab(name);
      t.oncontextmenu = (e) => { e.preventDefault(); openMenu(e, name, lead && lead.sid); };
      box.appendChild(t);

      if (!expand) return;
      ps.forEach((p, i) => {
        const nm = paneLabel(p.sid), pd = railDesc(p);
        const r = document.createElement("div");
        // `hassub` = 이름과 제목을 **둘 다** 쓰는 줄. 제목만 있는 줄에 폭 상한을 걸면
        // 남는 자리를 두고 이름이 잘린다(CSS 의 `max-width:58%` 는 이 경우에만 필요하다).
        r.className = "rl-pane" + (p.sid === activeSid ? " on" : "") +
                      (p.sid === zoomSid ? " zoomed" : "") + (p.alive ? "" : " dead") +
                      (nm && pd ? " hassub" : "");
        r.innerHTML = `<span class="dot ${kindOf(p)}"></span><span class="num">${i + 1}</span>` +
                      `<span class="nm"></span><span class="sub"></span>`;
        // 이름을 붙인 pane 은 `이름` + 흐린 제목, 자동 pane 은 제목만(없으면 번호)
        r.querySelector(".nm").textContent = nm || pd || `패널 ${i + 1}`;
        r.querySelector(".sub").textContent = nm && pd ? pd : "";
        r.title = `${i + 1}번 pane${nm ? ` — ${nm}` : ""}${pd ? `\n${pd}` : ""}` +
                  `\nAlt+${i + 1} 전체화면 · Ctrl+P 이름`;
        r.onclick = () => focusPane(p.sid);
        r.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closePane(p.sid); } };
        r.oncontextmenu = (e) => { e.preventDefault(); openMenu(e, name, p.sid); };
        box.appendChild(r);
      });
    });
    box.scrollTop = keep;
  }

  // 레일을 켜고 끈다. 폭이 바뀌면 `ResizeObserver(#panes)` 가 PTY 재보고까지 태운다
  // (`scheduleResize` 의 400ms 디바운스를 그대로 탄다 — 여기서 따로 크기를 계산하지 않는다).
  const setRail = (on) => {
    if (isPhone) return;                     // 폰은 칩바+드로어가 그 역할이다
    railOn = !!on;
    localStorage.setItem("webterm.rail", railOn ? "1" : "0");
    document.body.classList.toggle("rail", railOn);
    $("#rail").hidden = !railOn;
    // 레일이 곧 탭 목록이다 — 같은 정보를 두 곳에 두면 폭만 먹는다
    $("#tabs").hidden = railOn;
    $("#panechips").hidden = railOn;
    if (railOn) renderRail();
    scheduleResize();
  };

  // ---------- 폰 내비 (큰 칩바 + 전체 목록 드로어) ----------
  // ⭐ PC 의 Powerline 탭바는 폰에서 손가락보다 작았다. 폰에서는 헤더 자리를
  //   `[≡] [▸탭 ●pane ●pane │ ▸탭 …]` 로 갈아끼운다 — wezterm-web 에서 편했던 그 배치다.
  //   탭 칩 = 그 탭으로, pane 칩 = 그 pane 으로 **한 번에** 간다(드릴다운 없음).

  // 탭이 다르면 먼저 탭을 옮기고 pane 을 고른다. 폰은 한 번에 한 pane 만 보이므로
  // `focusPane` 이 `renderPanes` 까지 해준다(그쪽 주석 참조).
  const goPane = (name, sid) => {
    if (name !== activeTab) selectTab(name);
    focusPane(sid);
  };

  function renderPhoneNav() {
    const box = $("#navchips");
    if (!box) return;
    box.innerHTML = "";
    tabNames().forEach((name, ti) => {
      if (ti) box.appendChild(Object.assign(document.createElement("div"), { className: "navsep" }));
      const ps = tabPanes(name);
      const lead = ps.find(p => p.sid === activeSid) || ps[0];
      const tab = document.createElement("div");
      tab.className = "navchip tabchip" + (name === activeTab ? " on" : "") +
                      (ps.some(p => p.alive) ? "" : " dead");
      tab.innerHTML = `<span class="dot ${kindOf(lead)}"></span><span class="t"></span>`;
      tab.querySelector(".t").textContent = name;      // ⚠ innerHTML 금지 — 사용자 입력 문자열
      tab.onclick = () => selectTab(name);
      box.appendChild(tab);
      // ⭐ pane 칩은 **지금 보고 있는 탭만** 펼친다. 전부 펼치면(wezterm-web 방식) pane 이 다섯인
      //   탭 하나가 칩바를 통째로 먹어 다른 탭이 화면 밖으로 밀린다 — 폰 폭에서는 그게 더 불편하다.
      //   접힌 탭에는 개수만 붙여 "안에 더 있다"를 보인다.
      if (ps.length < 2) return;
      if (name !== activeTab) {
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = "▦" + ps.length;
        tab.appendChild(cnt);
        return;
      }
      ps.forEach((p, i) => {
        const c = document.createElement("div");
        c.className = "navchip" + (p.sid === activeSid ? " on" : "") + (p.alive ? "" : " dead");
        c.innerHTML = `<span class="dot ${kindOf(p)}"></span><span class="t"></span>`;
        c.querySelector(".t").textContent = paneLabel(p.sid) || String(i + 1);
        c.onclick = () => goPane(name, p.sid);
        box.appendChild(c);
      });
    });
    // 활성 칩을 가로 가운데로. ⚠ `scrollIntoView` 는 페이지 전체를 움직일 수 있어 쓰지 않는다
    //   (wezterm-web 에서 같은 이유로 bar 내부 `scrollLeft` 만 조정했다).
    const act = box.querySelector(".navchip.on:not(.tabchip)") || box.querySelector(".navchip.on");
    if (act) {
      const br = box.getBoundingClientRect(), ar = act.getBoundingClientRect();
      box.scrollLeft += (ar.left + ar.width / 2) - (br.left + br.width / 2);
    }
  }

  function renderDrawer() {
    const list = $("#dw-list");
    if (!list) return;
    list.innerHTML = "";
    tabNames().forEach((name) => {
      const ps = tabPanes(name);
      const h = document.createElement("div");
      h.className = "dw-tab";
      h.innerHTML = `<span class="dot ${kindOf(ps[0])}"></span><span class="t"></span>` +
                    (ps.length > 1 ? `<span class="cnt">패널 ${ps.length}개</span>` : "");
      h.querySelector(".t").textContent = name;
      h.onclick = () => { selectTab(name); closeDrawer(); };
      list.appendChild(h);
      ps.forEach((p, i) => {
        const r = document.createElement("div");
        r.className = "dw-pane" + (p.sid === activeSid ? " on" : "") + (p.alive ? "" : " dead");
        r.innerHTML = `<span class="dot ${kindOf(p)}"></span><span class="num">${i + 1}</span>` +
                      `<span class="nm"></span><span class="cwd"></span>`;
        r.querySelector(".nm").textContent = paneLabel(p.sid) || `패널 ${i + 1}`;
        r.querySelector(".cwd").textContent = (p.cwd || "").split(/[\\/]/).pop() || "";
        r.onclick = () => { goPane(name, p.sid); closeDrawer(); };
        list.appendChild(r);
      });
    });
  }

  // ⭐ 안드로이드 **뒤로가기로 닫힌다.** 전체화면을 덮는 UI 를 뒤로가기가 못 닫으면
  //   사용자는 앱(PWA)을 통째로 빠져나가게 된다 — 폰에서 가장 흔한 사고다.
  //   그래서 열 때 히스토리를 한 칸 쌓고, 닫을 때 그 칸을 되돌린다.
  let dwPushed = false;
  const openDrawer = () => {
    renderDrawer();
    $("#drawer").hidden = false;
    if (!dwPushed) { dwPushed = true; try { history.pushState({ dw: 1 }, ""); } catch (e) {} }
  };
  const closeDrawer = () => {
    $("#drawer").hidden = true;
    if (dwPushed) { dwPushed = false; try { history.back(); } catch (e) {} }
  };
  addEventListener("popstate", () => {          // 뒤로가기로 온 경우 — 이미 닫혔으면 아무 일도 없다
    if (!$("#drawer").hidden) { dwPushed = false; $("#drawer").hidden = true; }
  });

  // ---------- 폰 관성 스크롤 ----------
  // xterm 의 viewport 는 터치 스크롤을 브라우저에 제대로 넘기지 않아, 밀어도 관성이 안 붙고
  // 한 줄씩 툭툭 끊긴다(WebGL 로 렌더를 빠르게 해도 그대로였다 = 렌더 부하 문제가 아니다).
  // wezterm-web 은 이 문제를 **xterm 을 버려서**(ansi_up + 네이티브 div) 해결했지만
  // webterm 은 PTY 직결이라 그럴 수 없다 → 관성을 직접 굴린다.
  //
  // 방식: 기본 터치 스크롤을 막고(`passive:false` + preventDefault) `scrollTop` 을 우리가 움직인다.
  //       손을 떼면 마지막 속도로 감속 루프를 돌린다. xterm 은 scroll 이벤트를 받아 알아서 다시 그린다.
  function attachInertia(paneEl) {
    const vp = paneEl.querySelector(".xterm-viewport");
    if (!vp || vp.dataset.inertia) return;
    vp.dataset.inertia = "1";
    // ⭐⭐ **`touch-action` 은 `preventDefault` 보다 세다.** CSS 는 `pan-y` 였는데(app.css),
    //   그건 브라우저에게 "세로 팬은 네가 해라"라고 **예약**해주는 선언이다. 그러면 세로로 끄는
    //   순간 브라우저가 compositor 에서 스크롤을 시작하고 **우리 `preventDefault` 를 무시**하며,
    //   진행 중이던 터치는 `touchcancel` 로 끊긴다 → 꾹 눌러 잡은 선택이 그 자리에서 죽고
    //   화면만 스크롤됐다(사용자 제보 2026-08-27: "스크롤은 내려가는데 드래그가 안 늘어난다").
    //   스크롤은 어차피 이 함수의 커스텀 관성이 전담하므로 브라우저 몫을 남길 이유가 없다.
    //   ⚠ CSS 가 아니라 **여기서** 끄는 이유: 관성이 실제로 붙은 뷰포트만 `none` 이 되어야
    //     한다(붙이지 못한 경우까지 `none` 이면 스크롤 수단이 아예 사라진다).
    vp.style.touchAction = "none";

    let lastY = 0, lastT = 0, vel = 0, raf = 0;
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    vp.addEventListener("touchstart", (e) => {
      stop();
      const t = e.touches[0];
      if (!t) return;
      lastY = t.clientY; lastT = performance.now(); vel = 0;
    }, { passive: true });

    vp.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      // ⭐ 선택 중에는 **스크롤을 포기한다.** 둘 다 같은 touchmove 를 먹으므로 여기서 물러나지
      //   않으면 화면이 손가락을 따라 같이 흘러 선택이 한 줄에 갇힌다.
      if (selecting) { vel = 0; e.preventDefault(); return; }
      const now = performance.now();
      const dy = lastY - t.clientY;
      const dt = Math.max(1, now - lastT);
      vp.scrollTop += dy;
      // px/frame 으로 환산(16ms 기준). 직전 속도와 섞어 튀는 값을 눌러준다.
      vel = vel * 0.3 + (dy / dt) * 16 * 0.7;
      lastY = t.clientY; lastT = now;
      e.preventDefault();          // 브라우저 기본 스크롤과 겹쳐 2배로 움직이는 것을 막는다
    }, { passive: false });

    vp.addEventListener("touchend", () => {
      if (selecting) { vel = 0; return; }      // 선택으로 끝난 제스처에 관성을 붙이면 안 된다
      if (Math.abs(vel) < 0.6) return;
      const step = () => {
        vp.scrollTop += vel;
        vel *= 0.94;                                   // 감속 계수 — 클수록 더 멀리 미끄러진다
        const atEdge = vp.scrollTop <= 0 ||
                       vp.scrollTop >= vp.scrollHeight - vp.clientHeight - 1;
        if (Math.abs(vel) < 0.4 || atEdge) { raf = 0; return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, { passive: true });
  }

  // ---------- pane 레이아웃 ----------
  function renderPanes() {
    const wrap = $("#panes");
    syncZoom();          // 이 탭의 줌을 고른다(탭이 바뀌었으면 그 탭 것으로 · 닫힌 pane 이면 해제)

    // ⚠ 렌더 중 포커스가 날아가면 "입력하다 갑자기 먹통"이 된다(폴링이 4초마다 이 함수를 부른다).
    //   → 위치가 이미 맞으면 DOM 을 건드리지 않고, 터미널에 있던 포커스는 끝에 복원한다.
    const hadFocus = document.activeElement && document.activeElement.closest("#panes");

    // 죽은 세션만 정리한다. **탭이 바뀌었다고 pane 을 파괴하지 않는다** —
    // 파괴하면 WS 재연결 + backlog(2MB) 재생이 일어나 전환이 느려진다.
    const alive = new Set(sessions.map(x => x.sid));
    for (const [sid] of [...panes]) if (!alive.has(sid)) destroyPane(sid);

    // 활성 탭의 pane 은 없으면 만든다(다른 탭은 이미 만들어진 것만 유지).
    tabPanes(activeTab).forEach(s2 => { if (!panes.has(s2.sid)) createPane(s2.sid); });

    // ⭐ 탭마다 그룹(그리드)을 하나씩 둔다 — 이유는 app.css 의 `.tabgroup` 주석 참조.
    const groups = new Map();
    for (const el of wrap.children) {
      if (el.classList.contains("tabgroup")) groups.set(el.dataset.tab, el);
    }

    const used = new Set();
    for (const name of tabNames()) {
      const list = tabPanes(name).filter(s2 => panes.has(s2.sid));
      if (!list.length) continue;
      used.add(name);

      let g = groups.get(name);
      if (!g) {
        g = document.createElement("div");
        g.className = "tabgroup";
        g.dataset.tab = name;
        wrap.appendChild(g);
        groups.set(name, g);
      }

      const isActive = name === activeTab;
      const n = list.length;
      // 폰에서는 분할해도 한 번에 하나만 본다(좁은 화면에서 나누면 양쪽 다 못 쓴다)
      const zoom = isActive ? (zoomSid || (isPhone && n > 1 ? activeSid : null)) : null;
      const dir = layouts[name] || "h";

      // ⚠ **줌이어도 그리드는 분할 상태를 유지한다.**
      //   예전에는 줌이면 1x1 로 바꿨는데, 그건 나머지 pane 을 `display:none` 으로
      //   **없앴을 때만** 맞는 계산이었다. 지금은 pane 이 레이아웃에 그대로 남으므로
      //   1x1 로 만들면 **세 pane 이 모두 전체 폭으로 커진다** → 줌을 풀 때 다시 줄어들며
      //   스크롤·렌더가 깨진다(2026-08-24 제보: "alt+1 하면 다 깨짐").
      //   줌은 `.pane.zoom` 이 `grid-area:1/1/-1/-1` 로 **위를 덮는 것**으로 충분하다
      //   (pane 배경이 불투명하므로 뒤가 비치지 않는다). 나머지는 자기 셀에서 크기를 지킨다.
      if (n <= 1) {
        g.style.gridTemplateColumns = "1fr";
        g.style.gridTemplateRows = "1fr";
      } else if (dir === "h") {
        g.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
        g.style.gridTemplateRows = "1fr";
      } else {
        g.style.gridTemplateColumns = "1fr";
        g.style.gridTemplateRows = `repeat(${n}, 1fr)`;
      }
      g.classList.toggle("split", n > 1);
      g.classList.toggle("off", !isActive);

      list.forEach((s2, i) => {
        const p = panes.get(s2.sid);
        if (isPhone) attachInertia(p.el);   // viewport 는 open 직후 없을 수 있어 여기서도 한 번 더
        // 이름을 붙였으면 `1 이름`, 아니면 번호만 (::before 의 content:attr(data-idx))
        const nm = paneLabel(p.sid);
        const idxLabel = nm ? `${i + 1} ${nm}` : String(i + 1);
        if (p.el.dataset.idx !== idxLabel) p.el.dataset.idx = idxLabel;
        if (g.children[i] !== p.el) g.insertBefore(p.el, g.children[i] || null);
        p.el.classList.toggle("zoom", !!zoom && p.sid === zoom);
        p.el.classList.toggle("dim", !!zoom && p.sid !== zoom);   // 줌 중 가려지는 pane
        p.el.classList.toggle("active", p.sid === activeSid);
      });
    }

    // 빈 그룹은 치운다(탭이 사라진 경우)
    for (const [name, g] of groups) if (!used.has(name)) g.remove();

    // 터미널에 있던 포커스를 되돌린다(위 hadFocus 주석 참조)
    if (hadFocus) { const p = panes.get(activeSid); if (p) focusTerm(p.term); }
    scheduleResize();   // 렌더 직후 재측정 — 디바운스를 태워 폴링과 되먹이지 않게 한다
  }

  function createPane(sid) {
    const p2 = {};                         // 늦게 실행되는 콜백이 pane 을 참조하기 위한 상자
    const el = document.createElement("div");
    el.className = "pane";
    const host = document.createElement("div");
    host.className = "host";
    el.appendChild(host);
    el.onmousedown = () => focusPane(sid);
    // 사용자가 직접 스크롤·타이핑하면 그 pane 의 자동 스크롤 보정을 전부 멈춘다
    const markScrolled = () => {
      if (p.replaying) return;         // 재생 중 스크롤은 의미가 없다(위 주석 참조)
      p.userScrolled = true;
      clearTimeout(p.settleT);
    };
    el.addEventListener("wheel", markScrolled, { passive: true });
    el.addEventListener("touchstart", markScrolled, { passive: true });
    el.addEventListener("keydown", markScrolled);
    // ⚠ 폰에서는 이 경로를 쓰지 않는다. 안드로이드 크롬은 **꾹 누르기에 `contextmenu` 를 쏘는데**,
    //   그 타이밍(~500ms)이 우리 선택 제스처(450ms)와 겹쳐 메뉴와 선택이 동시에 터진다.
    //   폰의 메뉴 진입점은 **꾹 누르고 안 끌고 떼기**다(아래 터치 제스처 블록).
    el.oncontextmenu = (e) => { e.preventDefault(); if (isPhone) return; openMenu(e, activeTab, sid); };
    // ⭐ 더블클릭 = 이 pane 전체화면 토글 — WezTerm 의 그 손맛(`Alt+숫자` 의 마우스판).
    //   ⚠ 대가로 xterm 기본 '단어 선택'을 잃는다. WezTerm 도 정확히 같은 맞바꿈을 했다
    //     (CLAUDE.md 단축키표: "더블클릭 = 패널 최대화/복구 토글, 기본 '단어 선택'을 대체").
    //     드래그 선택 → 자동복사는 그대로라 복사 수단이 사라지는 것은 아니다.
    //   더블클릭 전에 xterm 이 이미 단어를 물어놓으므로 선택을 지우고 줌한다.
    el.ondblclick = () => {
      // ⚠ 폰은 제외한다 — 브라우저가 **더블탭에 합성 `dblclick` 을 얹어주기 때문에**
      //   "더블탭 = 입력 모드 토글"(터치 제스처 블록)과 이 줌 토글이 **한 번에 둘 다** 걸렸다.
      //   폰에서 pane 줌은 특수키 도크의 Alt 계층(`zoom`)이 담당하므로 잃는 기능도 없다.
      if (isPhone) return;
      const ps = tabPanes(activeTab);
      const i = ps.findIndex((x) => x.sid === sid);
      if (i < 0) return;
      try { term.clearSelection(); } catch (e) {}
      zoomPane(i);
    };

    const term = new Terminal({
      theme: THEME,
      // Sarasa Mono K = 한글 1자가 영문 2칸과 **정확히** 같은 폭. CJK 터미널의 자간 어긋남이 사라진다.
      // ⚠ 폰트는 지정한다고 쓰이는 게 아니다 — JetBrains Mono 는 WezTerm 내장이라 시스템에 없고,
      //   예전엔 조용히 Consolas 로 폴백돼 있었다(실측: 셀 폭 8.084 = Consolas 폭).
      // ⚠ Mono 가 아니라 **Fixed**. Mono 는 ambiguous 문자(① · ←)를 전각으로 그려 옆 칸을 덮는다.
      // 이모지는 폰트에 없어 어차피 폴백되므로, 시스템 이모지 폰트를 **명시**해 일관되게 만든다
      // (WezTerm 은 Noto Color Emoji 를 쓴다 — 브라우저는 Windows 기본인 Segoe UI Emoji).
      // 순서가 곧 역할 분담이다 — 앞 폰트에 글리프가 없으면 다음으로 넘어간다:
      //   영문·기호 → JetBrains Mono (WezTerm 이 쓰는 그 폰트. `·` 도 여기서 1칸으로 그려진다)
      //   한글·①·← → Sarasa Fixed K (폭이 정확하고 ambiguous 를 반각으로 그린다)
      //   이모지     → Segoe UI Emoji (Windows 기본. WezTerm 은 Noto Color Emoji 라 모양이 다르다)
      //
      // ⭐ 이 조합의 폭 비율이 WezTerm 과 같아진다:
      //      WezTerm  셀 9px  / 한글 15px  / 2칸 18px  = 83%
      //      여기     셀 .6em / 한글 1.0em / 2칸 1.2em = 83%
      fontFamily: '"JetBrains Mono","Sarasa Fixed K","Segoe UI Emoji","Consolas",ui-monospace,monospace',
      fontSize,
      // ⚠ 500(Medium)을 요청하면 안 된다 — Sarasa 는 300/400/700 만 있어서
      //   브라우저가 없는 굵기를 합성(synthetic bold)하며 획이 뭉개진다.
      // 500(Medium) = `.wezterm.lua` 의 weight="Medium" 과 같은 굵기.
      // JetBrains Mono 는 **실제로 500 파일이 있어** 합성되지 않는다(합성되면 획이 뭉갠다).
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1.15,           // .wezterm.lua 의 line_height
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      // ⭐⭐⭐ 박스 드로잉(`─│┌┐└┘├┤┬┴┼` U+2500~257F)·블록 문자를 **폰트 대신 xterm 이 직접 그린다.**
      //
      // ⚠ 실측(2026-08-24): `=` 143개는 한 줄에 들어가는데 **`─` 143개는 넘쳐서 다음 줄로 밀렸다**
      //   → `─` 글리프가 셀보다 **약 1.1칸 넓게** 그려진다. 그래서 claude 가 그린 구분선이
      //   화면을 넘어가며 잘렸고, 나는 그걸 "짧다"고 읽어 크기 문제로 오해했다.
      //   원인: `─`(U+2500)는 East Asian Ambiguous 문자인데 폰트 스택의 어느 폰트에도
      //   제대로 없다(`sarasa-fixed-k.css` 의 108개 서브셋에 U+2500 대역이 아예 없다) →
      //   폴백 폰트가 자기 폭으로 그린다.
      // ⚠ 이 옵션은 **canvas/WebGL 렌더러에서만** 효력이 있다 — DOM 렌더러는 폰트로 그린다.
      //   그래서 WebGL 이 실제로 붙었는지가 중요하다(아래 attachWebgl 의 진단 참조).
      customGlyphs: true,
      windowsPty: { backend: "conpty" },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(host);
    // WebGL 렌더러 — 캔버스를 dpr 배 해상도로 그리므로 **배율 화면에서 더 또렷하다**.
    // 기본 DOM 렌더러는 CSS px 단위로 글자를 배치해서, dpr 1.5 같은 비정수 배율이면
    // 셀 폭(8.084...px)이 물리 픽셀 경계에 안 맞아 미세하게 번진다.
    //
    // ⚠ 단 예전에 **화면 전체가 밀려 그려지는** 사고가 있었다(dpr 0.9. 버퍼는 멀쩡한데 그림만 틀어짐).
    //   그래서 기본은 끔이고, 켠 뒤 이상하면 되돌릴 길을 반드시 열어둔다
    //   (우클릭 메뉴 토글 · `?webgl=0` · localStorage).
    // ⭐⭐⭐ WebGL 은 **웹폰트가 다 붙은 뒤에** 얹는다.
    //
    // ⚠ 사고 기록(2026-08-24): "구분선이 pane 폭에 못 미치고 오른쪽에 공백이 남는다" 를
    //   크기 문제로 오해해 한참 헤맸다. `size-diag` 는 계속 "칸 수 일치"라고 알려주고 있었다.
    //   진짜 원인은 **WebGL 의 텍스처 아틀라스**다 — WebGL 렌더러는 글리프를 아틀라스에
    //   구워 캐시하는데, 그 시점에 웹폰트가 아직 안 붙어 있으면 **폴백 글리프가 굳는다.**
    //   폰트가 나중에 도착해도 다시 굽지 않아, 폴백 폭(실측 8.0px)으로 계속 그린다
    //   (정상은 JetBrains Mono 8.82px). 그래서 claude 가 그린 69칸 구분선이 좁게 그려져
    //   pane 오른쪽에 공백이 남았다. **DOM 렌더러는 매번 브라우저가 그리므로 이 문제가 없다**
    //   — 사용자가 "WebGL 끄니까 딱 맞는다"고 한 것이 결정적 단서였다.
    //   같은 페이지의 두 pane 이 서로 다른 폭으로 그려지던 것도 이것으로 설명된다
    //   (먼저 만들어진 pane 만 폰트 로드 전이었다).
    if (useWebgl()) {
      const attachWebgl = () => {
        try {
          const g = new WebglAddon.WebglAddon();
          // ⭐⭐ 컨텍스트를 잃으면 **WebGL 을 버리고 DOM 렌더러로 되돌아간다.**
          //   `dispose()` 가 `_createRenderer()` + `handleResize` 로 되돌려 주지만
          //   (vendor/addon-webgl.js 실측), 그것만으로는 **이미 그려져 있던 화면이 안 돌아온다**
          //   → 전체 재도화까지 함께 한다. 다시 붙이지는 않는다(잃은 이유가 그대로면 또 잃는다).
          g.onContextLoss(() => {
            try { g.dispose(); } catch (_) {}
            const q = p2.ref;
            if (q) { q.webgl = null; redraw(q); }
            diag({ ev: "webgl-context-lost", sid: sid.slice(0, 8) });
          });
          term.loadAddon(g);
          // 아틀라스를 나중에 비울 수 있도록 pane 에 보관한다.
          // ⚠ 이 콜백은 폰트 로드를 기다렸다 실행되므로, pane 이 이미 만들어졌을 수도
          //   (그러면 `p2.ref`) 아직 아닐 수도(그러면 상자에 두고 아래에서 옮긴다) 있다.
          if (p2.ref) p2.ref.webgl = g; else p2.webgl = g;
          // ⭐ 붙었는지를 **로그로 남긴다.** "WebGL 켰는데 왜 안 되나"를 추측하지 않으려고.
          diag({ ev: "webgl", ok: true, sid: sid.slice(0, 8),
                 fontsStatus: document.fonts ? document.fonts.status : "?" });
        } catch (e) {
          console.warn("webgl 미지원", e);
          diag({ ev: "webgl", ok: false, sid: sid.slice(0, 8), err: String(e).slice(0, 120) });
        }
      };
      // ⚠ **`document.fonts.status` 를 믿으면 안 된다.** 서브셋 웹폰트(`unicode-range`)는
      //   "그 문자가 화면에 나타날 때" 로드되므로, 페이지 초기에는 로드할 게 없어서 `"loaded"` 로
      //   보고된다. 그 상태에서 WebGL 을 붙이면 **아직 안 쓰인 폰트는 로드 전**이고,
      //   아틀라스에 폴백 글리프가 구워진다. 그래서 `fonts.ready` 만으로는 부족했다
      //   (실측 2026-08-24: 같은 브라우저인데 pane 마다 `─` 폭이 달랐다 —
      //    먼저 만들어진 pane 만 로드 전이었다).
      // → 필요한 문자를 **명시적으로 로드**한 뒤 붙인다. 박스 드로잉(`─│`)을 포함시키는 것이 핵심.
      const need = [
        ['500 ' + fontSize + 'px "JetBrains Mono"', 'M─│┌┐└┘├┤┬┴┼'],
        ['400 ' + fontSize + 'px "Sarasa Fixed K"', '가─│①←'],
      ];
      const warm = Promise.all(need.map(([f, t]) => {
        try { return document.fonts.load(f, t).catch(() => null); } catch (_) { return null; }
      }));
      Promise.race([warm, new Promise((r) => setTimeout(r, 1500))])   // 폰트가 안 와도 1.5초면 진행
        .then(() => setTimeout(attachWebgl, 20));
    }
    applyInputMode(term);          // 생성 즉시 — focus() 보다 먼저여야 한다
    if (isPhone) attachInertia(el);

    const p = { sid, el, host, term, fit, ws: null, retry: null, delay: 500, attachedAt: 0 };
    p2.ref = p;                            // 위 attachWebgl 이 늦게 실행돼도 이 pane 을 찾는다
    if (p2.webgl) p.webgl = p2.webgl;      // 상자에 먼저 담긴 경우를 옮겨온다
    panes.set(sid, p);

    // ConPTY 의 DA 질의에 xterm 이 자동응답하는데, 그 응답이 셸 프롬프트에 `[?1;2c` 로 에코된다.
    // 접속 직후의 자동응답만 버린다.
    const AUTO_REPLY = /^\x1b\[\??[0-9;]*[cnR]$/;
    term.onData(d => {
      if (performance.now() - p.attachedAt < 1500 && AUTO_REPLY.test(d)) return;
      wsend(p, { t: "i", d });
    });
    // ⭐⭐ 붙여넣기 — **텍스트와 이미지의 경로가 다르다.**
    //
    // ⚠ 처음에는 Ctrl+V 를 통째로 가로채 0x16 만 보냈다. PowerShell 은 PSReadLine 이 그 키를
    //   Paste 로 바인딩해 두어 동작했지만, **claude 입력창에서는 붙여넣기가 죽었다** —
    //   claude 는 터미널이 보내는 **bracketed paste**(ESC[200~ … ESC[201~)로 텍스트를 받는데,
    //   키를 가로채면 브라우저 paste 이벤트가 아예 안 떠서 그 경로가 끊긴다.
    //   (claude 바이너리 실측: `case "[200~":` 처리와 `Get-Clipboard -Raw` 호출이 둘 다 있다.)
    //
    // 그래서 갈라놓는다:
    //   · **텍스트** → 아무것도 하지 않는다. xterm 의 기본 붙여넣기가 bracketed paste 로 보낸다.
    //   · **이미지** → 웹 페이지는 이미지를 터미널로 흘려보낼 수 없다. 대신 0x16(Ctrl+V)만 보내
    //     **claude 가 스스로 OS 클립보드를 읽게** 한다 → `[Image #N]` 이 만들어진다.
    //     claude 도 이 PC 에서 도니 클립보드가 같다. 폰은 예외 — 폰 클립보드는 PC 가 못 읽는다.
    host.addEventListener("paste", (e) => {
      if (isPhone) return;
      const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
      const hasImage = items.some((it) => it.type && it.type.indexOf("image/") === 0);
      const hasText = items.some((it) => it.kind === "string");
      if (!hasImage || hasText) return;          // 텍스트가 있으면 xterm 기본 경로가 맞다
      e.preventDefault();
      e.stopPropagation();
      // ⚠ 원격에서는 `0x16`(= claude 가 **서버 PC** 클립보드를 읽는 경로)이 엉뚱한 그림을 붙인다.
      //   브라우저가 쥔 이미지를 업로드해서 그 경로를 붙인다(폰 업로드와 같은 수법).
      if (isRemote) {
        const f = items.map((it) => it.getAsFile && it.getAsFile()).filter(Boolean);
        if (f.length) uploadFiles(f, p);
        return;
      }
      wsend(p, { t: "i", d: "\x16" });
    }, true);
    // ⭐ 드래그로 선택하면 **즉시 클립보드에 복사**한다(WezTerm 의
    //   `CompleteSelection("ClipboardAndPrimarySelection")` 과 같은 손맛).
    //   webterm 에는 이 기능이 아예 없었다 — WezTerm 에서 되던 것이라 있는 줄 알기 쉽다.
    //
    // ⚠ `onSelectionChange` 가 아니라 `mouseup` 에서 복사한다:
    //   ① 드래그 도중 매 픽셀마다 클립보드를 쓰지 않는다(선택이 끝난 뒤 한 번)
    //   ② `navigator.clipboard.writeText` 는 **사용자 제스처 안에서만** 허용된다 —
    //      `mouseup` 은 제스처지만 `onSelectionChange` 콜백은 아닐 수 있다.
    host.addEventListener("mouseup", () => {
      const sel = term.getSelection();
      if (!sel || !sel.trim()) return;          // 클릭으로 선택을 지운 경우
      copyToClipboard(sel);
    });
    // 앱 단축키는 터미널로 흘려보내지 않는다(위 isAppKey 주석 참조)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // ⭐⭐ Shift+Enter = **줄바꿈**(전송하지 않고 다음 줄로).
      //
      // ⚠ 터미널 프로토콜에는 "Shift+Enter" 라는 신호가 없다 — xterm 도 Shift 를 무시하고
      //   그냥 \r(전송)을 보낸다. 그래서 iTerm2·VSCode 는 claude 가 **키바인딩을 따로 설치**해준다
      //   (바이너리의 isShiftEnterKeyBindingInstalled). 우리 터미널은 그 목록에 없으니
      //   여기서 직접 만들어준다 — claude 가 화면에 안내하는 공식 대안인 **ctrl+j (라인피드 0x0A)**.
      //   폰 도크의 ↵ 키가 보내는 것과 같은 바이트다(KEY_SEQ.shiftenter).
      // ⭐⭐⭐ Ctrl+V — **WezTerm 과 같은 방식**: 이미지면 PNG 로 저장하고 그 경로를 붙여넣는다.
      //
      // ⚠ 여기까지 오는 데 두 번 틀렸다:
      //   ① 가만히 두면 xterm 이 터미널 표준대로 0x16(SYN)을 보낸다 → PowerShell 은 PSReadLine 이
      //      Paste 로 바인딩해 두어 붙지만, **claude 는 0x16 을 `chat:imagePaste` 로 해석**해
      //      텍스트가 영영 안 붙었다("파워쉘에선 되는데 claude 에서만 안 된다").
      //   ② 그래서 브라우저 클립보드(`navigator.clipboard.readText`)로 바꿨더니 텍스트는 됐지만
      //      **이미지는 여전히 불가** — 웹 페이지는 이미지 바이트를 터미널로 흘려보낼 수 없고,
      //      claude 가 스스로 클립보드를 읽는 경로도 webterm PTY 안에서는 안 통했다.
      //
      // → WezTerm 이 이미 풀어둔 문제였다. `.wezterm.lua` 의 Ctrl+V 핸들러는
      //   동봉된 `scripts/clipboard_paste.ps1` 을 돌려 **이미지면 %TEMP%/wezterm_clip 에 PNG 로
      //   저장한 뒤 그 경로를 paste** 한다(텍스트면 텍스트 그대로). claude 는 경로를 받으면 읽는다.
      //   webterm 도 같은 스크립트를 서버(`/api/clipboard`)에서 돌려 결과를 그대로 붙여넣는다.
      //
      // ⚠ 폰은 예외 — 그 스크립트는 **PC 클립보드**를 읽는다. 폰에서 복사한 것과는 무관하므로
      //   폰은 브라우저 클립보드(텍스트)를 쓴다.
      // ⭐ 2026-08-27 추가: **서버 클립보드는 "브라우저와 서버가 같은 기계일 때"만 옳다.**
      //   원격(다른 PC·폰)에서는 브라우저 클립보드를 읽는다. 원격에서도 굳이 **서버 PC 의**
      //   클립보드(거기서 찍어둔 스샷 등)를 붙이고 싶으면 **Ctrl+Shift+V**.
      if ((e.key === "v" || e.key === "V") && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const browserClip = isPhone || isRemote;         // 기본 출처가 브라우저인 접속인가
        const wantPc = e.shiftKey ? browserClip : !browserClip;   // Shift 는 출처를 뒤집는다
        if (wantPc) {
          fetch("/api/clipboard")
            .then((r) => r.json())
            .then((j) => { if (j && j.ok) pasteText(p, j.text); })
            .catch(() => {
              // 서버 경로가 막히면 브라우저 클립보드로라도(텍스트만)
              navigator.clipboard.readText().then((t) => pasteText(p, t)).catch(() => {});
            });
        } else {
          pasteFromBrowserClip(p);
        }
        return false;
      }
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        wsend(p, { t: "i", d: "\n" });
        return false;                      // xterm 이 전송(CR)을 덧붙이지 않게 막는다
      }
      return !isAppKey(e);
    });
    connect(p);
    return p;
  }

  function destroyPane(sid) {
    const p = panes.get(sid);
    if (!p) return;
    clearTimeout(p.retry);
    if (p.ws) { p.ws.onclose = null; p.ws.close(); }
    try { p.term.dispose(); } catch (e) {}
    p.el.remove();
    panes.delete(sid);
  }

  // ---------- WS ----------
  const wsend = (p, o) => { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };

  function connect(p) {
    clearTimeout(p.retry);
    if (p.ws) { p.ws.onclose = null; p.ws.close(); }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // `cid` = **브라우저 고유 ID**. 서버가 `⤢` 주인을 판정하는 열쇠다.
    // ⚠ 소켓 단위로 주인을 잡으면 안 된다 — 폰은 화면을 끄거나 앱을 전환하기만 해도
    //   WS 가 끊겼다 붙는다(로그에 대량 detach→attach 가 그것). 그때마다 주인 자격이
    //   사라지면 폴드를 펴자마자 크기가 PC 것으로 튀어버린다.
    const ws = new WebSocket(`${proto}://${location.host}/ws/${p.sid}?cid=${encodeURIComponent(CID)}`);
    p.ws = ws;
    ws.onopen = () => {
      p.attachedAt = performance.now();
      // ⭐⭐ `reset()` 은 **붙은 뒤에** 한다(붙을 때마다 backlog 로 다시 그린다 — 복원의 단일 소스).
      //
      // ⚠ 예전에는 `connect()` 진입 즉시 비웠다. 그러면 **연결이 안 되는 동안 화면이 텅 빈다** —
      //   폰이 절전에서 깨거나 터널이 아직 안 붙은 순간에 재연결을 시도하면, 화면을 먼저
      //   지워놓고 backlog 는 오지 않으므로 사용자에게는 빈 화면만 남는다. 그 상태는
      //   재연결이 성공할 때까지 안 풀리고, 새로고침(크기 재협상)으로도 글자가 돌아오지 않는다
      //   (제보 2026-09-07: "빈 화면 + 새로고침 무반응, 다른 탭 갔다 오면 나온다" 가 이것이다).
      //   붙은 뒤에 비우면 끊긴 동안에도 **옛 화면을 그대로 읽을 수 있고** 상태는 `#offline` 이 알린다.
      p.term.reset();
      p.replaying = true;              // 새 backlog 가 흘러든다 — 끝날 때까지 맨 아래를 붙잡는다
      p.userScrolled = false;
      p.delay = 500;
      $("#offline").hidden = true;
      resizePane(p);
      if (p.sid === activeSid) focusTerm(p.term);   // 읽기 모드면 포커스를 주지 않는다
    };
    ws.onmessage = (ev) => {
      if (ev.data === "") {                       // ping 에코 = 지연 측정
        const ms = performance.now() - pingAt, lag = $("#lag");
        if (performance.now() < lagHold) return;  // `flash()` 가 같은 칸을 쓰는 중이면 건드리지 않는다
        if (ms > 50) { lag.hidden = false; lag.textContent = ms.toFixed(0) + "ms"; }
        else lag.hidden = true;
        return;
      }
      p.term.write(ev.data);
      // ⭐⭐ **backlog 재생 중에는 맨 아래를 붙잡고 간다.**
      //
      // ⚠ 처음 여는 탭은 그때 pane 이 생기고 WS 가 붙으며 **backlog(최대 2MB)가 재생**된다.
      //   그동안 버퍼가 계속 늘어나므로 **스크롤 위치라는 개념이 성립하지 않는다** —
      //   그 와중에 휠을 굴리면 늘어나는 버퍼에 밀려 **맨 위로 끌려간다**
      //   (2026-08-24 제보: "바로 스크롤이 안 되고, 위로 굴리면 가장 위로 가버린다").
      //   앞서 "사용자가 스크롤하면 보정을 멈춘다"로 고쳤더니 오히려 **맨 위에 갇혔다** —
      //   멈출 게 아니라 **재생이 끝날 때까지 기다렸다가** 자유를 주는 것이 맞다.
      //   재생은 보통 1초 안에 끝난다(데이터가 250ms 조용해지면 끝난 것으로 본다).
      // ⚠ 재생 상태에 **시간 상한**을 둔다. 계속 출력 중인 세션(작업 중인 claude)은
      //   250ms 이상 조용해지는 순간이 안 와서 `replaying` 이 영원히 안 풀린다 →
      //   사용자가 위로 스크롤을 못 하고 계속 맨 아래로 끌려간다(검증에서 실제로 재현됐다).
      //   backlog 재생은 1초 안에 끝나므로 3초면 넉넉하다. 그 뒤는 xterm 의 기본 동작에 맡긴다
      //   (맨 아래를 보고 있으면 따라가고, 위로 올려뒀으면 그 자리를 지킨다).
      if (p.replaying && performance.now() - p.attachedAt > 3000) p.replaying = false;
      if (p.replaying) {
        p.term.scrollToBottom();
        clearTimeout(p.settleT);
        p.settleT = setTimeout(() => {
          p.replaying = false;                 // 이제부터 스크롤은 사용자 것이다
          p.term.scrollToBottom();
        }, 250);
      }
    };
    ws.onclose = (ev) => {
      p.closedAt = performance.now();          // 워치독(`healPanes` ②)이 방치 시간을 잰다
      if (p.sid === activeSid) $("#offline").hidden = false;
      // 4000/4004 = 서버가 의도적으로 닫음(세션 종료·없는 세션) → 재시도하지 않는다
      if (ev && (ev.code === 4000 || ev.code === 4004)) { refresh(); return; }
      p.retry = setTimeout(() => connect(p), p.delay);
      p.delay = Math.min(p.delay * 1.6, 5000);    // 지수 백오프
    };
    ws.onerror = () => { if (p.sid === activeSid) $("#offline").hidden = false; };
  }

  // ⭐⭐ 붙여넣기 전송 — **마커를 반드시 붙인다.**
  //
  // claude 는 `ESC[200~ … ESC[201~`(bracketed paste)로 감싸진 것만 "붙여넣기"로 본다.
  // 그래야 이미지 경로를 받아 `[Image #N]` 으로 바꾸고, 여러 줄도 한 덩어리로 처리한다.
  //
  // ⚠ 그런데 xterm 의 `term.paste()` 는 **자기가 아는 모드**로만 판단한다. 그 모드는 앱이
  //   켤 때(`ESC[?2004h`) 알게 되는데, webterm 은 재연결마다 `term.reset()` 후 backlog 를
  //   재생하므로 **링버퍼(2MB)에서 그 시퀀스가 밀려나간 오래된 세션은 모드를 영영 모른다.**
  //   실측(2026-08-24): 같은 탭의 두 pane 이 `bracketedPaste: false / true` 로 갈렸고,
  //   false 인 쪽에서 이미지 경로가 `[Image #N]` 이 아니라 **평문으로 찍혔다.**
  //   → 모드를 모르면 우리가 직접 감싼다. PSReadLine 도 이 마커를 이해한다(실측 확인).
  const pasteText = (p, text) => {
    if (!p || !text) return;
    const bp = p.term.modes && p.term.modes.bracketedPasteMode;
    if (bp) p.term.paste(text);                       // 모드를 아는 경우는 xterm 에 맡긴다
    else wsend(p, { t: "i", d: "\x1b[200~" + text + "\x1b[201~" });
  };

  // ⭐⭐ 클립보드 → 현재 pane. **출처가 둘**이라 우선순위를 인자로 받는다.
  //
  //   · 폰 클립보드 = 브라우저 `navigator.clipboard.readText()`
  //     ⚠ **사용자 제스처 안에서만** 허용된다(안드로이드 크롬은 붙여넣기 확인 칩도 띄운다).
  //       도크 키 탭은 제스처 안이라 통하지만, 타이머·자동 호출로는 못 쓴다.
  //   · PC 클립보드 = 서버 `/api/clipboard` → 동봉된 `scripts/clipboard_paste.ps1`
  //     (WezTerm Ctrl+V 와 **같은 스크립트** — 이미지면 %TEMP% 에 PNG 로 저장한 뒤 그 경로를 준다.
  //      claude 는 경로를 받으면 읽는다. 폰에서 PC 로 찍어둔 스샷을 물릴 때 이 경로가 유일하다.)
  //
  //   붙이는 것은 항상 `pasteText` — bracketed paste 로 감싸는 책임은 그쪽에 있다(위 주석).
  const readPhoneClip = () => (navigator.clipboard && navigator.clipboard.readText)
    ? navigator.clipboard.readText()
    : Promise.reject(new Error("브라우저 클립보드 미지원"));
  const readPcClip = () => fetch("/api/clipboard").then(r => r.json()).then((j) => {
    if (!j || !j.ok) throw new Error((j && j.error) || "PC 클립보드 실패");
    return j.text;
  });

  // ⭐⭐ 파일 업로드(폰 → PC) — **붙여넣기와 같은 수법**이다: 서버가 받아서 저장하고,
  //   우리는 **경로만** pane 에 붙인다(웹 페이지는 바이트를 터미널로 흘려보낼 수 없다).
  //
  // ⚠ `<input type="file">` 의 `click()` 은 **사용자 제스처 안에서만** 열린다 —
  //   도크 키 탭은 그 안이라 통하지만, 업로드가 끝난 뒤 자동으로 다시 여는 식은 안 된다.
  //   input 은 한 번 만들어 재사용한다(매번 만들면 안드로이드에서 이전 선택창이 남는 일이 있다).
  let fileInput = null;
  const pickAndUpload = () => {
    if (!panes.get(activeSid)) { flash("pane 없음"); return; }
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.multiple = true;
      fileInput.hidden = true;
      // 값을 비워두지 않으면 **같은 파일을 두 번 고를 때 change 가 안 뜬다**
      fileInput.addEventListener("change", () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = "";
        if (files.length) uploadFiles(files);
      });
      document.body.appendChild(fileInput);
    }
    fileInput.click();
  };

  const uploadFiles = (files, pane) => {
    const p = pane || panes.get(activeSid);
    if (!p) return;
    const fd = new FormData();
    let total = 0;
    for (const f of files) { fd.append("files", f, f.name); total += f.size; }
    flash("업로드 " + files.length + "개…");
    fetch("/api/upload", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) throw new Error((j && j.error) || "업로드 실패");
        // 경로에는 공백이 없다(서버 `_safe_name` 이 `_` 로 바꾼다) → 그냥 공백으로 이어도 안전하다.
        pasteText(p, j.files.map((f) => f.path).join(" "));
        const kb = Math.round(total / 1024);
        flash("올림 " + j.files.length + "개 " + (kb > 1024 ? (kb / 1024).toFixed(1) + "MB" : kb + "KB"));
        if (j.errors && j.errors.length) diag({ ev: "upload-partial", errors: j.errors });
      })
      .catch((e) => {
        flash("업로드 실패");
        diag({ ev: "upload-fail", n: files.length, bytes: total, err: String(e && e.message || e) });
      });
  };

  // ⭐ 선택 → 클립보드. **조용히 실패하지 않게** 한다.
  //
  // ⚠ `navigator.clipboard` 는 **secure context 에서만** 존재한다 — https(tailscale serve)나
  //   localhost 면 있고, `http://100.x.x.x:8767` 처럼 IP 로 직접 붙으면 **아예 없다**(원격에서
  //   "긁어도 복사가 안 된다"의 첫 번째 후보). 그때는 hidden textarea + `execCommand("copy")`
  //   레거시 경로로 붙인다 — 낡았지만 비-secure context 에서 유일하게 남은 길이다.
  const copyToClipboard = (text) => {
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) diag({ ev: "copy-fail", how: "execCommand" });
        return ok;
      } catch (e) { diag({ ev: "copy-fail", how: "execCommand", err: String(e && e.message || e) }); return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((e) => {
        diag({ ev: "copy-fail", how: "writeText", err: String(e && e.message || e) });
        legacy();
      });
    } else {
      diag({ ev: "copy-no-api", secure: window.isSecureContext, host: location.hostname });
      legacy();
    }
  };

  // ⭐⭐ 원격 브라우저(다른 PC·폰)의 붙여넣기 — **클립보드가 브라우저 쪽에 있다.**
  //   텍스트는 그대로 붙이고, 이미지는 (웹 페이지가 바이트를 터미널로 못 흘리니)
  //   업로드와 **같은 수법**으로 서버에 저장한 뒤 경로만 붙인다 — claude 는 경로를 받으면 읽는다.
  //
  // ⚠ `navigator.clipboard.read()` 는 secure context + 사용자 제스처에서만 된다.
  //   tailscale serve 가 https 로 감싸주므로 원격 접속도 secure context 다(http://100.x 로
  //   직접 붙으면 아니다 → 그때는 아래 catch 의 readText 조차 없어 아무 일도 안 일어난다).
  const pasteFromBrowserClip = (p) => {
    const api = navigator.clipboard;
    const readAll = (api && api.read) ? api.read() : Promise.reject(new Error("clipboard.read 없음"));
    return readAll.then((items) => {
      for (const it of items) {
        const img = (it.types || []).find((t) => t.indexOf("image/") === 0);
        if (img) return it.getType(img).then((b) => {
          const ext = (img.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
          uploadFiles([new File([b], "clip_" + Date.now() + "." + ext, { type: img })], p);
        });
      }
      for (const it of items) {
        if ((it.types || []).indexOf("text/plain") >= 0)
          return it.getType("text/plain").then((b) => b.text()).then((t) => { if (t) pasteText(p, t); });
      }
      return null;
    }).catch((e) => {
      diag({ ev: "paste-remote-fallback", err: String(e && e.message || e) });
      return readPhoneClip().then((t) => { if (t) pasteText(p, t); }).catch(() => {});
    });
  };

  const pasteClipboard = (pcFirst) => {
    const p = panes.get(activeSid);
    if (!p) { flash("pane 없음"); return; }
    const first  = pcFirst ? readPcClip : readPhoneClip;
    const second = pcFirst ? readPhoneClip : readPcClip;
    // 한쪽이 실패해도, **비어 있어도** 반대쪽을 본다 — 폰 권한 거부와 "PC 에만 있는 내용"이
    // 겉으로는 똑같이 '아무 일도 안 일어남' 으로 보이기 때문이다.
    first()
      .then((t) => (t && t.length) ? t : second())
      .catch(() => second())
      .then((t) => {
        if (t && t.length) pasteText(p, t);
        else flash("클립보드가 비었습니다");
      })
      .catch((e) => {
        flash("붙여넣기 실패");
        diag({ ev: "paste-fail", pcFirst: !!pcFirst, err: String(e && e.message || e) });
      });
  };

  // ---------- 크기 ----------
  // 안 보이는 pane 판정 — **그룹이 꺼져 있거나** 줌에 가려진 경우다.
  //   (pane 자체에는 더 이상 `.off` 를 쓰지 않는다 — app.css 의 `.tabgroup` 주석 참조)
  const isOff = (p) => {
    if (p.el.classList.contains("dim")) return true;
    const g = p.el.parentElement;
    return !!(g && g.classList.contains("off"));
  };

  function resizePane(p) {
    if (!p || isOff(p)) return;
    // ⚠ 한글 조합 중에는 크기를 건드리지 않는다 — 크기가 바뀌면 셸이 화면을 다시 그리고
    //   xterm 이 textarea 를 재배치하면서 **조합 중이던 글자가 깨진다.**
    if (composing) return;
    if (reportSize) {
      // ⭐ 키보드가 떠 있어도 **막지 않는다.** 예전에는 여기서 `if (kbOpen) return` 으로 막았는데,
      //   그러면 키보드에 가린 화면이 그대로 남아 프롬프트가 안 보였다.
      //   이제 키보드가 뜨면 body 높이를 줄이므로(폰 블록의 `applyVV`) fit 결과가 곧
      //   **보이는 영역**이다 — 그 크기를 그대로 요구하는 것이 맞다(사용자 지시 2026-08-24).
      p.fit.fit();                                            // 내 칸 수를 확정하고
      // ⭐⭐ 보고를 생략하는 기준은 **PTY 의 실제 크기**다. "내가 지난번에 보낸 값"이 아니다.
      //
      // ⚠ 사고 기록(2026-08-24): "같은 값을 또 보내지 말자"고 `p.reported` 와 비교했더니
      //   **교착에 빠졌다** —
      //     fit 이 78 을 냄 → `reported` 도 78 이라 **보고 생략** → PTY 는 69 그대로
      //     → 폴링이 "칸 수 불일치"를 보고 `term.resize(69)` → 다시 fit 이 78 …
      //   그 결과 **xterm 은 78칸 자리를 차지하는데 PTY 는 69칸**이라, claude 가 그린 구분선이
      //   화면 오른쪽에 못 미치고 잘린 것처럼 보였다(실측: 945px 컨테이너에 832px 구분선).
      //   보고를 멈춰야 할 이유는 "이미 PTY 가 내 크기와 같을 때" 하나뿐이다.
      const cur = sessOf(p.sid);
      if (cur && cur.cols === p.term.cols && cur.rows === p.term.rows) return;
      // 방금 같은 값을 보냈다면 아직 반영 전일 수 있다 — 짧게만 기다린다(중복 보고 방지).
      if (p.reported && p.reported[0] === p.term.cols && p.reported[1] === p.term.rows
          && performance.now() - p.reportedAt < 1500) return;
      // ⭐ **입력 중에는 잔떨림을 무시한다.**
      //   크기가 바뀌면 셸은 화면을 통째로 다시 그린다. 그 순간 사용자가 타이핑 중이면
      //   자동완성 목록·입력창이 겹쳐 그려진다(2026-08-24 제보: `/` 자동완성이 깨져 보임).
      //   키보드를 여닫거나 도크를 여는 것은 큰 변화(9줄 이상)라 그대로 통과하고,
      //   주소창이 오르내리며 만드는 ±4줄 정도는 입력 중에만 흘려보낸다.
      if (typing && p.reported && p.reported[0] === p.term.cols
          && Math.abs(p.reported[1] - p.term.rows) <= 5) return;
      // ⭐ `forced` 면 **매번** force 를 실어 보낸다 — 안 그러면 서버가 예전 강제값을 붙들고
      //   새 보고를 무시해, 폴드를 펴도 접힌 크기 그대로 남는다(위 `forced` 선언부 참조).
      wsend(p, { t: "r", c: p.term.cols, r: p.term.rows, force: forced || undefined });
      p.reported = [p.term.cols, p.term.rows];   // 폴링이 이 값을 옛 PTY 크기로 되돌리지 않도록
      p.reportedAt = performance.now();
    } else {
      // ⭐ 따라가기 모드는 **키보드와 무관하게 항상 맞춘다.**
      //   여기서 하는 일은 "PTY 크기를 받아 xterm 에 반영"뿐이라 키보드가 낄 자리가 없다.
      //   가드를 잘못 걸어 이걸 막았더니, PTY 크기가 바뀌었는데 xterm 이 못 따라가
      //   **글자가 엉뚱한 자리에 흩어져 그려졌다**(칸 수 불일치 — 이 파일 맨 위의 절대 원칙).
      const s = sessOf(p.sid);                                // 따라가기: PTY 크기를 그대로 쓴다
      if (s && s.cols && s.rows && (p.term.cols !== s.cols || p.term.rows !== s.rows)) {
        p.term.resize(s.cols, s.rows);
      }
    }
  }
  const resizeAll = () => panes.forEach(resizePane);
  // ⭐ 이벤트로 들어오는 재측정은 **모아서 한 번만** 한다.
  //
  // ⚠ 실측(2026-08-24 로그): `77x22 → 77x35` 가 **16ms 간격**으로 왕복했다.
  //   body 높이를 바꾸면 `ResizeObserver` 가 울고, 그게 다시 크기를 재는 되먹임이라
  //   두 상태를 오가며 PTY 가 연속으로 바뀌고 셸이 그때마다 화면을 다시 그린다.
  //   사람이 만든 변화는 100ms 안에 끝나지 않으므로, 마지막 상태만 반영하면 된다.
  //   폰 주소창이 스크롤에 따라 오르내리며 높이를 96px(≈4줄)씩 바꾸는 것도 여기서 함께 걸러진다 —
  //   오르내리는 도중의 중간값은 버리고 **멈춘 뒤의 값**만 PTY 로 나간다.
  let resizeTimer = 0;
  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAll, 400);
  };

  // ---------- 빈 화면 자기치유 ----------
  // ⭐ 강제 재도화 — **버퍼는 멀쩡한데 화면만 비어 있는** 상태를 되살린다.
  //   xterm 은 변한 줄만 그리므로, 렌더러가 죽었다 살아난 뒤에는 "전부 다시 그려라"를
  //   따로 알려줘야 한다. 비용은 한 프레임이다.
  function redraw(p) {
    if (!p) return;
    try { p.term.refresh(0, p.term.rows - 1); } catch (_) {}
  }

  // ⭐⭐ **폰에서 간헐적으로 화면이 텅 비는** 증상의 복구 경로
  //   (제보 2026-09-07: "빈 화면이 뜨고 새로고침을 눌러도 반응이 없다가,
  //    다른 탭 갔다가 들어오면 나온다").
  //
  // 공통점은 "데몬·PTY·세션은 멀쩡한데 **브라우저 쪽 무언가가 멈춰 있다**"이고,
  // 폰에서 그렇게 되는 경로가 셋이다:
  //   ① **WebGL 컨텍스트 유실** — 안드로이드 크롬은 백그라운드 탭의 GPU 리소스를 회수한다.
  //      `webglcontextlost` 가 오면 addon 이 DOM 렌더러로 되돌리지만(`onContextLoss`),
  //      **이벤트 없이 컨텍스트만 무효화되는 경우**가 있어 직접 `isContextLost()` 를 묻는다.
  //   ② **소켓 좀비** — 얼려진 동안 WS 가 닫혔는데 재연결 타이머(setTimeout)까지
  //      함께 죽어 아무도 다시 붙지 않는 경우(bfcache · 탭 discard 경계).
  //   ③ **레이아웃 붕괴** — `visualViewport` 가 이상한 높이를 준 순간 `applyViewport` 가
  //      body 를 줄여 놓고, 정상값 이벤트가 다시 오지 않아 그대로 굳은 경우.
  //
  // ⭐⭐ **이 함수는 `새로고침`(`refitPane`)에서만 불린다 — 주기 실행하지 않는다.**
  //
  // ⚠ 초판(v99)은 5초 주기 + `visibilitychange`/`pageshow` 에서도 돌렸다. 그런데 이 앱의
  //   확립된 원칙은 **"자동으로 맞추지 않는다 — 누를 때만 한다"**(사용자 판단, 크기 주인 절 참조)이고,
  //   주기적으로 전체를 다시 그리는 코드는 그 원칙을 어기면서 **평상시 위험 표면만 늘린다**
  //   (v99 배포 당일 RDP 세션에서 "입력이 뚝뚝 멈춘다"가 보고됐고, 원인은 미확정이나
  //    내가 임의로 넣은 주기 실행이 가장 의심스러운 새 코드였다 → 사용자 지시로 걷어냄 2026-09-07).
  //   화면이 이상하면 사용자가 새로고침을 누른다. 그때 한 번 점검하는 것으로 충분하다.
  //
  // 어느 쪽이든 **되살리고 무엇을 고쳤는지 서버 로그에 남긴다** — 다음에 또 나면
  // 추측 없이 원인이 찍힌다(webterm.log 의 `DIAG {"ev": "heal"...}`).
  function healPanes(why) {
    const p = panes.get(activeSid);
    if (!p) return;
    const fixed = [];

    // ① WebGL 컨텍스트가 죽었나 — 캔버스에 **이미 붙어 있는** 컨텍스트에 물어본다.
    //    (`getContext` 는 같은 캔버스·같은 타입이면 같은 객체를 돌려주므로 새로 만들지 않는다)
    if (p.webgl) {
      let lost = false;
      p.el.querySelectorAll("canvas").forEach((c) => {
        try {
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          if (gl && gl.isContextLost()) lost = true;
        } catch (_) {}
      });
      if (lost) {
        // dispose 가 DOM 렌더러로 되돌리고 handleResize 까지 해준다(vendor/addon-webgl.js 실측).
        // 다시 붙이지는 않는다 — 잃은 이유(백그라운드·GPU 회수)가 그대로면 또 잃는다.
        try { p.webgl.dispose(); } catch (_) {}
        p.webgl = null;
        fixed.push("webgl");
      }
    }

    // ② 소켓이 닫힌 채 오래 방치됐다 → 지금 붙는다.
    //    ⚠ 판정 기준은 `p.retry`(타이머 ID)가 아니다 — `connect` 가 clearTimeout 만 하고
    //      값을 비우지 않으므로 한 번 재연결한 pane 은 영원히 truthy 다. **닫힌 시각**으로 잰다.
    //      백오프 상한(5초)보다 넉넉히 지났으면 재시도가 실제로 죽은 것이다.
    if (sessOf(p.sid) && (!p.ws || p.ws.readyState === 3)
        && performance.now() - (p.closedAt || 0) > 6000) {
      clearTimeout(p.retry);
      p.delay = 500;
      connect(p);
      fixed.push("ws");
    }

    // ③ 터미널이 그려질 자리가 없다 → 뷰포트를 다시 계산한다(폰 전용 구현, PC 는 no-op)
    const box = p.el.getBoundingClientRect();
    if (box.height < 40 || box.width < 40) { applyViewport(); scheduleResize(); fixed.push("layout"); }

    redraw(p);                      // 새로고침은 "다시 그려라"는 요청이므로 항상 한 번 그린다
    if (fixed.length) {
      diag({ ev: "heal", why: why, fixed: fixed,
             h: Math.round(box.height), w: Math.round(box.width),
             ws: p.ws ? p.ws.readyState : -1 });
    }
  }

  // ---------- 탭/pane 조작 ----------
  function selectTab(name) {
    if (activeTab === name) return;
    activeTab = name;
    const ps = tabPanes(name);
    // ⭐ 그 탭에서 전체화면으로 보던 pane 이 있으면 **그 상태로 돌아간다**(`zoomByTab`).
    //   줌된 pane 이 곧 보이는 화면이므로 활성 pane 도 그것으로 맞춘다 — 안 맞추면
    //   화면은 줌된 pane 인데 키 입력은 다른 pane 으로 가는 어긋남이 생긴다.
    const z = zoomByTab[name];
    const keep = (z && ps.some(p => p.sid === z)) ? z : null;
    activeSid = keep || (ps.length ? ps[0].sid : null);
    renderTabs(); renderPanes(); focusPane(activeSid);
  }
  function focusPane(sid) {
    if (!sid) return;
    const changed = activeSid !== sid;
    // ⭐⭐ **줌(전체화면) 중에 다른 pane 을 지목하면 전체화면을 그 pane 으로 갈아탄다.**
    //
    // ⚠ 예전에는 `activeSid` 만 바꿨다. 그런데 줌 중에는 `.pane.zoom` 이 화면을 통째로
    //   덮고 있어(app.css) **화면은 그대로인데 키 입력만 안 보이는 pane 으로 갔다** —
    //   "Alt+1 로 전체화면 한 상태에서 다른 pane 을 눌러도 전환이 안 된다"(제보 2026-09-07).
    //   `cyclePane`(Alt+←/→)에만 이 규칙이 있어 방향키로는 되고 클릭만 안 되던 것 —
    //   → 규칙을 **모든 지목 경로가 지나는 이 함수 한 곳**으로 옮긴다
    //     (PC 칩 · 폰 칩바 · 드로어 · 우클릭 메뉴 · pane 클릭 · cyclePane 이 전부 여기로 온다).
    const rezoom = !!zoomSid && zoomSid !== sid && tabPanes(activeTab).some(p => p.sid === sid);
    if (rezoom) setZoom(sid);
    activeSid = sid;
    for (const [id, q] of panes) q.el.classList.toggle("active", id === sid);
    const p = panes.get(sid);
    if (p) focusTerm(p.term);          // 읽기 모드면 포커스를 주지 않는다(키보드 방지)
    // ⭐ 폰에서 **탭·pane 을 옮기는 것은 "보러 가는" 행동**이다 → 입력 모드를 끄고 키보드를 내린다.
    //   입력은 더블탭(또는 `⌨`)으로 명시적으로 켠다 — 그것이 이 앱의 유일한 키보드 규칙이다.
    if (isPhone && changed) setPhoneTyping(false);
    // ⚠ 폰은 분할해도 **한 번에 한 pane 만** 보여준다(`zoom = activeSid`).
    //   그래서 활성 pane 이 바뀌면 다시 그려야 화면이 실제로 넘어간다.
    //   이걸 빠뜨렸더니 4초 폴링(refresh)이 돌 때까지 기다려야 했다 — 체감 2초.
    if (rezoom || (isPhone && changed)) renderPanes();
    renderChips();
  }
  function cyclePane(d) {
    const ps = tabPanes(activeTab);
    if (ps.length < 2) return;
    const i = ps.findIndex(p => p.sid === activeSid);
    const n = ((i < 0 ? 0 : i) + d + ps.length) % ps.length;
    focusPane(ps[n].sid);        // 줌 중이면 focusPane 이 전체화면을 그 pane 으로 갈아탄다
  }
  function zoomPane(idx) {
    const ps = tabPanes(activeTab);
    const target = ps[idx];
    if (!target) return;
    setZoom(zoomSid === target.sid ? null : target.sid);      // 같은 번호 재입력 = 줌 해제
    if (zoomSid) activeSid = target.sid;
    renderPanes(); focusPane(activeSid);
  }

  async function splitPane(dir) {
    if (!activeTab) return;
    const cur = sessOf(activeSid);
    layouts[activeTab] = dir;
    // 같은 탭 이름으로 세션을 하나 더 만들면 그게 곧 새 pane 이 된다
    const r = await api.create({ name: activeTab, cwd: cur ? cur.cwd : DEFAULT_CWD, cols: 120, rows: 30 });
    await refresh();
    if (r && r.session) focusPane(r.session.sid);
  }

  async function newTab(cwd) {
    const base = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "term";
    let name = base, n = 1;
    while (tabNames().includes(name)) name = `${base}_${++n}`;
    const r = await api.create({ name, cwd, cols: 120, rows: 30 });
    await refresh();
    if (r && r.session) { activeTab = name; activeSid = r.session.sid; renderTabs(); renderPanes(); }
  }

  async function closePane(sid) {
    const s = sessOf(sid);
    if (!s) return;
    const many = tabPanes(s.name).length > 1;
    if (!confirm(many ? `'${s.name}' 의 pane 을 닫을까요?` : `'${s.name}' 탭을 닫을까요?`)) return;
    await api.kill(sid);
    if (zoomSid === sid) setZoom(null);
    await refresh();
  }
  async function closeTab(name) {
    const ps = tabPanes(name);
    if (!ps.length) return;
    if (!confirm(`'${name}' 탭(pane ${ps.length}개)을 닫을까요?`)) return;
    for (const p of ps) await api.kill(p.sid);
    await refresh();
  }
  // Ctrl+P — 이 pane 에만 붙는 수동 이름. 비우면 자동(번호)으로 되돌아간다.
  // 프롬프트에 번호를 같이 보여준다 — 어느 pane 을 고쳤는지 헷갈리지 않게(wiki 의 3중 보강과 같은 취지).
  async function renamePane(sid) {
    const s = sessOf(sid);
    if (!s) return;
    const i = tabPanes(s.name).findIndex(p => p.sid === sid);
    const v = await ask(`패널 이름 (${i + 1}번 · 비우면 자동)`, paneLabel(sid));
    if (v === null) return;
    // (탭 이름, label) 이 복합키다. 판정은 데몬이 하고(API 직접 호출도 막힌다) 여기서는 결과만 전한다.
    const r = await api.label(sid, v.trim());   // 빈 문자열이면 자동으로 되돌아간다
    if (r && r.ok === false) {
      alert(r.error || "이름을 바꾸지 못했습니다");
      return renamePane(sid);                   // 다시 물어본다 — 입력을 통째로 날리지 않게
    }
    await refresh(true);                        // 목록을 다시 받아야 label 이 반영된다
  }

  async function renameTab(name) {
    const v = await ask("탭 이름", name);
    if (v === null) return;
    const t = v.trim();
    if (!t || t === name) return;
    // 판정은 서버가 한다. 다른 탭과 같은 이름이 되면 두 탭이 합쳐지면서
    // (탭, 패널이름) 복합키가 깨지므로 서버가 409 로 막는다.
    const r = await api.renameTab(name, t);
    if (r && r.ok === false) {
      alert(r.error || "탭 이름을 바꾸지 못했습니다");
      return renameTab(name);      // 다시 물어본다 — 입력을 통째로 날리지 않게
    }
    if (activeTab === name) activeTab = t;
    await refresh(true);
  }

  // ---------- 새로고침 ----------
  // 4초마다 도는 폴링이 매번 DOM 을 갈아치우면 화면이 깜빡이고 포커스가 흔들린다.
  // → 세션 목록이 실제로 달라졌을 때만 다시 그린다.
  let lastSig = "";
  async function refresh(force) {
    try {
      sessions = (await api.list()).sessions || [];
      $("#offline").hidden = true;
    } catch { $("#offline").hidden = false; return; }

    const names = tabNames();
    if (!activeTab || !names.includes(activeTab)) activeTab = names[0] || null;
    const ps = tabPanes(activeTab);
    if (!ps.some(p => p.sid === activeSid)) activeSid = ps.length ? ps[0].sid : null;

    // ⭐ **나 혼자면 바로 주인이 된다** — 뺏을 상대가 없으니 관찰자로 있을 이유가 없다.
    //   (관찰자 규칙은 "남이 보고 있는 화면을 건드리지 않는다"가 목적이다. 위 `claimOwnership` 참조.)
    //   남이 붙어 있으면 그대로 관찰자로 남고, 내가 이 창을 클릭·타이핑하면 그때 주인이 된다.
    {
      const act = sessions.find(x => x.sid === activeSid);
      if (act && act.clients <= 1) claimOwnership();
    }

    // ⭐⭐ PTY 크기(cols·rows)를 **매번** xterm 에 반영한다 — `sig` 비교보다 앞이다.
    //
    // ⚠ 사고 기록(2026-08-24, 폴드8): 따라가기 모드(폰)는 `resizePane` 의 else 경로에서
    //   PTY 크기를 받아 그리는데, 그 함수가 불리는 계기가 **내 쪽 화면 변화뿐**이었다
    //   (`resize` · `ResizeObserver` · 렌더 후 `resizeAll`). 그래서 **다른 클라(PC)가 PTY 크기를
    //   바꿔도 폰은 그 사실을 영영 모른 채** 옛 칸 수로 계속 그렸다 —
    //   "xterm 칸 수 = PTY 칸 수" 절대 원칙이 깨져 statusline 이 잘리고 줄이 어긋난 화면이 그것이다.
    //   `sig` 에 크기가 빠져 있어 4초 폴링조차 이 변화를 못 잡았다(내용이 같으면 return).
    //   → 크기는 렌더 여부와 무관하게 **항상** 맞춘다.
    for (const [sid, p] of panes) {
      const s = sessions.find(x => x.sid === sid);
      if (!s || !s.cols || !s.rows) continue;
      if (p.term.cols === s.cols && p.term.rows === s.rows) continue;
      // 내가 방금 요구한 크기는 아직 데몬에 반영되기 전일 수 있다(폴링 4초). 그걸 "다름"으로
      // 보고 되돌리면 fit ↔ 폴링이 서로 밀며 화면이 깜빡인다 → 잠깐은 내 값을 믿는다.
      if (p.reported && performance.now() - p.reportedAt < 3000
          && (p.reported[0] !== s.cols || p.reported[1] !== s.rows)) continue;
      // ⭐ 내 요구가 거절됐다는 뜻이다(다른 클라가 고정했거나 서버가 다른 값을 택함).
      //   **고정 중이라도 따라간다** — "xterm 칸 수 = PTY 칸 수" 는 이 파일 맨 위의 절대 원칙이고,
      //   어기면 글자가 엉뚱한 자리에 그려진다. 위의 3초 유예가 "내 보고가 아직 반영 전"인
      //   경우를 이미 걸러주므로, 여기까지 왔다면 진짜 불일치다.
      p.term.resize(s.cols, s.rows);
    }

    // ⚠⚠ `sig` 에 **cols·rows 를 넣으면 안 된다**(2026-08-24 사고).
    //   넣었더니 이런 되먹임이 생겼다:
    //     PTY 크기 변경 → sig 변경 → renderPanes() → resizeAll() → fit → **새 크기 보고**
    //     → PTY 변경 → sig 변경 → … (4초 폴링마다 반복)
    //   실측 로그: `77x26 → 77x35` 가 99ms 간격으로 왕복하고 4초마다 되풀이됐다.
    //   그때마다 셸이 화면을 다시 그려 **statusline 이 두 개로 보이는** 증상이 됐다.
    //   크기 반영은 바로 위 for 루프가 이미 **매번** 하므로 sig 는 알 필요가 없다.
    const sig = JSON.stringify(sessions.map(s => [s.sid, s.name, s.alive, s.title, s.clients]))
              + "|" + activeTab + "|" + activeSid + "|" + zoomSid;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    renderTabs();
    renderPanes();
  }

  // ---------- 우클릭 메뉴 ----------
  let menuTab = null, menuSid = null;
  function openMenu(e, name, sid) {
    menuTab = name; menuSid = sid || activeSid;
    const m = $("#menu");
    // ⭐ WebGL 은 **설정값과 실제 적용이 다를 수 있다** — 폰트 로드를 기다렸다 붙이므로 잠깐
    //   시차가 있고, 미지원 환경에서는 켜도 안 붙는다. 둘을 구분해 보여준다
    //   (사용자 제보 2026-08-24: "지금 켜져 있는지 아닌지 판단이 안 된다").
    const wgItem = m.querySelector('[data-act="webgl"]');
    if (wgItem) {
      const want = useWebgl();
      const live = !!(panes.get(menuSid) || {}).webgl;
      wgItem.textContent = want
        ? (live ? "✓ 선명하게(WebGL) — 켜짐 · 누르면 끄기"
                : "… 선명하게(WebGL) — 켜짐(적용 대기/미지원) · 누르면 끄기")
        : "선명하게(WebGL) — 꺼짐 · 누르면 켜기";
    }
    m.hidden = false;
    menuAt = performance.now();
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  }
  const closeMenu = () => { $("#menu").hidden = true; };
  // ⚠ 폰은 터치를 뗀 뒤 **합성 click 이 따라온다** — 그 click 이 방금 연 메뉴를 즉시 닫아버린다.
  //   touchend 에서 `preventDefault()` 로 막고 있지만(아래 제스처 블록), 브라우저가 그래도
  //   click 을 쏘는 경우가 있어 여는 순간 직후의 click 은 무시한다.
  let menuAt = 0;
  addEventListener("click", () => { if (performance.now() - menuAt > 350) closeMenu(); });
  addEventListener("blur", closeMenu);
  $("#menu").onclick = async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === "split-h") return splitPane("h");
    if (act === "split-v") return splitPane("v");
    if (act === "zoom") {                       // 더블클릭과 같은 동작 — 메뉴에도 길을 낸다
      // ⚠ `zoomPane` 은 **현재 탭** 기준으로 번호를 센다 — 탭바에서 다른 탭을 우클릭했다면
      //   먼저 그 탭으로 옮겨야 번호가 어긋나지 않는다.
      if (menuTab && menuTab !== activeTab) selectTab(menuTab);
      const ps = tabPanes(activeTab);
      const i = ps.findIndex((x) => x.sid === menuSid);
      if (i >= 0) zoomPane(i);
      return;
    }
    if (act === "rename")  return renameTab(menuTab);
    if (act === "rename-pane") return renamePane(menuSid);
    if (act === "close")   return closePane(menuSid);
    if (act === "clear")   { wsend(panes.get(menuSid), { t: "i", d: "\f" }); return; }
    if (act === "newhere") { const s = sessOf(menuSid); return newTab(s ? s.cwd : DEFAULT_CWD); }
    if (act === "webgl") { toggleWebgl(); return; }
    if (act === "redraw") { refitPane(menuSid); return; }
  };

  // ⭐ 셀 폭·글리프 다시 굽기 — 폰트가 늦게 붙은 pane 을 구제한다.
  //   `fontSize` 를 아주 조금 흔들면 xterm 이 문자 크기를 다시 재고,
  //   WebGL 아틀라스는 `clearTextureAtlas()` 로 비워야 폴백 글리프가 사라진다.
  function remeasureCells() {
    panes.forEach((p) => {
      try {
        if (p.webgl && p.webgl.clearTextureAtlas) p.webgl.clearTextureAtlas();
        const fs = p.term.options.fontSize;
        p.term.options.fontSize = fs + 0.01;
        p.term.options.fontSize = fs;
      } catch (_) {}
    });
    scheduleResize();
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => setTimeout(remeasureCells, 60));
  }

  // ⭐ 화면 다시 그리기 — **셸에게 크기를 한 번 더 통보**한다.
  //
  // ⚠ 크기가 짧은 시간에 여러 번 바뀌면 claude 같은 TUI 가 마지막 `SIGWINCH` 를 놓치고
  //   **옛 폭으로 계속 그린다**(2026-08-24 실측: PTY 69칸인데 화면은 63칸까지만 채워짐).
  //   칸 수 자체는 맞으므로 우리 쪽에서 고칠 것이 없고, 셸이 다시 그리게 만들어야 한다.
  //   같은 크기를 다시 보내면 서버가 "변화 없음"으로 걸러내므로(`_applied_size`),
  //   **한 칸 줄였다가 되돌려** SIGWINCH 를 두 번 일으킨다.
  // ⭐⭐ 새로고침 = **내 화면에 맞추고 다시 그린다.** (2026-08-27 사용자 지시로 둘을 합쳤다)
  //
  // ⚠ 예전엔 따로였다: `↻ 화면 다시 그리기`(칸 수를 흔들어 TUI 가 다시 그리게) ·
  //   `⤢ 이 화면에 맞추기`(크기 주인 **토글**). 그런데 사용자가 겪는 증상은 둘 다
  //   "화면이 깨졌다" 하나라, 어느 걸 눌러야 하는지 알 수 없었고 **고정/해제라는 상태**까지
  //   기억해야 했다 → 하나로 합치고 상태를 없앱다.
  // ⭐ **자동으로 맞추지 않는 것은 의도다**(사용자 판단) — 크기가 제벋대로 바뀌는 편이
  //   더 불편하다. 누를 때만 주인이 바뀜다 — PC 에서 눌러 PC 가, 폰에서 눌러 폰이 주인이 된다.
  //   (그래서 "고정 해제" 항목이 필요 없다. 주인이 떠나면 서버가 `FORCE_GRACE` 로 푸는다.)
  function refitPane(sid) {
    const p = panes.get(sid || activeSid);
    if (!p) return;
    remeasureCells();                      // 폴백 글리프에 굳은 경우까지 함께 구제한다
    forced = true;                         // 이제부터 내 화면이 기준 — 회전·폴드에도 따라온다
    localStorage.setItem("webterm.fit", "1");
    try { p.fit.fit(); } catch (e) {}      // 지금 화면에서의 칸 수를 확정하고
    const c = p.term.cols, r = p.term.rows;
    wsend(p, { t: "r", c: c, r: r, force: true });                                  // 그 크기로 고정
    // ⚠ 칸 수가 이미 같으면 PTY 는 resize 를 안 받고, 그러면 claude 같은 TUI 는
    //   다시 그리지 않는다 → 한 칸 줄였다 되돌려 **변화를 만들어** 재도화를 유도한다.
    setTimeout(() => wsend(p, { t: "r", c: Math.max(2, c - 1), r: r, force: true }), 60);
    setTimeout(() => wsend(p, { t: "r", c: c, r: r, force: true }), 200);
    // ⭐ 새로고침은 **화면이 이상할 때 누르는 버튼**이다 → 크기 재협상에서 끝내지 않고
    //   렌더러·소켓·뷰포트 점검과 전체 재도화까지 함께 돌린다(위 `healPanes`).
    healPanes("refit");
    flash("화면에 맞춤 " + c + "×" + r);
  }

  // ---------- 화면 맞추기(고정) ----------
  // ⭐ 크기는 **평소에도 자동**이다(브라우저가 알려주는 실제 폭·높이를 그대로 PTY 에 요구한다).
  //   이 항목은 그 위에 얹는 **고정**이다 — 다른 클라(PC)가 붙어 있어도 내 화면 크기를 지킨다.
  //
  // 예전에는 탭바의 `⤢` 버튼이었는데, 폰에서 오터치가 잦고 자리를 먹어
  // 사용자 지시(2026-08-24)로 **꾹 누르기·우클릭 메뉴**로 내렸다.


  // ---------- 인라인 입력 ----------
  function ask(labelText, initial) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.id = "ask";
      wrap.innerHTML = `<div class="box"><label></label>
        <input type="text" spellcheck="false" autocomplete="off">
        <div class="hint">Enter 확인 · Esc 취소</div></div>`;
      wrap.querySelector("label").textContent = labelText;
      const input = wrap.querySelector("input");
      input.value = initial || "";
      document.body.appendChild(wrap);
      input.focus(); input.select();
      const done = (v) => { wrap.remove(); focusPane(activeSid); resolve(v); };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(input.value);
        if (e.key === "Escape") done(null);
      };
      wrap.onmousedown = (e) => { if (e.target === wrap) done(null); };
    });
  }

  // ---------- 키 ----------
  // .wezterm.lua 의 키맵을 그대로 옮겼다: **Ctrl = 탭 / Alt = 패널**
  //   Ctrl+N 새 탭 · Ctrl+T 탭 이름 · Ctrl+] Ctrl+\ 분할 · Ctrl+1~9,←→ 탭 이동 · Ctrl+± 폰트
  //   Alt+1~9 패널 줌 · Alt+←→ 패널 이동 · Alt+0 줌 해제
  //   + Alt+B 세로 세션 레일 토글(WezTerm 에는 없는 webterm 고유 — 탭이 많을 때의 목록)
  //
  // ⚠ 앱이 쓰는 조합은 **터미널로 새어 나가면 안 된다.**
  //   preventDefault() 만으로는 부족하다 — xterm 은 자체 textarea 에서 keydown 을 듣기 때문에
  //   `attachCustomKeyEventHandler` 로 false 를 돌려줘야 한다.
  //   (안 막았더니 Alt+1 이 PSReadLine 에 가서 `digit-argument: 1` 이 떴다)
  // ── 단축키 — 액션 레지스트리 + 키맵 ────────────────────────────────────────
  //
  // ⭐ 예전에는 "이 키를 가로챌 것인가"(isAppKey)와 "그래서 뭘 할 것인가"(keydown 핸들러)가
  //   **서로 다른 곳에 따로** 하드코딩돼 있었다. 키 하나를 바꾸려면 두 곳을 손으로 맞춰야 했고,
  //   어긋나면 "가로채기는 했는데 아무 일도 안 일어남"이라는 고약한 고장이 난다.
  //   → 둘 다 **하나의 키맵에서 파생**시킨다. 그래서 어긋날 수가 없다.
  //
  // 키맵은 서버가 준다(config.default.json ← config.json). 여기에는 액션의 구현만 둔다.

  const ACTIONS = {
    "pane.split.h": { desc: "패널 좌우 분할",        run: () => splitPane("h") },
    "pane.split.v": { desc: "패널 상하 분할",        run: () => splitPane("v") },
    "pane.zoom":    { desc: "N번 패널 전체화면",     run: (n) => zoomPane(+n - 1) },
    "pane.unzoom":  { desc: "줌 해제",               run: () => { setZoom(null); renderPanes(); } },
    "pane.prev":    { desc: "이전 패널",             run: () => cyclePane(-1) },
    "pane.next":    { desc: "다음 패널",             run: () => cyclePane(1) },
    "pane.close":   { desc: "패널 닫기",             run: () => { if (activeSid) closePane(activeSid); } },
    "pane.rename":  { desc: "패널 이름",             run: () => { if (activeSid) renamePane(activeSid); } },

    "tab.new":      { desc: "새 탭",                 run: () => newTab(DEFAULT_CWD) },
    "tab.rename":   { desc: "탭 이름",               run: () => { if (activeTab) renameTab(activeTab); } },
    "tab.prev":     { desc: "이전 탭",               run: () => cycleTab(-1) },
    "tab.next":     { desc: "다음 탭",               run: () => cycleTab(1) },
    "tab.select":   { desc: "N번 탭으로",            run: (n) => {
                        const names = tabNames();
                        if (names[+n - 1]) selectTab(names[+n - 1]);
                      } },

    "rail.toggle":  { desc: "세로 세션 레일 토글",   run: () => setRail(!railOn) },
    "view.refit":   { desc: "화면 크기 다시 맞추기", run: () => refitPane(activeSid) },

    "font.inc":     { desc: "폰트 크게",             run: () => setFont(fontSize + 1) },
    "font.dec":     { desc: "폰트 작게",             run: () => setFont(fontSize - 1) },
    "font.reset":   { desc: "폰트 원래대로",         run: () => setFont(baseFont) },
  };

  // 이벤트 → "Ctrl+Alt+Shift+키". 설정의 표기와 **같은 규칙**으로 만들어야 하므로
  // 판정과 실행이 이 함수 하나를 공유한다.
  const chordOf = (e) =>
    (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") +
    (e.shiftKey ? "Shift+" : "") + e.key.toLowerCase();

  let keymap = new Map();                    // chord → { id, arg }

  function setKeymap(obj) {
    keymap = new Map();
    for (const [chord, spec] of Object.entries(obj || {})) {
      if (!spec) continue;                   // "" = 일부러 비운 것 = 터미널로 흘려보낸다
      const i = spec.indexOf(":");
      const id = i === -1 ? spec : spec.slice(0, i);
      const arg = i === -1 ? undefined : spec.slice(i + 1);
      if (!ACTIONS[id]) {
        // 조용히 무시하면 "설정했는데 왜 안 되지"가 된다. 콘솔에 이유를 남긴다.
        console.warn(`[webterm] 키맵의 알 수 없는 액션: "${spec}" (${chord})`);
        continue;
      }
      keymap.set(chord, { id, arg });
    }
  }

  // 설정을 못 받았을 때 쓰는 내장 기본값 — 이게 없으면 서버가 삐끗한 순간 단축키가 통째로 죽는다.
  const FALLBACK_KEYMAP = {
    "Ctrl+]": "pane.split.h", "Ctrl+\\": "pane.split.v",
    "Ctrl+n": "tab.new", "Ctrl+t": "tab.rename", "Ctrl+p": "pane.rename",
    "Ctrl+arrowleft": "tab.prev", "Ctrl+arrowright": "tab.next",
    "Alt+0": "pane.unzoom", "Alt+arrowleft": "pane.prev", "Alt+arrowright": "pane.next",
    "Alt+x": "pane.close", "Alt+b": "rail.toggle", "Alt+r": "view.refit",
    "Ctrl+=": "font.inc", "Ctrl+-": "font.dec", "Ctrl+0": "font.reset",
  };
  for (let i = 1; i <= 9; i++) {
    FALLBACK_KEYMAP[`Ctrl+${i}`] = `tab.select:${i}`;
    FALLBACK_KEYMAP[`Alt+${i}`] = `pane.zoom:${i}`;
  }

  const isAppKey = (e) => keymap.has(chordOf(e));

  // ※ Ctrl+W(단어 지우기)·Ctrl+R(역방향 검색)은 기본 키맵에서 일부러 비워뒀다 —
  //   PSReadLine 이 실제로 쓴다(`Get-PSReadLineKeyHandler -Bound` 실측: 이 둘은 있고
  //   Ctrl+P·Ctrl+N·Ctrl+T·Ctrl+O 는 없다).
  // ※ Ctrl+P 는 브라우저의 "인쇄"라서 반드시 가로채야 쓸 수 있다(Ctrl+N 을 뺏어오는 것과 같다).
  // ※ 닫기가 Alt+X 인 이유: Ctrl+W·Ctrl+Shift+W 는 **브라우저가 창을 닫아버려** 앱이 손댈 수 없다.
  //   WezTerm 의 Leader+x 와 글자를 맞춘다.

  addEventListener("keydown", (e) => {
    // 이름 입력창이 열려 있으면 앱 단축키를 끈다 — 안 그러면 입력 중 Ctrl+P 가 프롬프트를 또 띄운다
    if (document.getElementById("ask")) return;
    const hit = keymap.get(chordOf(e));
    if (!hit) return;
    e.preventDefault();
    try {
      ACTIONS[hit.id].run(hit.arg);
    } catch (err) {
      console.error(`[webterm] 액션 실패: ${hit.id}`, err);
    }
  }, true);

  // 설정을 서버에서 받아 적용한다. 실패해도 앱은 떠야 하므로 내장 기본값으로 떨어진다.
  async function loadConfig() {
    let cfg = null;
    try {
      cfg = await fetch("/api/config").then(r => r.json());
    } catch (err) {
      console.warn("[webterm] /api/config 실패 — 내장 기본값으로 간다", err);
    }
    if (cfg && cfg.ok) {
      DEFAULT_CWD = cfg.defaultCwd || "";
      // 사용자가 브라우저에서 폰트를 직접 조절했으면(localStorage) 그쪽이 이긴다.
      if (cfg.fontSize && localStorage.getItem("webterm.font") === null) {
        baseFont = +cfg.fontSize;
        fontSize = baseFont;
      }
    }
    const km = (cfg && cfg.keymap && Object.keys(cfg.keymap).length) ? cfg.keymap : FALLBACK_KEYMAP;
    setKeymap(km);
  }

  // 콘솔에서 확인용 — 설정 파일에 뭘 적을 수 있는지 여기서 본다.
  window.webterm = {
    actions: () => Object.entries(ACTIONS).map(([id, a]) => `${id.padEnd(16)} ${a.desc}`).join("\n"),
    keymap: () => [...keymap].map(([c, h]) => `${c.padEnd(18)} ${h.id}${h.arg ? ":" + h.arg : ""}`).join("\n"),
    chordOf,
  };

  // ⭐ Alt 를 누르면 커서가 십자선으로 바뀌고 **안 돌아오는** 문제
  //
  // xterm 은 Alt 를 '열(블록) 선택 모드' 신호로 보고 `.xterm` 에 `column-select` 를 붙인다
  // (`vendor/xterm.css` 의 `.xterm.column-select.focus{cursor:crosshair}`). 떼면 keyup 에서
  // 지우는데 — **Alt+Tab 으로 창을 떠나면 그 keyup 이 안 온다.** 그대로 굳어서 돌아왔을 때
  // 십자선이 남고, 마우스가 열 선택처럼 굴어 "Alt 를 webterm 이 물고 있다"로 보인다.
  //
  // 우리는 Alt 를 **패널 계층**(Alt+1~9 줌 · Alt+←→ 이동 · Alt+X 닫기)으로 쓰므로 열 선택 모드
  // 자체가 없다 → 커서는 CSS 에서 죽이고(app.css), 굳은 클래스는 창이 포커스를 잃을 때 턴다.
  //
  // ※ Alt+Tab 자체는 OS 가 브라우저보다 먼저 가로채는 조합이라 웹페이지가 막을 수 없다.
  //   `isAppKey` 도 Tab 을 건드리지 않는다 — 여기서 고치는 것은 "돌아온 뒤의 굳은 상태"다.
  const clearColumnSelect = () => {
    document.querySelectorAll(".xterm.column-select")
      .forEach((el) => el.classList.remove("column-select"));
  };
  addEventListener("blur", clearColumnSelect);
  addEventListener("keyup", (e) => { if (e.key === "Alt" || !e.altKey) clearColumnSelect(); }, true);

  function cycleTab(d) {
    const names = tabNames();
    if (!names.length) return;
    const i = names.indexOf(activeTab);
    selectTab(names[((i < 0 ? 0 : i) + d + names.length) % names.length]);
  }
  function setFont(n) {
    fontSize = Math.max(9, Math.min(28, n));
    localStorage.setItem("webterm.font", fontSize);
    panes.forEach(p => { p.term.options.fontSize = fontSize; });
    resizeAll();
  }

  // 세로 레일 — 버튼(▤)과 Alt+B 가 같은 통로를 쓴다. 저장된 상태를 부팅 시 한 번 적용한다.
  $("#rail-toggle").onclick = () => setRail(!railOn);
  if (railOn) setRail(true);

  $("#new-tab").onclick = () => newTab(DEFAULT_CWD);
  $("#new-tab").oncontextmenu = async (e) => {
    e.preventDefault();
    const cur = sessOf(activeSid);
    const cwd = await ask("새 탭의 시작 폴더", cur ? cur.cwd : DEFAULT_CWD);
    if (cwd && cwd.trim()) newTab(cwd.trim());
  };

  // ---------- 폰 UI (keyboard.js 어댑터) ----------
  // keyboard.js 는 wezterm-web 백엔드(/api/key, /api/send)를 기대한다 → 그 인터페이스만 흉내 낸다.
  const ESC = "\x1b";
  const KEY_SEQ = {
    esc: ESC, tab: "\t", shifttab: ESC + "[Z", enter: "\r", space: " ",
    backspace: "\x7f", delete: ESC + "[3~",
    up: ESC + "[A", down: ESC + "[B", right: ESC + "[C", left: ESC + "[D",
    home: ESC + "[H", end: ESC + "[F", pgup: ESC + "[5~", pgdn: ESC + "[6~",
    // ⭐ Shift 조합 — 도크의 `⇧` 를 켜고 누르면 이 이름으로 찾는다(keyboard.js `runAction`).
    //   방향키/Home/End 는 CSI 의 표준 modifier 인코딩(`1;2` = Shift).
    shiftup: ESC + "[1;2A", shiftdown: ESC + "[1;2B",
    shiftright: ESC + "[1;2C", shiftleft: ESC + "[1;2D",
    shifthome: ESC + "[1;2H", shiftend: ESC + "[1;2F",
    // ⭐⭐ Shift+Enter = **줄바꿈**.
    //   터미널 프로토콜에는 "Shift+Enter" 라는 신호가 없다 — 그래서 iTerm2·VSCode 는 claude 가
    //   따로 키바인딩을 설치해준다(바이너리의 `isShiftEnterKeyBindingInstalled`).
    //   우리 터미널은 그 목록에 없으므로, claude 가 화면에 안내하는 공식 대안인
    //   **`ctrl+j`(라인피드 0x0A)** 를 보낸다 → 사용자가 기대하는 동작과 정확히 일치한다.
    shiftenter: "\n",
  };
  // ⭐ 커서키는 **터미널 모드에 따라 인코딩이 다르다**(DECCKM = application cursor keys).
  //   claude 같은 TUI 는 이 모드를 켜고 `ESC O_` 를 기대하는데, 위의 `ESC [_` 를 고정으로 보내면
  //   먹지 않는다. 방향키가 그럭저럭 듣던 것은 많은 앱이 양쪽을 다 받아주기 때문이고,
  //   **Home/End 는 그렇지 않아서 아무 반응이 없었다.**
  //   pgup/pgdn(`ESC[5~`)이나 제어문자(Ctrl+글자)는 모드와 무관하다.
  const KEY_SEQ_APP = {
    up: ESC + "OA", down: ESC + "OB", right: ESC + "OC", left: ESC + "OD",
    home: ESC + "OH", end: ESC + "OF",
  };
  function keySeq(term, name) {
    const appMode = term && term.modes && term.modes.applicationCursorKeysMode;
    return (appMode && KEY_SEQ_APP[name]) || KEY_SEQ[name];
  }
  for (let c = 97; c <= 122; c++) KEY_SEQ["ctrl" + String.fromCharCode(c)] = String.fromCharCode(c - 96);

  window.state = { pane: 1 };
  window.needPane = () => true;
  // keyboard.js 가 "이 조합이 존재하나?"를 물어본다(Shift+키 지원 여부 판정)
  window.hasKeySeq = (name) => !!KEY_SEQ[name];
  window.setStatus = (msg, isErr) => { if (isErr) console.warn("[kb]", msg); };
  window.refreshScreen = () => {};
  window.post = async (url, body) => {
    const p = panes.get(activeSid);
    if (!p) return { ok: false, msg: "활성 pane 없음" };
    if (url === "/api/key") {
      const seq = keySeq(p.term, body.key);      // 현재 커서키 모드에 맞춰 인코딩한다
      if (!seq) return { ok: false, msg: "모르는 키: " + body.key };
      wsend(p, { t: "i", d: seq });
      return { ok: true };
    }
    if (url === "/api/send") {
      // ⭐ 본문과 엔터를 한 chunk 로 보내면 claude 같은 TUI 가 **붙여넣기로 판정**해
      //   끝의 `\r` 을 제출이 아니라 줄바꿈으로 먹는다(글은 들어갔는데 엔터만 안 눌림).
      //   서버의 `/api/send` 와 같은 규칙 — 본문 먼저, 간격을 두고 엔터만 따로.
      const text = body.text || "";
      if (text) wsend(p, { t: "i", d: text });
      if (body.submit) {
        if (text) setTimeout(() => wsend(p, { t: "i", d: "\r" }), 150);
        else wsend(p, { t: "i", d: "\r" });
      }
      return { ok: true };
    }
    return { ok: false, msg: "unknown " + url };
  };

  if (isPhone) {
    document.body.classList.add("phone");
    $("#send-form").hidden = true;

    // ⭐⭐ 특수키 도크는 **소프트 키보드에 붙어 다닌다**(사용자 지시 2026-08-24).
    //
    // 예전 구조: 화면에 떠 있는 FAB(`⌘`) → 눌러서 도크 펼치기 → 도크 안 `⌨` 로 키보드 켜기.
    // 단계가 셋이나 되고 FAB 이 늘 화면을 가렸다.
    // 새 구조: **키보드가 뜨면 도크도 함께 뜬다.** 읽을 때는 화면에 아무것도 안 떠 있고,
    //   더블탭(또는 탭바 `⌨`)으로 입력 모드에 들어가면 키보드 바로 위에 특수키가 붙는다.
    //   → FAB 은 사라졌고, 도크의 표시 여부는 `applyViewport` 가 `kbOpen` 으로 정한다.
    const pad = $("#pad");
    pad.hidden = true;
    // 도크 안쪽 터치는 keyboard.js 가 처리한다 — 터미널의 더블탭 판정까지 내려가면 안 된다.
    pad.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

    // ⭐ 폰 내비 — 헤더 자리를 `[≡][칩바][⌨]` 로 바꾼다(칩·드로어 렌더는 renderPhoneNav/renderDrawer).
    //   ⚠ `+ 새 탭`·`설치` 버튼은 **복제하지 않고 옮긴다** — 복제하면 핸들러가 둘로 갈라져
    //     한쪽만 동작하는 버그가 난다(PC 헤더의 그 버튼이 그대로 드로어 바닥에서 산다).
    const navBtn = $("#nav-menu"), drawer = $("#drawer");
    navBtn.hidden = false;
    navBtn.onclick = openDrawer;
    $("#dw-close").onclick = closeDrawer;
    drawer.addEventListener("click", (e) => { if (e.target === drawer) closeDrawer(); });
    const refitBtn = $("#nav-refit");
    refitBtn.hidden = false;
    refitBtn.onclick = () => refitPane(activeSid);
    const foot = drawer.querySelector(".dw-foot");
    const nt = $("#new-tab");
    nt.textContent = "+ 새 탭";        // 헤더에서는 `+` 하나로 충분했지만 목록 바닥에서는 이름이 필요하다
    foot.appendChild(nt);
    foot.appendChild($("#install"));
    renderPhoneNav();

    // ⭐ 읽기용 스크롤 도크 — 키보드가 꺼져 있을 때만 뜬다(표시 여부는 `applyViewport`).
    //   ⚠ 여기 셋은 **터미널로 보내는 키가 아니라 xterm 스크롤백 조작**이다.
    //     예전에 방향키 꾹 누르기에 `k:pgup` 을 넣었다가 "눌러도 스크롤이 안 된다"는 제보를 받았다 —
    //     `k:*` 는 셸로 가는 키라 화면은 안 움직인다(wiki 의 "화면 스크롤은 키가 아니다").
    const spad = $("#scrollpad");
    spad.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    spad.addEventListener("click", (e) => {
      const v = e.target && e.target.dataset && e.target.dataset.scroll;
      if (!v) return;
      if (v === "end") window.__wt.app.bottom();
      else window.__wt.app.scroll(+v);
    });
    // ⭐ 폰 기본값은 **읽기 모드**다. 예전엔 `touchend` 마다 `term.focus()` 를 불렀는데,
    //   그 한 줄이 증상 둘을 동시에 만들었다:
    //     ① 화면 아무 데나 터치해도 안드로이드 키보드가 튀어나온다
    //     ② 스크롤하려고 밀어도 touchend 순간 포커스가 잡히며 브라우저가 커서로 되돌려
    //        **관성이 죽는다**(한 줄씩만 움직이는 것처럼 느껴진다)
    //   폰에서는 보는 시간이 대부분이므로, 입력은 `⌨` 로 **명시적으로 켠다**.
    //
    //   `inputMode="none"` 이 핵심 — 포커스는 유지하되(특수키·붙여넣기는 그대로 동작)
    //   **소프트 키보드만 안 뜬다**. readOnly 로 막으면 입력 자체가 죽는다.
    const setTyping = (on) => {
      typing = on;
      // `applyInputMode` 한 곳에만 규칙을 둔다(inputMode + disabled 를 함께 다뤄야 하므로
      // 여기서 inputMode 만 손대면 읽기 모드인데 포커스가 잡히는 구멍이 다시 생긴다)
      panes.forEach(p => applyInputMode(p.term));
      const tgb = $("#kb-toggle");
      tgb.classList.toggle("on", on);
      tgb.title = on ? "입력 모드 — 누르면 키보드를 닫고 읽기 모드로" : "읽기 모드 — 누르거나 화면을 더블탭하면 입력 모드";
      const p = panes.get(activeSid);
      if (!p) return;
      if (on) {
        p.term.focus();
        setTimeout(() => p.term.scrollToBottom(), 350);   // 키보드가 올라온 뒤 커서를 보이게
      } else if (p.term.textarea) {
        p.term.textarea.blur();
        setTimeout(() => { window.scrollTo(0, 0); p.term.scrollToBottom(); }, 260);
      }
    };

    togglePhoneKb = () => setTyping(!typing);   // 도크 안 ⌨ 키가 부른다
    // 바깥(focusPane 등)에서 부르는 통로. **상태가 실제로 다를 때만** 움직인다 —
    // 같은 값으로 다시 부르면 blur·scrollTo 타이머가 헛돌아 화면이 미세하게 튄다.
    setPhoneTyping = (on) => { if (typing !== on) setTyping(on); };
    const tg = $("#kb-toggle");
    // ⭐ 키보드를 켜는 진입점. 주 경로는 **화면 더블탭**이고, 이건 보조다.
    //   예전에는 도크 안 `⌨` 키가 그 역할이라 숨겨뒀는데, 도크가 키보드와 함께만 뜨게 되면서
    //   **키보드가 꺼져 있을 때 켤 방법이 더블탭 하나뿐**이 됐다 → 탭바 버튼을 되살린다.
    tg.hidden = false;
    tg.onclick = () => setTyping(!typing);
    setTyping(false);                 // 처음엔 읽기 모드로 연다

    // 터미널 제스처 셋 — 한 곳에서 갈라진다:
    //   · **한 번 탭** = 아무 일도 안 한다(스크롤을 방해하지 않으려고)
    //   · **더블탭** = 입력 모드 토글(키보드 켜기/끄기)
    //   · **꾹 누르기(450ms) → 끌기** = **텍스트 선택**, 손 떼면 클립보드로 복사
    //
    // ⚠ 스크롤 제스처의 touchend 를 탭으로 오인하면 안 된다 → 손가락이 12px 이상 움직였으면 무시.
    //   예전엔 touchend 마다 focus() 를 불러서 스크롤 관성이 매번 끊겼다.
    //
    // ⭐⭐ 왜 선택을 우리가 직접 구현하는가:
    //   xterm 의 선택은 **마우스 이벤트**(mousedown/mousemove) 위에 얹혀 있다. 모바일 브라우저는
    //   탭에는 호환 마우스 이벤트를 주지만 **끌기에는 안 준다** → 폰에서는 드래그 선택이
    //   원리적으로 안 된다. 그래서 터치 좌표를 셀 좌표로 바꿔 `term.select()` 를 직접 부른다.
    //
    // ⚠ 정밀도의 한계: 공개 API 는 `select(col, row, len)`(한 줄 안) 과
    //   `selectLines(start, end)`(줄 단위) 뿐이다. 그래서 **같은 줄을 끌면 글자 단위**,
    //   **여러 줄을 걸치면 줄 단위**로 잡는다. claude 답변을 뜨는 용도로는 줄 단위가 오히려 맞다
    //   (내부 SelectionService 를 건드리면 xterm 버전 올릴 때마다 깨진다).
    {
      let sx = 0, sy = 0, tapAt = 0;
      let lpTimer = 0;              // 꾹 누르기 판정 타이머
      let sel = null;               // 선택 중이면 { p, col, row } (앵커)
      const el = $("#panes");

      // 터치 좌표 → 셀 좌표. cellW/H 는 `.xterm-screen` 실측 크기 ÷ cols·rows 로 낸다
      // (dpr·폰트 폴백 때문에 상수로 두면 어긋난다 — wiki 의 폰트 폴백 항목과 같은 이유).
      const cellAt = (p, x, y) => {
        const scr = p.el.querySelector(".xterm-screen");
        if (!scr) return null;
        const r = scr.getBoundingClientRect();
        const cw = r.width / p.term.cols, ch = r.height / p.term.rows;
        if (!(cw > 0) || !(ch > 0)) return null;
        const cl = (v, hi) => Math.max(0, Math.min(hi, v));
        return {
          col: cl(Math.floor((x - r.left) / cw), p.term.cols - 1),
          // 스크롤백을 감안한 **절대 행**(`select`/`selectLines` 는 버퍼 좌표를 받는다)
          row: p.term.buffer.active.viewportY + cl(Math.floor((y - r.top) / ch), p.term.rows - 1),
        };
      };
      const paneAt = (target) => {
        for (const p of panes.values()) if (p.el.contains(target)) return p;
        return panes.get(activeSid) || null;
      };

      const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };

      // 선택을 손가락 위치까지 늘린다(터치 이동 · 경계 자동 스크롤 둘 다 여기로 모인다).
      const applySelTo = (x, y) => {
        if (!sel) return;
        const c = cellAt(sel.p, x, y);
        if (!c) return;
        // ⚠ **셀이 바뀌었을 때만** 끌었다고 본다 — 손가락 미세한 흔들림까지 드래그로 세면
        //   메뉴를 부르려던 꾹 누르기가 "1글자 복사"로 새어나간다.
        if (c.col !== sel.col || c.row !== sel.row) sel.moved = true;
        if (c.row === sel.row) {
          const c0 = Math.min(c.col, sel.col);
          sel.p.term.select(c0, sel.row, Math.abs(c.col - sel.col) + 1);
        } else {
          sel.p.term.selectLines(Math.min(c.row, sel.row), Math.max(c.row, sel.row));
        }
      };

      // 경계 자동 스크롤 — 손가락이 화면 위/아래 끝 띠에 머무는 동안 한 줄씩 굴린다.
      //   `cellAt` 이 `viewportY` 를 더해 **절대 행**을 내므로, 스크롤이 곧 선택 확장이 된다.
      //
      // ⚠ `vp.scrollTop` 을 직접 밀지 않고 **`term.scrollLines()`** 를 쓴다 — 스크롤의 단위는
      //   픽셀이 아니라 줄이고, 무엇보다 `viewportY` 가 확실히 따라온다(우리가 절대 행을 그걸로
      //   계산하므로, 화면만 움직이고 `viewportY` 가 그대로면 선택은 한 줄도 안 늘어난다).
      let lastX = 0, lastY = 0, autoDir = 0, autoTimer = 0;
      const autoStop = () => { if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; } autoDir = 0; };
      const autoStep = () => {
        if (!sel || !autoDir) { autoStop(); return; }
        sel.p.term.scrollLines(autoDir);
        lockTop = -1;                    // 이 스크롤은 **우리가 한 것** — 잠금 기준을 새 위치로 옮긴다
        applySelTo(lastX, lastY);
      };

      // ⭐⭐⭐ 선택 중 **스크롤 잠금** — 플래그로 스크롤러들을 설득하는 짓을 그만둔다.
      //
      // ⚠ 지금까지는 `selecting` 을 세워두고 관성 핸들러가 스스로 물러나기를 기대했다. 실측
      //   (2026-08-27 `lp-drag` 로그)에서 그게 안 통했다 — 손가락을 내릴수록 `viewportY` 가
      //   1970 → 1954 로 **줄고**(화면은 위로 흐르고) 그만큼 선택은 제자리였다. 스크롤 감소량이
      //   손가락 이동량과 1:1 이라, 누군가는 여전히 `scrollTop` 을 밀고 있다는 뜻이다.
      //   출처를 하나씩 쫓는 대신 **결과 지점 한 곳**(`scroll` 이벤트)에서 되돌린다 —
      //   관성이든 브라우저 기본 팬이든 xterm 내부든, 선택 중에 화면이 흐르면 제자리로 돌린다.
      //   우리 자동 스크롤(`autoStep`)만 기준선을 옮길 수 있다.
      let lockTop = -1, lockVp = null;
      const onLockScroll = () => {
        if (!sel || !lockVp) return;
        if (lockTop < 0) { lockTop = lockVp.scrollTop; return; }   // autoStep 이 옮긴 새 기준
        if (Math.abs(lockVp.scrollTop - lockTop) > 0.5) lockVp.scrollTop = lockTop;
      };
      const lockScroll = (p) => {
        unlockScroll();
        lockVp = p.el.querySelector(".xterm-viewport");
        if (!lockVp) return;
        lockTop = lockVp.scrollTop;
        lockVp.addEventListener("scroll", onLockScroll);
      };
      const unlockScroll = () => {
        if (lockVp) lockVp.removeEventListener("scroll", onLockScroll);
        lockVp = null; lockTop = -1;
      };
      const autoStart = (dir) => {
        if (autoDir === dir) return;
        autoDir = dir;
        if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; }
        if (dir) { autoStep(); autoTimer = setInterval(autoStep, 90); }   // 초당 ~11줄
      };

      // 🔎 임시 진단 — 끌 때 실제로 무엇이 움직이는지(터미널 뷰포트인지 페이지인지) 실측한다.
      //   `vy`(viewportY) 가 안 변하는데 화면이 내려간다면 움직이는 것은 **페이지**이고,
      //   그러면 손가락과 셀의 대응이 그대로라 선택이 한 줄도 안 늘어난다.
      let dragLogAt = 0;
      const dragLog = (tag) => {
        const now = performance.now();
        if (now - dragLogAt < 250) return;
        dragLogAt = now;
        const scr = sel && sel.p.el.querySelector(".xterm-screen");
        const vp = sel && sel.p.el.querySelector(".xterm-viewport");
        const r = scr && scr.getBoundingClientRect();
        diag({ ev: "lp-drag", tag, y: Math.round(lastY), dir: autoDir,
               selecting, lock: Math.round(lockTop),
               ta: vp ? getComputedStyle(vp).touchAction : null,
               top: r ? Math.round(r.top) : null, bot: r ? Math.round(r.bottom) : null,
               vy: sel ? sel.p.term.buffer.active.viewportY : null,
               st: vp ? Math.round(vp.scrollTop) : null,
               pageY: Math.round(window.scrollY), vvTop: Math.round(window.visualViewport ? window.visualViewport.offsetTop : 0),
               anchor: sel ? sel.row : null, len: sel ? (sel.p.term.getSelection() || "").length : 0 });
      };

      el.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        if (!t) return;
        sx = t.clientX; sy = t.clientY;
        const p = paneAt(e.target);
        if (p) p.term.clearSelection();      // 새 제스처가 시작되면 지난 선택은 지운다
        sel = null; selecting = false;       // 앞 제스처가 비정상 종료됐어도 여기서 확실히 푼다
        autoStop(); unlockScroll();
        clearLp();
        if (e.touches.length > 1) return;    // 두 손가락(핀치·스크롤)은 선택이 아니다
        lpTimer = setTimeout(() => {
          lpTimer = 0;
          // 🔎 임시 진단(2026-08-27): "꾹 눌러 선택이 안 된다" 의 어느 단계에서 끊기는지 —
          //    타이머가 아예 안 오는지(lp-cancel 만 찍힘) · 셀 계산이 실패하는지 · 선택은
          //    걸리는데 화면에 안 보이는지(lp-fire 는 찍히는데 사용자는 못 봄)를 가른다.
          if (!p) { diag({ ev: "lp-nopane" }); return; }
          const c = cellAt(p, sx, sy);
          if (!c) { diag({ ev: "lp-nocell" }); return; }
          diag({ ev: "lp-fire", col: c.col, row: c.row, rows: p.term.rows, cols: p.term.cols });
          sel = { p, col: c.col, row: c.row };
          selecting = true;                 // ⭐ 관성 스크롤 핸들러가 물러나게 하는 스위치
          lockScroll(p);                    // ⭐⭐ 그 스위치를 안 지키는 놈까지 막는 잠금
          p.term.select(c.col, c.row, 1);
          if (navigator.vibrate) navigator.vibrate(15);   // "선택 모드로 들어갔다"는 유일한 신호
          flash("끌면 선택·복사 · 떼면 메뉴");
        }, 450);
      }, { passive: true });

      // ⚠ 이 리스너만 **passive 가 아니다** — 선택 중에는 `preventDefault()` 로
      //   브라우저 스크롤을 막아야 손가락을 따라 선택이 늘어난다.
      el.addEventListener("touchmove", (e) => {
        const t = e.touches[0];
        if (!t) return;
        if (!sel) {
          // 아직 선택 모드가 아니면, 움직임은 곧 스크롤이므로 꾹 누르기 판정을 취소한다
          if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearLp();
          return;
        }
        e.preventDefault();
        lastX = t.clientX; lastY = t.clientY;
        applySelTo(lastX, lastY);
        // ⭐ 화면 끝에 닿으면 **따라 스크롤한다.** 없으면 선택은 지금 보이는 줄까지가 전부다
        //   ("밑에 줄로 쭉 내리려니 안 된다"의 나머지 절반 — 브라우저 스크롤을 껐으니
        //    경계를 넘는 선택은 우리가 굴려줘야 한다).
        // 경계 판정은 `cellAt` 과 **같은 기준**(.xterm-screen)으로 한다 — pane 박스로 재면
        //   padding·스크롤바만큼 어긋나 "끝에 닿았는데 안 굴러가는" 구간이 생긴다.
        const scr = sel.p.el.querySelector(".xterm-screen");
        const r = (scr || sel.p.el).getBoundingClientRect();
        const EDGE = 44;                                   // 경계로 치는 띠의 두께(px)
        autoStart(lastY > r.bottom - EDGE ? 1 : (lastY < r.top + EDGE ? -1 : 0));
        dragLog("move");
      }, { passive: false });

      // 꾹 누르기로 시작된 제스처를 끝낸다. 반환값 = "이 제스처는 탭이 아니었다".
      //   · 끌었다  → 선택한 텍스트를 클립보드로
      //   · 안 끌었다 → **컨텍스트 메뉴**(분할·줌·이름·닫기). 폰에서 예전에 꾹 누르면 뜨던 그 메뉴로,
      //     `contextmenu` 경로를 막은 대신 여기로 옮겼다.
      const endSel = () => {
        autoStop(); unlockScroll();
        if (!sel) return false;
        const p = sel.p, moved = sel.moved, ax = sx, ay = sy;
        sel = null; selecting = false;
        if (!moved) {
          p.term.clearSelection();
          openMenu({ clientX: ax, clientY: ay }, activeTab, p.sid);
          return true;
        }
        const text = p.term.getSelection();
        diag({ ev: "lp-end", moved: true, len: (text || "").length });   // 🔎 임시 진단
        if (!text || !text.trim()) { flash("선택 없음"); return true; }
        // ⚠ `writeText` 는 사용자 제스처 안에서만 허용된다 — touchend 핸들러가 바로 그것이다.
        //   (secure context 가 아니면 API 자체가 없다 → `copyToClipboard` 가 레거시로 넘긴다)
        copyToClipboard(text);
        flash("복사됨 " + text.length + "자");
        return true;
      };

      // ⚠ 이 리스너도 passive 가 아니다 — 꾹 누르기로 끝난 제스처는 뒤따르는 **합성 click** 을
      //   막아야 한다(그 click 이 방금 연 메뉴를 즉시 닫고, 탭 판정도 어지럽힌다).
      el.addEventListener("touchend", (e) => {
        clearLp();
        if (endSel()) {                             // 선택·메뉴 제스처였다 → 탭 판정으로 내려가지 않는다
          tapAt = 0;
          if (e.cancelable) e.preventDefault();
          return;
        }
        const t = e.changedTouches[0];
        if (!t) return;
        if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) return;  // 스크롤이었다
        const now = performance.now();
        if (now - tapAt < 350) { tapAt = 0; setTyping(!typing); }   // 두 번째 탭 = 토글(껐다 켰다)
        else tapAt = now;
      }, { passive: false });

      // ⚠ `touchcancel` 은 대개 **브라우저가 제스처를 스크롤로 가져갔다**는 뜻이다 —
      //   선택 중에 이게 오면 `touch-action` 예약이 아직 어딘가 살아있다는 신호이므로 기록한다.
      el.addEventListener("touchcancel", () => {
        if (sel) diag({ ev: "lp-touchcancel", moved: !!sel.moved });
        clearLp(); autoStop(); unlockScroll(); sel = null; selecting = false;
      }, { passive: true });
    }
    // 새 pane 이 생겨도 현재 모드를 따르게 한다(렌더 후 textarea 가 만들어지므로 지연을 둔다)
    setInterval(() => setTypingSync(), 5000);   // 백업 — 주 경로는 applyInputMode(생성·포커스 시점)
    function setTypingSync() {
      panes.forEach(p => {
        const ta = p.term.textarea;
        if (!ta) return;
        if (ta.inputMode !== (typing ? "text" : "none") || ta.disabled === typing) applyInputMode(p.term);
      });
    }

    // ⭐⭐ 소프트 키보드 대응 — **보이는 높이만큼 body 를 줄이고 터미널을 다시 그린다.**
    //
    // 예전에는 body 를 건드리지 않고 스크롤만 보정했다. 이유는 "wezterm-web 처럼 높이를
    // 강제했더니 터미널이 위쪽에만 그려지고 아래가 텅 비었다"였는데, **그때 빠진 것은
    // 높이를 바꾼 뒤 `fit()` 을 다시 하는 일**이었다. xterm 은 자기 크기를 스스로 계산하므로
    // 밖에서 높이만 바꾸고 알려주지 않으면 어긋난다 — 반대로 **바꾸고 알려주면 정확히 맞는다.**
    // → 높이를 줄이고 `resizeAll()`(fit → PTY 보고)까지 한 벌로 묶는다.
    //
    // 대가: 키보드를 여닫을 때마다 PTY 크기가 바뀌어 claude 같은 TUI 가 화면을 다시 그린다.
    // 사용자 결정(2026-08-24)으로 그 쪽을 택했다 — 가려진 화면을 보느니 다시 그리는 편이 낫다.
    {
      const vv = window.visualViewport;
      let vvTimer = 0;
      applyViewport = () => {
        // ⭐ 키보드 높이 = **레이아웃 뷰포트 − 시각 뷰포트**.
        //
        // ⚠ 예전에는 "키보드가 없을 때의 `vv.height` 최대값"을 기준으로 삼았는데,
        //   **폴더블에서 무너진다** — 펼쳤다가(1104) 접으면(709) 그 차이 395px 를
        //   키보드로 **오판**해 `kb-open` 이 걸리고, 그 클래스가 FAB 을 숨겨
        //   "접으면 플로팅 버튼이 사라지는" 증상이 됐다(사용자 제보 2026-08-24).
        //   `innerHeight` 는 폴드로 화면이 작아지면 **같이** 줄고, 소프트 키보드에는
        //   반응하지 않는다 → 둘의 차이는 순수한 키보드 높이다. 주소창 오차(≈96px)는
        //   임계값 150 아래로 걸러진다.
        const vh = vv ? vv.height : window.innerHeight;
        const kbH = Math.max(0, Math.round(window.innerHeight - vh));
        const open = kbH > 150;
        const changed = open !== kbOpen;
        kbOpen = open;
        document.body.classList.toggle("kb-open", kbOpen);

        // ⭐⭐ **키보드가 닫혔으면 입력 모드도 꺼진 것이다.** 안드로이드 뒤로가기로 키보드만
        //   내리면 브라우저는 아무 이벤트도 주지 않아 앱은 계속 `typing=true` 로 알고 있었고,
        //   그 어긋난 상태가 다음 탭 전환에서 키보드를 되살렸다(2026-08-27, 제보 9회차).
        //   여기서 **실제 키보드 상태를 진실로 삼아** 앱 상태를 되돌린다.
        //   ⚠ `changed && !open` 일 때만 — 켠 직후(아직 안 올라옴)는 `changed` 가 false 라 안전하다.
        if (changed && !open && typing) { setTyping(false); diag({ ev: "kb-closed-sync" }); }

        // ⭐ 도크는 **키보드가 떠 있을 때만** 보이고, 키보드 바로 위에 붙는다.
        //   ⚠ `position:fixed` 는 body 를 줄여도 **레이아웃 뷰포트** 기준이라,
        //     직접 올리지 않으면 키보드 뒤에 숨는다.
        pad.hidden = !kbOpen;
        pad.style.bottom = kbOpen ? kbH + "px" : "";
        // 읽기용 스크롤 도크는 그 반대 — 키보드가 뜨면 특수키 도크에 자리를 내준다
        spad.hidden = kbOpen;

        // ⭐⭐ **가리는 것은 키보드만이 아니다** — 특수키 도크도 화면을 덮는다.
        //
        // ⚠ 사용자 제보(2026-08-24): "플로팅 버튼으로 핫키 띄운 다음 키보드 버튼 누르면
        //   높이가 정확히 안 먹는 느낌". 정확한 지적이었다 — 도크는 `position:fixed` 라
        //   **레이아웃에는 없지만 화면은 가린다.** 키보드 높이만 빼고 도크 높이를 빼지 않으니
        //   딱 도크만큼(약 90~130px) 터미널 하단이 덮였다.
        //   → 가려지는 높이 = 키보드 + (도크가 열려 있으면 도크가 차지하는 만큼).
        //   이제 도크는 키보드에 딱 붙으므로(아래 여백 0) 도크 높이 그대로가 가려지는 양이다.
        const dockH = (pad.hidden ? 0 : pad.offsetHeight) + (spad.hidden ? 0 : spad.offsetHeight);
        const usable = Math.max(120, vh - dockH);        // 최소 높이 — 0 이 되면 xterm 이 깨진다
        document.body.style.height = (kbOpen || dockH) ? usable + "px" : "";

        clearTimeout(vvTimer);
        vvTimer = setTimeout(() => {
          // ⚠ 브라우저는 입력 지점을 보이게 하려고 **페이지 자체를 스크롤해 올린다.**
          //   키보드를 내려도 그 스크롤은 자동으로 안 돌아와 화면이 밀린 채 남는다 → 직접 되돌린다.
          window.scrollTo(0, 0);
          resizeAll();                                   // fit → PTY 에 새 크기를 요구
          const toBottom = () => { const p = panes.get(activeSid); if (p) p.term.scrollToBottom(); };
          toBottom();                                    // 커서를 키보드 위로
          // ⚠ 한 번으로는 부족하다 — 위에서 요구한 새 크기로 **셸이 화면을 다시 그리는 데
          //   시간이 걸리고**, 그 출력이 도착하면 스크롤 위치가 다시 어긋난다.
          //   (사용자 제보 2026-08-24: "키보드 띄우고 내가 스크롤을 다시 해야 하네")
          setTimeout(toBottom, 400);
          setTimeout(toBottom, 900);
        }, changed ? 180 : 60);
      };
      if (vv) {
        vv.addEventListener("resize", applyViewport);
        vv.addEventListener("scroll", applyViewport);
      }
      applyViewport();
    }

    // ⭐ 폴더블·회전 대응 — 화면이 바뀌면 **항상** 새 크기로 다시 맞춘다.
    //   `resize`/`ResizeObserver` 로도 오지만, 폴드 전환은 두 이벤트가 **레이아웃이 안정되기 전에**
    //   오는 경우가 있어(중간 크기로 한 번 잰다) 한 박자 뒤 다시 잰다.
    const refit = () => setTimeout(resizeAll, 350);
    addEventListener("resize", refit);
    if (screen.orientation) screen.orientation.addEventListener("change", refit);
  }

  // ---------- 홈 화면에 설치 ----------
  // 설치 요건(HTTPS · manifest · SW · 아이콘)은 이미 갖췄지만, 사용자가 Chrome 메뉴를
  // 뒤져야 하는 것이 불편하다. `beforeinstallprompt` 를 잡아두고 **앱 안에서** 띄운다.
  // ⚠ 이 이벤트는 브라우저가 "설치 가능"이라 판단했을 때만 온다 —
  //   이미 설치했거나 조건 미달이면 안 오고, 그때는 버튼도 안 보인다(그게 맞는 동작이다).
  let installPrompt = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();               // 브라우저 기본 배너를 막고 우리가 타이밍을 정한다
    installPrompt = e;
    const b = $("#install");
    if (b) b.hidden = false;
  });
  addEventListener("appinstalled", () => {
    installPrompt = null;
    const b = $("#install");
    if (b) b.hidden = true;
  });
  {
    const b = $("#install");
    if (b) b.onclick = async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;   // 수락/거절 무엇이든 이 프롬프트는 재사용할 수 없다
      installPrompt = null;
      b.hidden = true;
    };
  }

  // ---------- 렌더 환경 진단 ----------
  // 브라우저가 "무엇으로 그리고 있는지"를 서버 로그에 한 줄 남긴다.
  // 폰트는 지정한다고 쓰이는 게 아니다 — 시스템에 없으면 조용히 폴백된다.
  setTimeout(() => {
    try {
      const probe = (f) => document.fonts.check(`${fontSize}px "${f}"`);
      const cv = document.createElement("canvas").getContext("2d");
      const wid = (f) => { cv.font = `${fontSize}px ${f}`; return +cv.measureText("M").width.toFixed(2); };
      const p = panes.get(activeSid);
      const dims = p && p.term._core && p.term._core._renderService
        ? p.term._core._renderService.dimensions : null;
      fetch("/api/diag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ver: APP_VER,              // 이 브라우저가 실제로 돌리는 코드 버전(캐시 확인용)
          dpr: devicePixelRatio,
          zoom: Math.round(devicePixelRatio * 100) + "%",
          fontSize, lineHeight: 1.15,
          has: { jetbrains: probe("JetBrains Mono"), consolas: probe("Consolas"),
                 cascadia: probe("Cascadia Mono"), malgun: probe("Malgun Gothic"),
                 d2coding: probe("D2Coding") },
          // 폰트가 진짜 붙었는지는 이름이 아니라 폭으로 판정한다. 각각 단독으로 재서 비교하면
          // 어느 것이 실제로 그리고 있는지 알 수 있다(JetBrains 0.6em vs Sarasa 0.5em vs Consolas 0.55em).
          widthM: { consolas: wid("Consolas"), fallback: wid("monospace"),
                    jbmOnly: wid('"JetBrains Mono"'), sarasaOnly: wid('"Sarasa Fixed K"') },
          // ⭐ 폰트 적용 여부는 이름이 아니라 **폭**으로 판정한다(document.fonts.check 는 못 믿는다).
          //   기준은 M(1칸). ambiguous 문자가 M 과 같으면 반각(정상), 2배면 전각(옆 칸 침범).
          w: (() => {
            // 실제 체인 그대로 재서, 어느 폰트가 그리는지 폭으로 역추적한다
            const f = `${fontSize}px "JetBrains Mono","Sarasa Fixed K",monospace`;
            cv.font = f;
            const one = cv.measureText("M").width;
            const r = {};
            for (const ch of ["M", "①", "·", "←", "가", "⚡"]) {
              r[ch] = +(cv.measureText(ch).width / one).toFixed(2);   // M 대비 몇 칸인가
            }
            return r;
          })(),
          // ⚠ `document.fonts.check` 는 못 믿는다(로컬 폰트는 없어도 true). 실제 로드 상태를 본다.
          loaded: [...document.fonts].filter(f => /Sarasa|JetBrains/.test(f.family))
                    .map(f => f.family + ":" + f.status).slice(0, 6),
          cell: dims && dims.css ? dims.css.cell : null,
          screen: `${innerWidth}x${innerHeight}`,
        }),
      });
    } catch (e) { /* 진단 실패가 터미널을 방해하면 안 된다 */ }
  }, 1500);

  // 사용자가 이 창을 실제로 만졌을 때만 크기의 주인이 된다(위 `claimOwnership` 참조).
  //   ⚠ `focus` 는 넣지 않는다 — 창을 띄우기만 해도 발생해 "붙는 것만으로 뺏지 않는다"가 깨진다.
  addEventListener("mousedown", claimOwnership, true);
  addEventListener("keydown", claimOwnership, true);
  addEventListener("touchstart", claimOwnership, { capture: true, passive: true });
  addEventListener("wheel", claimOwnership, { capture: true, passive: true });

  // ⭐ 크기 진단 — **추측 대신 값**. 사용자 화면의 xterm/PTY/픽셀을 서버 로그에 남긴다.
  //   "칸 수가 어긋난 것 같다"를 캡처 픽셀로 역산하는 짓을 그만하려고 넣었다.
  //   5초마다 돌지만 **어긋났을 때만** 보낸다(정상이면 로그를 더럽히지 않는다).
  {
    let lastSig = "";
    setInterval(() => {
      const rows = [];
      for (const [sid, p] of panes) {
        if (isOff(p)) continue;
        const sess = sessions.find((x) => x.sid === sid);
        if (!sess) continue;
        const ok = p.term.cols === sess.cols && p.term.rows === sess.rows;
        if (ok) continue;                       // 일치하면 조용히 넘어간다
        const box = p.el.getBoundingClientRect();
        rows.push({
          tab: sess.name, sid: sid.slice(0, 8),
          xterm: p.term.cols + "x" + p.term.rows,
          pty: sess.cols + "x" + sess.rows,
          paneW: Math.round(box.width), paneH: Math.round(box.height),
          reported: p.reported ? p.reported.join("x") : null,
          owner: reportSize, forced: forced,
        });
      }
      if (!rows.length) return;
      const sig = JSON.stringify(rows);
      if (sig === lastSig) return;              // 같은 상태를 반복해 보내지 않는다
      lastSig = sig;
      try {
        fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ev: "size-diag", ver: APP_VER, rows: rows }) });
      } catch (_) {}
    }, 5000);
  }

  // ---------- 주기 작업 ----------
  addEventListener("resize", scheduleResize);
  // ⭐ 회전(가로↔세로) — `resize` 가 **회전 애니메이션 도중**에 오는 기기가 있어 중간 크기를
  //   재버린다. 회전 이벤트를 따로 받아 한 박자 뒤 다시 잰다.
  if (screen.orientation) screen.orientation.addEventListener("change", () => setTimeout(resizeAll, 350));
  addEventListener("orientationchange", () => setTimeout(resizeAll, 350));
  // ⭐ **보고 있는 쪽이 주인** — PC 와 폰이 같이 붙어 있으면 크기가 서로 다를 수밖에 없다.
  //   창을 다시 보는(포커스·복귀) 순간 자기 크기를 재보고해, 지금 보는 화면에 맞춰진다.
  //   이게 없으면 폰을 보다 PC 로 왔을 때 창 크기를 건드리기 전까지 폰 크기에 남는다.
  addEventListener("focus", () => setTimeout(resizeAll, 120));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(resizeAll, 200); });
  // 설치된 PWA 창에서 창 버튼 영역이 바뀔 때(최대화 등). 창 크기가 그대로여도 탭바 폭이 변한다.
  if (navigator.windowControlsOverlay) {
    navigator.windowControlsOverlay.addEventListener("geometrychange", scheduleResize);
  }
  new ResizeObserver(scheduleResize).observe($("#panes"));
  setInterval(() => {
    const p = panes.get(activeSid);
    if (p && p.ws && p.ws.readyState === 1) { pingAt = performance.now(); wsend(p, { t: "ping" }); }
  }, 2000);
  setInterval(refresh, 4000);
  setInterval(() => {
    const d = new Date(), z = (n) => String(n).padStart(2, "0");
    $("#clock").textContent = `${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }, 1000);

  // ---------- 부팅 ----------
  (async () => {
    await loadConfig();          // 키맵·기본 cwd·폰트
    await refresh();
    if (!sessions.length) await newTab(DEFAULT_CWD);
    else focusPane(activeSid);
  })();
})();
