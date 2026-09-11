/* Virtual keyboard engine - rendering + 8-direction swipes + 2-beolsik Hangul composition.
   Layout data lives in kb-layout.js; this file is behavior only.

   -- Design notes -----------------------------------------------
   1) Character keys do not go straight to the pane; they pile up in the input box (#cmd).
      - a cli round trip (37-72ms) per character makes typing drag
      - showing a half-composed Hangul syllable needs a local buffer anyway
   2) Hangul composition finishes in the browser and only completed syllables leave.
      Unexpected Keyboard treats composition as a modifier, which makes key labels dance
      (the PR #595 design); here the composition state lives only in the input box,
      so labels never change.
   3) Function keys (Esc/Ctrl/arrows) hit /api/key at once. They hold no modifier state and
      send the control character itself, so "Ctrl stuck down" is structurally impossible.

   Uses app.js globals directly: state, post, needPane, refreshScreen, setStatus, sendInput, cmd.
*/
"use strict";

(function () {
  // -- 2-beolsik composition tables ------------------------
  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  // compound vowels / final clusters (first + second -> merged)
  const JUNG_COMBO = { "ㅗㅏ":"ㅘ","ㅗㅐ":"ㅙ","ㅗㅣ":"ㅚ","ㅜㅓ":"ㅝ","ㅜㅔ":"ㅞ","ㅜㅣ":"ㅟ","ㅡㅣ":"ㅢ" };
  const JONG_COMBO = { "ㄱㅅ":"ㄳ","ㄴㅈ":"ㄵ","ㄴㅎ":"ㄶ","ㄹㄱ":"ㄺ","ㄹㅁ":"ㄻ","ㄹㅂ":"ㄼ","ㄹㅅ":"ㄽ","ㄹㅌ":"ㄾ","ㄹㅍ":"ㄿ","ㄹㅎ":"ㅀ","ㅂㅅ":"ㅄ" };
  // splits (a vowel arrives and the final consonant moves to the next syllable, or backspace undoes it)
  const JONG_SPLIT = { "ㄳ":["ㄱ","ㅅ"],"ㄵ":["ㄴ","ㅈ"],"ㄶ":["ㄴ","ㅎ"],"ㄺ":["ㄹ","ㄱ"],"ㄻ":["ㄹ","ㅁ"],
                       "ㄼ":["ㄹ","ㅂ"],"ㄽ":["ㄹ","ㅅ"],"ㄾ":["ㄹ","ㅌ"],"ㄿ":["ㄹ","ㅍ"],"ㅀ":["ㄹ","ㅎ"],"ㅄ":["ㅂ","ㅅ"] };
  const JUNG_SPLIT = { "ㅘ":"ㅗ","ㅙ":"ㅗ","ㅚ":"ㅗ","ㅝ":"ㅜ","ㅞ":"ㅜ","ㅟ":"ㅜ","ㅢ":"ㅡ" };

  const isVowel = ch => JUNG.indexOf(ch) >= 0;
  const isJamo  = ch => isVowel(ch) || CHO.indexOf(ch) >= 0;

  // 2-beolsik shift means doubled consonants / wide vowels, not uppercase. Latin letters are not
  // in the table, so falling back to toUpperCase lets one function cover both layers
  // (toUpperCase is a no-op on Hangul).
  const KO_SHIFT = { "ㅂ":"ㅃ", "ㅈ":"ㅉ", "ㄷ":"ㄸ", "ㄱ":"ㄲ", "ㅅ":"ㅆ", "ㅐ":"ㅒ", "ㅔ":"ㅖ" };
  const shiftChar = ch => KO_SHIFT[ch] || ch.toUpperCase();

  // composition state { cho, jung, jong }, null when idle. It owns the last character of the input box.
  let comp = null;
  let compBase = "";   // committed text (everything before the composing character)

  function compChar(c) {
    if (!c) return "";
    if (c.cho && c.jung) {
      const ci = CHO.indexOf(c.cho), ji = JUNG.indexOf(c.jung), ki = c.jong ? JONG.indexOf(c.jong) : 0;
      if (ci >= 0 && ji >= 0 && ki >= 0) return String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + ki);
    }
    return (c.cho || "") + (c.jung || "") + (c.jong || "");
  }

  // Draw (committed text + composing character). The composing one is always the last character.
  function paint() {
    const el = document.getElementById("cmd");
    el.textContent = compBase + compChar(comp);
    el.scrollTop = el.scrollHeight;
  }

  // Finish composition and absorb it into the committed text
  // (called on layer switch, on latin input, and just before sending).
  function commit() {
    if (!comp) return;
    compBase += compChar(comp);
    comp = null;
  }

  // Resync the committed text with what the input box actually holds. It may have changed behind
  // our back (typed on the phone keyboard, for one), so check before every input.
  function syncBase() {
    const el = document.getElementById("cmd");
    const shown = compBase + compChar(comp);
    if (el.textContent !== shown) { comp = null; compBase = el.textContent; }
  }

  // Feed one jamo into the composer (standard 2-beolsik automaton)
  function feedJamo(ch) {
    if (!comp) { comp = isVowel(ch) ? { jung: ch } : { cho: ch }; return; }

    if (!isVowel(ch)) {                       // -- a consonant arrived
      if (comp.cho && comp.jung) {
        if (!comp.jong && JONG.indexOf(ch) > 0) { comp.jong = ch; return; }      // becomes the final
        if (comp.jong) {
          const merged = JONG_COMBO[comp.jong + ch];
          if (merged) { comp.jong = merged; return; }                            // final cluster
        }
      }
      commit(); comp = { cho: ch }; return;                                      // commit, start a new initial
    }

    // -- a vowel arrived
    if (comp.jong) {                          // the final moves to the next syllable as its initial
      const sp = JONG_SPLIT[comp.jong];
      const moved = sp ? sp[1] : comp.jong;
      comp.jong = sp ? sp[0] : null;
      commit();
      comp = { cho: moved, jung: ch };
      return;
    }
    if (comp.cho && !comp.jung) { comp.jung = ch; return; }                      // initial + medial
    if (comp.jung) {
      const merged = JUNG_COMBO[comp.jung + ch];
      if (merged) { comp.jung = merged; return; }                                // compound vowel
      commit(); comp = { jung: ch }; return;
    }
    comp = { jung: ch };
  }

  // Backspace: while composing, peel off one piece. Returns false when idle so the caller handles it.
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

  // -- input box ------------------------------------------
  // Every character piles up in the input box. The old "type through" mode that fired straight at
  // the terminal was removed: a cli round trip plus a mirror poll per character made typing stutter
  // (decided from real use, 2026-08-09).
  function insertText(s) {
    syncBase();
    if (isJamo(s)) { feedJamo(s); paint(); return; }    // Hangul goes through the composer
    commit();
    compBase += s;
    paint();
  }

  function doBackspace() {
    syncBase();
    if (backspaceComposing()) return;                   // while composing, peel a piece off first
    if (compBase.length > 0) { compBase = compBase.slice(0, -1); paint(); return; }
    sendKey("backspace");                               // input box empty -> delete on the terminal side
  }

  function clearInput() { comp = null; compBase = ""; paint(); }

  // -- sending to the terminal ----------------------------
  // Special keys leave the moment they are pressed. But fetch does not preserve completion order,
  // so fast repeats can arrive shuffled (left left up landing as up left left); every send rides
  // one promise chain to serialize them.
  let refreshTimer = null;
  let chain = Promise.resolve();

  function enqueue(fn) {
    chain = chain.then(fn).catch(e => setStatus(String(e), true));
    return chain;
  }
  // Refreshing the mirror on every action floods get-text -> refresh once after the last one.
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshScreen(true); }, 150);
  }

  function sendKey(name) {
    if (!needPane()) return;
    enqueue(async () => {
      const res = await post("/api/key", { pane: state.pane, key: name });
      if (!res.ok) setStatus(res.msg || "key failed", true);
    });
    scheduleRefresh();
  }

  function sendNow(text, submit) {
    if (!needPane()) return;
    enqueue(async () => {
      const res = await post("/api/send", { pane: state.pane, text: text, submit: !!submit });
      if (!res.ok) setStatus(res.msg || "send failed", true);
    });
    scheduleRefresh();
  }

  // Push the input box to the terminal. withEnter=false injects without pressing Enter -
  // for stacking several lines or triggering completion.
  function submitInput(withEnter) {
    syncBase(); commit(); paint();
    const text = compBase;
    if (text.length > 0) { clearInput(); sendNow(text, withEnter); return; }
    if (withEnter) sendKey("enter");      // input box empty -> just Enter (legacy behavior)
  }

  // -- running an action string ---------------------------
  function runAction(act) {
    if (!act) return;
    if (act.slice(0, 2) === "k:") {
      commit(); paint();
      // When Shift is on, apply it to special keys too (look up `shift` + key name).
      //   Shift used to affect only the character layers (doubled consonants, capitals), so it was
      //   effectively dead once those were removed. What a terminal really uses is Shift+Tab,
      //   Shift+arrows and Shift+Enter (newline) - those sequences are in `KEY_SEQ` in app.js.
      //   An unknown combo (`shiftesc` and the like) just sends the plain key.
      let key = act.slice(2);
      if (shiftOn) {
        if (window.hasKeySeq && window.hasKeySeq("shift" + key)) key = "shift" + key;
        afterChar();                     // a one-shot clears here (a lock stays)
      }
      sendKey(key);
      return;
    }
    if (act.slice(0, 2) !== "a:") {
      if (ctrlOn) { applyCtrl(act); return; }        // Ctrl on -> a combo key, not input box text
      insertText(shiftOn ? shiftChar(act) : act);
      afterChar();
      return;
    }

    const a = act.slice(2);
    if (a === "bs") { doBackspace(); return; }
    if (a === "shift") { toggleShift(); return; }
    if (a === "ctrl") { toggleCtrl(); return; }
    if (a === "move") { doMove(); return; }
    if (a === "put") { submitInput(false); return; }    // inject only - no Enter
    if (a === "enter") { submitInput(true); return; }   // inject + Enter

    // Alt layer - handled by the app, not the terminal (pane zoom/move, tab switch).
    // A PC catches these as `Alt+digit`/`Alt+arrow`; phones have no Alt key, so call them here.
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

  // Tab move: inject the input box without Enter, then Tab for shell completion
  // (inherited from the old #pad button). Injection and Tab ride the same chain, so order holds.
  function doMove() {
    if (!needPane()) return;
    submitInput(false);
    sendKey("tab");
  }

  // -- shift (one-shot / double-tap lock) -----------------
  let shiftOn = false, shiftLock = false, shiftTapAt = 0;
  function toggleShift() {
    const now = performance.now();
    const dbl = now - shiftTapAt < 400;
    shiftTapAt = now;
    // Unlocking comes first: placed later, a fast re-tap while locked would match the double-tap
    // test above and re-arm the lock instead of clearing it.
    if (shiftLock) { shiftLock = false; shiftOn = false; }
    else if (shiftOn && dbl) { shiftLock = true; }                    // two fast taps = lock
    else { shiftOn = !shiftOn; }
    render();
  }
  function afterChar() {
    if (shiftOn && !shiftLock) { shiftOn = false; render(); }         // one-shot clears
  }

  // -- ctrl - a real modifier (press it, and the next character becomes Ctrl+character)
  // Same 3-state cycle as shift: off -> one-shot -> (fast re-tap) lock -> off
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
  // 2-beolsik jamo -> the latin key at the same position. Mapping by key position reproduces the
  // PC feel, where pressing Ctrl plus the jamo sitting on the C key still gives Ctrl+C.
  const KO_TO_EN = {
    "ㅂ":"q","ㅈ":"w","ㄷ":"e","ㄱ":"r","ㅅ":"t","ㅛ":"y","ㅕ":"u","ㅑ":"i","ㅐ":"o","ㅔ":"p",
    "ㅁ":"a","ㄴ":"s","ㅇ":"d","ㄹ":"f","ㅎ":"g","ㅗ":"h","ㅓ":"j","ㅏ":"k","ㅣ":"l",
    "ㅋ":"z","ㅌ":"x","ㅊ":"c","ㅍ":"v","ㅠ":"b","ㅜ":"n","ㅡ":"m",
    "ㅃ":"q","ㅉ":"w","ㄸ":"e","ㄲ":"r","ㅆ":"t","ㅒ":"o","ㅖ":"p",
  };
  function applyCtrl(ch) {
    const en = (KO_TO_EN[ch] || ch).toLowerCase();
    if (/^[a-z]$/.test(en)) sendKey("ctrl" + en);
    else setStatus("no Ctrl+" + ch + " binding", true);
    if (!ctrlLock) { ctrlOn = false; render(); }                      // one-shot clears
  }

  // -- layers ---------------------------------------------
  // A stored value may name a layer that no longer exists ("ko"/"sym" from the character-row era),
  // so fix it up.
  let layer = localStorage.getItem("wt_kb_layer") || "en";
  if (!KB_LAYERS[layer]) layer = "en";
  let prevLetterLayer = layer === "sym" ? "en" : layer;
  function switchLayer(to) {
    commit(); paint();
    if (to === "toggle") to = layer === "ko" ? "en" : "ko";
    else if (to === "sym" && layer === "sym") to = prevLetterLayer;   // pressing ?123 again goes back
    if (to !== "sym") prevLetterLayer = to;
    shiftOn = false; shiftLock = false;      // moving layer resets the modifiers
    ctrlOn = false; ctrlLock = false;
    layer = to;
    localStorage.setItem("wt_kb_layer", layer);
    render();
  }

  // -- labels ---------------------------------------------
  const KEY_LABEL = {
    esc: "Esc", tab: "⇥", shifttab: "⇧⇥", enter: "⏎", space: "␣",
    backspace: "⌫", delete: "Del", up: "↑", down: "↓", left: "←", right: "→",
    home: "Hm", end: "End", pgup: "PgU", pgdn: "PgD",
  };
  function labelOf(act) {
    if (typeof act !== "string" || !act) return "";   // survive a number or the like leaking in
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
      if (a === "app:pastePC") return "PC";   // sub-label above the paste key - swipe for the PC clipboard
      return "";                       // layer/shift/send give their label directly through l
    }
    return shiftOn ? shiftChar(act) : act;
  }

  // -- rendering ------------------------------------------
  const DIRS = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
  const padEl = document.getElementById("pad");

  function keyEl(k) {
    const el = document.createElement("div");
    el.className = "kb-key" + (k.cls ? " " + k.cls : "");
    el.style.flexGrow = String(k.wd || 1);   // width is wd (w is taken by the west swipe)
    if (k.c === "a:shift") el.classList.add("modkey-shift");    // so the on state highlights just that key
    if (k.c === "a:ctrl") el.classList.add("modkey-ctrl");
    const main = document.createElement("span");
    main.className = "kb-main";
    main.textContent = k.l !== undefined ? k.l : labelOf(k.c);
    el.appendChild(main);
    // corner and up/down sub-labels (what the swipes produce)
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

    // top function row -> layer character rows -> shared bottom row
      // This used to be `|| KB_EN`. Removing the character layers deleted KB_EN, so a stored
    //   layer of "ko"/"sym" left `KB_LAYERS[layer]` undefined and threw a ReferenceError right
    //   here, killing the whole keyboard render (only the action bar survived).
    //   Fall back to an empty array - having no character layer is the normal state.
    const rows = KB_TOP.concat(KB_LAYERS[layer] || []).concat(KB_BOTTOM);
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = "kb-row";
      for (const k of row) r.appendChild(keyEl(k));
      padEl.appendChild(r);
    }
    // reflect the modifier state on the matching keys
    padEl.classList.toggle("shifted", shiftOn);
    padEl.classList.toggle("shift-lock", shiftLock);
    padEl.classList.toggle("ctrl-on", ctrlOn);
    padEl.classList.toggle("ctrl-lock", ctrlLock);
  }

  // -- gestures: tap vs 8-direction swipe -----------------
  const SWIPE_MIN = 22;    // move at least this far (px) to count as a swipe

  function dirOf(dx, dy) {
    // Screen y grows downward, so flip it before taking the angle (up = n)
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

  // Long press - came out of real-use feedback that diagonal swipes are hard to hit on a phone.
  // Put an action in a key's `lp` and it fires after this hold time (more reliable than a swipe).
  const LONG_MS = 420;

  function bindKey(el, k) {
    let sx = 0, sy = 0, active = false, lpTimer = 0, fired = false;
    const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };

    el.addEventListener("pointerdown", ev => {
      active = true; fired = false; sx = ev.clientX; sy = ev.clientY;
      el.classList.add("down");
      ev.preventDefault();          // keep focus and text selection away (so the phone keyboard stays down)
      if (!k.lp) return;
      clearLp();
      lpTimer = setTimeout(() => {
        lpTimer = 0;
        if (!active) return;
        fired = true;               // so releasing does not fire the tap action as well
        active = false;
        el.classList.remove("down");
        if (navigator.vibrate) navigator.vibrate(15);   // haptic confirmation that it fired
        runAction(k.lp);
      }, LONG_MS);
    });

    // A moving finger means a swipe, not a long press
    el.addEventListener("pointermove", ev => {
      if (!lpTimer) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) clearLp();
    });

    const finish = ev => {
      clearLp();
      if (fired || !active) return;   // already handled by the long press - ignore the tap
      active = false;
      el.classList.remove("down");
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let act = k.c;
      if (Math.hypot(dx, dy) >= SWIPE_MIN) {
        const d = dirOf(dx, dy);
        if (k[d]) act = k[d];       // an empty direction falls back to the tap action
      }
      runAction(act);
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", () => { clearLp(); active = false; el.classList.remove("down"); });
    el.addEventListener("contextmenu", ev => ev.preventDefault());
  }

  // -- init -----------------------------------------------
  // Drop the composition state if the input box was edited directly on the phone keyboard
  // (our buffer no longer matches it).
  const cmdEl = document.getElementById("cmd");
  if (cmdEl) {
    cmdEl.addEventListener("input", () => { comp = null; compBase = cmdEl.textContent; });
  }

  render();

  // Exposed for app.js to call on outside changes, such as the input box being cleared after a send
  window.KB = {
    render, clearInput,
    commit: () => { commit(); paint(); },
    get layer() { return layer; },
    get shift() { return shiftLock ? "lock" : (shiftOn ? "on" : "off"); },
    get ctrl() { return ctrlLock ? "lock" : (ctrlOn ? "on" : "off"); },
    resetMods() { shiftOn = shiftLock = ctrlOn = ctrlLock = false; render(); },
  };
})();
