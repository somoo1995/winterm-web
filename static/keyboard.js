/* 가상 키보드 엔진 — 렌더 + 8방향 스와이프 + 두벌식 한글 조합
   레이아웃 데이터는 kb-layout.js. 이 파일은 동작만 담당한다.

   ── 설계 요지 ──────────────────────────────────────────────
   1) 문자키는 pane 으로 바로 안 쏘고 **입력창(#cmd)에 쌓는다**.
      - cli 왕복(37~72ms)이 글자마다 붙으면 타이핑이 느려진다
      - 한글 조합 중인 글자를 눈으로 보려면 어차피 로컬 버퍼가 필요하다
   2) 한글 조합은 **브라우저가 끝내고 완성된 음절만** 나간다.
      Unexpected Keyboard 는 조합을 modifier 로 처리해 키 라벨이 춤췄는데(PR #595 구조),
      여기선 조합 상태가 입력창에만 있으므로 **라벨이 절대 안 바뀐다.**
   3) 기능키(Esc/Ctrl/방향키)는 즉시 /api/key. modifier 상태를 안 들고
      제어문자를 그대로 쏘므로 "Ctrl 이 눌린 채 안 풀림" 이 구조적으로 불가능.

   app.js 의 전역(state·post·needPane·refreshScreen·setStatus·sendInput·cmd)을 그대로 쓴다.
*/
"use strict";

(function () {
  // ── 두벌식 조합 테이블 ──────────────────────────────────
  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  // 복합 모음/받침 결합 (앞+뒤 → 합친 것)
  const JUNG_COMBO = { "ㅗㅏ":"ㅘ","ㅗㅐ":"ㅙ","ㅗㅣ":"ㅚ","ㅜㅓ":"ㅝ","ㅜㅔ":"ㅞ","ㅜㅣ":"ㅟ","ㅡㅣ":"ㅢ" };
  const JONG_COMBO = { "ㄱㅅ":"ㄳ","ㄴㅈ":"ㄵ","ㄴㅎ":"ㄶ","ㄹㄱ":"ㄺ","ㄹㅁ":"ㄻ","ㄹㅂ":"ㄼ","ㄹㅅ":"ㄽ","ㄹㅌ":"ㄾ","ㄹㅍ":"ㄿ","ㄹㅎ":"ㅀ","ㅂㅅ":"ㅄ" };
  // 분해 (모음이 와서 받침을 뒷 음절 초성으로 넘길 때 / 백스페이스로 되돌릴 때)
  const JONG_SPLIT = { "ㄳ":["ㄱ","ㅅ"],"ㄵ":["ㄴ","ㅈ"],"ㄶ":["ㄴ","ㅎ"],"ㄺ":["ㄹ","ㄱ"],"ㄻ":["ㄹ","ㅁ"],
                       "ㄼ":["ㄹ","ㅂ"],"ㄽ":["ㄹ","ㅅ"],"ㄾ":["ㄹ","ㅌ"],"ㄿ":["ㄹ","ㅍ"],"ㅀ":["ㄹ","ㅎ"],"ㅄ":["ㅂ","ㅅ"] };
  const JUNG_SPLIT = { "ㅘ":"ㅗ","ㅙ":"ㅗ","ㅚ":"ㅗ","ㅝ":"ㅜ","ㅞ":"ㅜ","ㅟ":"ㅜ","ㅢ":"ㅡ" };

  const isVowel = ch => JUNG.indexOf(ch) >= 0;
  const isJamo  = ch => isVowel(ch) || CHO.indexOf(ch) >= 0;

  // 두벌식 shift = 대문자가 아니라 쌍자음/이중모음. 영문엔 안 걸리므로 toUpperCase 로 폴백해
  // 한 함수가 두 레이어를 다 처리한다(한글은 toUpperCase 가 무영향).
  const KO_SHIFT = { "ㅂ":"ㅃ", "ㅈ":"ㅉ", "ㄷ":"ㄸ", "ㄱ":"ㄲ", "ㅅ":"ㅆ", "ㅐ":"ㅒ", "ㅔ":"ㅖ" };
  const shiftChar = ch => KO_SHIFT[ch] || ch.toUpperCase();

  // 조합 상태 { cho, jung, jong } — 없으면 null. 입력창 끝 1글자를 이 상태가 소유한다.
  let comp = null;
  let compBase = "";   // 조합 시작 시점의 확정 텍스트 (조합 글자를 뺀 앞부분)

  function compChar(c) {
    if (!c) return "";
    if (c.cho && c.jung) {
      const ci = CHO.indexOf(c.cho), ji = JUNG.indexOf(c.jung), ki = c.jong ? JONG.indexOf(c.jong) : 0;
      if (ci >= 0 && ji >= 0 && ki >= 0) return String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + ki);
    }
    return (c.cho || "") + (c.jung || "") + (c.jong || "");
  }

  // 입력창에 (확정텍스트 + 조합중 글자) 를 그린다. 조합 중인 글자는 항상 맨 끝 1글자.
  function paint() {
    const el = document.getElementById("cmd");
    el.textContent = compBase + compChar(comp);
    el.scrollTop = el.scrollHeight;
  }

  // 조합을 끝내고 확정 텍스트에 흡수 (레이어 전환·영문 입력·전송 직전에 호출)
  function commit() {
    if (!comp) return;
    compBase += compChar(comp);
    comp = null;
  }

  // 확정 텍스트를 입력창 실제 내용과 동기화.
  // 폰 기본 키보드로 직접 친 경우 등 우리 모르게 바뀌었을 수 있어서, 매 입력 전에 맞춘다.
  function syncBase() {
    const el = document.getElementById("cmd");
    const shown = compBase + compChar(comp);
    if (el.textContent !== shown) { comp = null; compBase = el.textContent; }
  }

  // 자모 1개를 조합기에 넣는다 (표준 두벌식 오토마타)
  function feedJamo(ch) {
    if (!comp) { comp = isVowel(ch) ? { jung: ch } : { cho: ch }; return; }

    if (!isVowel(ch)) {                       // ── 자음이 왔다
      if (comp.cho && comp.jung) {
        if (!comp.jong && JONG.indexOf(ch) > 0) { comp.jong = ch; return; }      // 받침으로
        if (comp.jong) {
          const merged = JONG_COMBO[comp.jong + ch];
          if (merged) { comp.jong = merged; return; }                            // 겹받침
        }
      }
      commit(); comp = { cho: ch }; return;                                      // 확정하고 새 초성
    }

    // ── 모음이 왔다
    if (comp.jong) {                          // 받침을 뒷 음절 초성으로 넘긴다 ("얍"+ㅏ → "야"+"바")
      const sp = JONG_SPLIT[comp.jong];
      const moved = sp ? sp[1] : comp.jong;
      comp.jong = sp ? sp[0] : null;
      commit();
      comp = { cho: moved, jung: ch };
      return;
    }
    if (comp.cho && !comp.jung) { comp.jung = ch; return; }                      // 초성+중성
    if (comp.jung) {
      const merged = JUNG_COMBO[comp.jung + ch];
      if (merged) { comp.jung = merged; return; }                                // 복합 모음
      commit(); comp = { jung: ch }; return;
    }
    comp = { jung: ch };
  }

  // 백스페이스: 조합 중이면 한 조각씩 되돌린다. 조합이 없으면 false 를 돌려 호출부가 처리.
  function backspaceComposing() {
    if (!comp) return false;
    if (comp.jong) {
      const sp = JONG_SPLIT[comp.jong];
      comp.jong = sp ? sp[0] : null;
    } else if (comp.jung) {
      const sp = JUNG_SPLIT[comp.jung];
      comp.jung = sp || null;
      if (!comp.jung && !comp.cho) comp = null;
    } else {
      comp = null;
    }
    paint();
    return true;
  }

  // ── 입력창 조작 ─────────────────────────────────────────
  // 문자는 전부 입력창에 쌓는다. 터미널로 바로 쏘던 "직타" 모드는 제거했다 —
  // 글자마다 cli 왕복 + 미러 폴링 갱신이 겹쳐 타이핑이 뚝뚝 끊겼기 때문(2026-08-09 실사용 판정).
  function insertText(s) {
    syncBase();
    if (isJamo(s)) { feedJamo(s); paint(); return; }    // 한글은 조합기 경유
    commit();
    compBase += s;
    paint();
  }

  function doBackspace() {
    syncBase();
    if (backspaceComposing()) return;                   // 조합 중이면 조각부터 되돌리기
    if (compBase.length > 0) { compBase = compBase.slice(0, -1); paint(); return; }
    sendKey("backspace");                               // 입력창이 비었으면 터미널 쪽 지우기
  }

  function clearInput() { comp = null; compBase = ""; paint(); }

  // ── 터미널 전송 ─────────────────────────────────────────
  // 특수키는 누르는 즉시 나간다. 다만 fetch 는 완료 순서를 보장하지 않아 연타하면 순서가
  // 뒤바뀔 수 있으므로(←←↑ 가 ↑←← 로 도착), 모든 전송을 하나의 프로미스 체인에 태워 직렬화한다.
  let refreshTimer = null;
  let chain = Promise.resolve();

  function enqueue(fn) {
    chain = chain.then(fn).catch(e => setStatus(String(e), true));
    return chain;
  }
  // 미러 갱신을 조작마다 하면 get-text 가 폭주한다 → 마지막 조작 뒤 한 번만.
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshScreen(true); }, 150);
  }

  function sendKey(name) {
    if (!needPane()) return;
    enqueue(async () => {
      const res = await post("/api/key", { pane: state.pane, key: name });
      if (!res.ok) setStatus(res.msg || "키 실패", true);
    });
    scheduleRefresh();
  }

  function sendNow(text, submit) {
    if (!needPane()) return;
    enqueue(async () => {
      const res = await post("/api/send", { pane: state.pane, text: text, submit: !!submit });
      if (!res.ok) setStatus(res.msg || "전송 실패", true);
    });
    scheduleRefresh();
  }

  // 입력창 내용을 터미널로. withEnter=false 면 "주입만"(엔터 안 침) — 여러 줄 쌓거나 자동완성 걸 때.
  function submitInput(withEnter) {
    syncBase(); commit(); paint();
    const text = compBase;
    if (text.length > 0) { clearInput(); sendNow(text, withEnter); return; }
    if (withEnter) sendKey("enter");      // 입력창이 비었으면 엔터만 (기존 동작)
  }

  // ── 동작 문자열 실행 ────────────────────────────────────
  function runAction(act) {
    if (!act) return;
    if (act.slice(0, 2) === "k:") {
      commit(); paint();
      // ⭐ Shift 가 켜져 있으면 **특수키에도** 적용한다(`shift` + 키이름으로 찾아본다).
      //   예전에는 Shift 가 문자 레이어(쌍자음·대문자)에만 걸려서, 문자 자판을 걷어낸 뒤로는
      //   사실상 죽은 키였다. 터미널에서 실제로 쓰이는 것은 Shift+Tab · Shift+방향키 ·
      //   그리고 **Shift+Enter(줄바꿈)** 다 — app.js 의 `KEY_SEQ` 에 그 시퀀스들이 있다.
      //   모르는 조합이면(`shiftesc` 등) 그냥 원래 키를 보낸다.
      let key = act.slice(2);
      if (shiftOn) {
        if (window.hasKeySeq && window.hasKeySeq("shift" + key)) key = "shift" + key;
        afterChar();                     // one-shot 이면 여기서 풀린다(잠금이면 유지)
      }
      sendKey(key);
      return;
    }
    if (act.slice(0, 2) !== "a:") {
      if (ctrlOn) { applyCtrl(act); return; }        // Ctrl 이 켜져 있으면 입력창이 아니라 조합키로
      insertText(shiftOn ? shiftChar(act) : act);
      afterChar();
      return;
    }

    const a = act.slice(2);
    if (a === "bs") { doBackspace(); return; }
    if (a === "shift") { toggleShift(); return; }
    if (a === "ctrl") { toggleCtrl(); return; }
    if (a === "move") { doMove(); return; }
    if (a === "put") { submitInput(false); return; }    // 주입만 — 엔터 안 침
    if (a === "enter") { submitInput(true); return; }   // 주입 + 엔터

    // Alt 계층 — 터미널이 아니라 **앱**이 처리하는 기능(pane 줌·이동·탭 전환).
    // PC 는 `Alt+숫자`/`Alt+←→` 로 잡지만 폰에는 Alt 키가 없으므로 여기서 직접 부른다.
    if (a.slice(0, 4) === "app:") {
      const w = window.__wt && window.__wt.app;
      if (!w) return;
      const [fn, arg] = a.slice(4).split(":");
      if (typeof w[fn] === "function") w[fn](arg === undefined ? undefined : +arg);
      return;
    }

    if (a.slice(0, 6) === "layer:") { switchLayer(a.slice(6)); return; }
    if (a.slice(0, 5) === "send:") { commit(); clearInput(); sendNow(a.slice(5), true); return; }
  }

  // ⇥ 이동(Tab): 입력창 내용을 엔터 없이 주입한 뒤 Tab 으로 셸 자동완성 (기존 #pad 버튼 계승)
  // 주입과 Tab 이 같은 체인을 타므로 순서가 보장된다.
  function doMove() {
    if (!needPane()) return;
    submitInput(false);
    sendKey("tab");
  }

  // ── shift (one-shot / 더블탭 잠금) ──────────────────────
  let shiftOn = false, shiftLock = false, shiftTapAt = 0;
  function toggleShift() {
    const now = performance.now();
    const dbl = now - shiftTapAt < 400;
    shiftTapAt = now;
    // 잠금 해제를 맨 앞에 둔다 — 뒤에 두면 "잠금 중 빠르게 또 누르기"가
    // 위의 더블탭 조건에 먼저 걸려서 해제 대신 잠금이 재설정된다.
    if (shiftLock) { shiftLock = false; shiftOn = false; }
    else if (shiftOn && dbl) { shiftLock = true; }                    // 빠르게 두 번 = 잠금
    else { shiftOn = !shiftOn; }
    render();
  }
  function afterChar() {
    if (shiftOn && !shiftLock) { shiftOn = false; render(); }         // one-shot 해제
  }

  // ── ctrl — 진짜 modifier (누르고 다음 글자 = Ctrl+글자) ──
  // shift 와 같은 3단 순환: off → one-shot → (빠르게 또 누르면) 잠금 → off
  let ctrlOn = false, ctrlLock = false, ctrlTapAt = 0;
  function toggleCtrl() {
    const now = performance.now();
    const dbl = now - ctrlTapAt < 400;
    ctrlTapAt = now;
    if (ctrlLock) { ctrlLock = false; ctrlOn = false; }
    else if (ctrlOn && dbl) { ctrlLock = true; }
    else { ctrlOn = !ctrlOn; }
    render();
  }
  // 두벌식 자모 → 같은 자리의 영문키. PC 에서 한글 상태로 Ctrl+ㅊ 을 누르면
  // Ctrl+C 가 되는 것과 같은 감각을 주려고 자판 위치로 매핑한다.
  const KO_TO_EN = {
    "ㅂ":"q","ㅈ":"w","ㄷ":"e","ㄱ":"r","ㅅ":"t","ㅛ":"y","ㅕ":"u","ㅑ":"i","ㅐ":"o","ㅔ":"p",
    "ㅁ":"a","ㄴ":"s","ㅇ":"d","ㄹ":"f","ㅎ":"g","ㅗ":"h","ㅓ":"j","ㅏ":"k","ㅣ":"l",
    "ㅋ":"z","ㅌ":"x","ㅊ":"c","ㅍ":"v","ㅠ":"b","ㅜ":"n","ㅡ":"m",
    "ㅃ":"q","ㅉ":"w","ㄸ":"e","ㄲ":"r","ㅆ":"t","ㅒ":"o","ㅖ":"p",
  };
  function applyCtrl(ch) {
    const en = (KO_TO_EN[ch] || ch).toLowerCase();
    if (/^[a-z]$/.test(en)) sendKey("ctrl" + en);
    else setStatus("Ctrl+" + ch + " 조합은 없음", true);
    if (!ctrlLock) { ctrlOn = false; render(); }                      // one-shot 해제
  }

  // ── 레이어 ──────────────────────────────────────────────
  // 저장된 값이 지금 없는 레이어(문자 자판 시절의 "ko"/"sym")를 가리킬 수 있다 → 보정한다.
  let layer = localStorage.getItem("wt_kb_layer") || "en";
  if (!KB_LAYERS[layer]) layer = "en";
  let prevLetterLayer = layer === "sym" ? "en" : layer;
  function switchLayer(to) {
    commit(); paint();
    if (to === "toggle") to = layer === "ko" ? "en" : "ko";
    else if (to === "sym" && layer === "sym") to = prevLetterLayer;   // ?123 다시 누르면 원래대로
    if (to !== "sym") prevLetterLayer = to;
    shiftOn = false; shiftLock = false;      // 레이어를 옮기면 modifier 는 초기화
    ctrlOn = false; ctrlLock = false;
    layer = to;
    localStorage.setItem("wt_kb_layer", layer);
    render();
  }

  // ── 라벨 ────────────────────────────────────────────────
  const KEY_LABEL = {
    esc: "Esc", tab: "⇥", shifttab: "⇧⇥", enter: "⏎", space: "␣",
    backspace: "⌫", delete: "Del", up: "↑", down: "↓", left: "←", right: "→",
    home: "Hm", end: "End", pgup: "PgU", pgdn: "PgD",
  };
  function labelOf(act) {
    if (typeof act !== "string" || !act) return "";   // 숫자 등이 새어들어와도 죽지 않게
    if (act.slice(0, 2) === "k:") {
      const k = act.slice(2);
      if (KEY_LABEL[k]) return KEY_LABEL[k];
      if (k.slice(0, 4) === "ctrl") return "^" + k.slice(4).toUpperCase();
      return k;
    }
    if (act.slice(0, 2) === "a:") {
      const a = act.slice(2);
      if (a === "bs") return "⌫";
      if (a === "enter") return "⏎";
      if (a === "app:pastePC") return "PC";   // 📋 위쪽 보조라벨 — 스와이프하면 PC 클립보드
      return "";                       // layer/shift/send 는 l 로 직접 라벨을 준다
    }
    return shiftOn ? shiftChar(act) : act;
  }

  // ── 렌더 ────────────────────────────────────────────────
  const DIRS = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
  const padEl = document.getElementById("pad");

  function keyEl(k) {
    const el = document.createElement("div");
    el.className = "kb-key" + (k.cls ? " " + k.cls : "");
    el.style.flexGrow = String(k.wd || 1);   // 폭은 wd (w 는 서쪽 스와이프라 이름이 겹친다)
    if (k.c === "a:shift") el.classList.add("modkey-shift");    // 켜짐 상태를 그 키만 강조하려고
    if (k.c === "a:ctrl") el.classList.add("modkey-ctrl");
    const main = document.createElement("span");
    main.className = "kb-main";
    main.textContent = k.l !== undefined ? k.l : labelOf(k.c);
    el.appendChild(main);
    // 코너·상하 보조 라벨 (스와이프로 나오는 것들)
    for (const d of DIRS) {
      if (!k[d]) continue;
      const s = document.createElement("span");
      s.className = "kb-sub kb-" + d;
      s.textContent = labelOf(k[d]);
      el.appendChild(s);
    }
    bindKey(el, k);
    return el;
  }

  function render() {
    if (!padEl) return;
    padEl.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "kb-actbar";
    for (const k of KB_ACTIONBAR) {
      const b = document.createElement("button");
      b.className = "kb-abtn";
      b.textContent = k.l;
      b.onclick = () => runAction(k.c);
      bar.appendChild(b);
    }
    padEl.appendChild(bar);

    // 위 기능줄 → 레이어 문자행 → 아래 공통줄
      // ⚠ 예전엔 `|| KB_EN` 이었다. 문자 레이어를 걷어내면서 KB_EN 정의가 사라졌는데,
    //   저장된 레이어가 'ko'/'sym' 이면 `KB_LAYERS[layer]` 가 undefined 가 되어
    //   그 자리에서 **ReferenceError 로 키보드 렌더가 통째로 죽었다**(액션바만 남았다).
    //   빈 배열로 폴백한다 — 문자 레이어가 없는 것은 정상 상태다.
    const rows = KB_TOP.concat(KB_LAYERS[layer] || []).concat(KB_BOTTOM);
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = "kb-row";
      for (const k of row) r.appendChild(keyEl(k));
      padEl.appendChild(r);
    }
    // modifier 상태를 해당 키에 반영
    padEl.classList.toggle("shifted", shiftOn);
    padEl.classList.toggle("shift-lock", shiftLock);
    padEl.classList.toggle("ctrl-on", ctrlOn);
    padEl.classList.toggle("ctrl-lock", ctrlLock);
  }

  // ── 제스처: 탭 vs 8방향 스와이프 ────────────────────────
  const SWIPE_MIN = 22;    // 이 거리(px) 이상 움직이면 스와이프로 본다

  function dirOf(dx, dy) {
    // 화면 좌표는 아래가 +y 라 뒤집어서 각도 계산 (위쪽 = n)
    const ang = Math.atan2(-dy, dx) * 180 / Math.PI;    // -180..180
    if (ang >= -22.5 && ang < 22.5) return "e";
    if (ang >= 22.5 && ang < 67.5) return "ne";
    if (ang >= 67.5 && ang < 112.5) return "n";
    if (ang >= 112.5 && ang < 157.5) return "nw";
    if (ang >= -67.5 && ang < -22.5) return "se";
    if (ang >= -112.5 && ang < -67.5) return "s";
    if (ang >= -157.5 && ang < -112.5) return "sw";
    return "w";
  }

  // 꾹 누르기(롱프레스) — 대각선 스와이프는 폰에서 잘 안 맞는다는 실사용 피드백에서 나왔다.
  // 키 정의의 `lp` 에 동작을 넣으면 이 시간만큼 누르고 있을 때 발동한다(스와이프보다 확실하다).
  const LONG_MS = 420;

  function bindKey(el, k) {
    let sx = 0, sy = 0, active = false, lpTimer = 0, fired = false;
    const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };

    el.addEventListener("pointerdown", ev => {
      active = true; fired = false; sx = ev.clientX; sy = ev.clientY;
      el.classList.add("down");
      ev.preventDefault();          // 입력창 포커스 뺏기·텍스트 선택 방지 (폰 기본 키보드가 뜨지 않게)
      if (!k.lp) return;
      clearLp();
      lpTimer = setTimeout(() => {
        lpTimer = 0;
        if (!active) return;
        fired = true;               // 손을 뗄 때 탭 동작이 또 나가지 않게
        active = false;
        el.classList.remove("down");
        if (navigator.vibrate) navigator.vibrate(15);   // 발동했다는 촉각 신호
        runAction(k.lp);
      }, LONG_MS);
    });

    // 손가락이 움직이면 롱프레스가 아니라 스와이프다
    el.addEventListener("pointermove", ev => {
      if (!lpTimer) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) clearLp();
    });

    const finish = ev => {
      clearLp();
      if (fired || !active) return;   // 롱프레스로 이미 처리했으면 탭은 무시
      active = false;
      el.classList.remove("down");
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let act = k.c;
      if (Math.hypot(dx, dy) >= SWIPE_MIN) {
        const d = dirOf(dx, dy);
        if (k[d]) act = k[d];       // 그 방향이 비어 있으면 그냥 탭 동작으로 폴백
      }
      runAction(act);
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", () => { clearLp(); active = false; el.classList.remove("down"); });
    el.addEventListener("contextmenu", ev => ev.preventDefault());
  }

  // ── 초기화 ──────────────────────────────────────────────
  // 입력창을 폰 기본 키보드로 직접 편집한 경우 조합 상태를 버린다(우리 버퍼와 어긋나므로).
  const cmdEl = document.getElementById("cmd");
  if (cmdEl) {
    cmdEl.addEventListener("input", () => { comp = null; compBase = cmdEl.textContent; });
  }

  render();

  // 전송 후 입력창이 비워지는 등 외부 변화에 대비해 app.js 가 부를 수 있게 노출
  window.KB = {
    render, clearInput,
    commit: () => { commit(); paint(); },
    get layer() { return layer; },
    get shift() { return shiftLock ? "lock" : (shiftOn ? "on" : "off"); },
    get ctrl() { return ctrlLock ? "lock" : (ctrlOn ? "on" : "off"); },
    resetMods() { shiftOn = shiftLock = ctrlOn = ctrlLock = false; render(); },
  };
})();
