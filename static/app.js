/* webterm frontend - xterm.js wired straight to a PTY over WebSocket.
   Visuals mirror .wezterm.lua (Powerline tab bar / Tokyo Night / JetBrains Mono Medium).

   Tab > pane model
   The server still knows only a flat session list. A session's `name` IS the tab
   name, and sessions sharing a name are the panes of that tab; splitting just
   creates another session with the same name. That keeps the daemon/server
   protocol untouched (restarting it would kill live shells) and every pane still
   owns an independent PTY, so it behaves like WezTerm.

   Size rule (important)
   xterm's cell count and the PTY's cell count MUST be identical. If they differ the
   app wraps at A columns while the screen lays out B, and glyphs overprint. So a
   client takes exactly one of two roles:
     - owner (PC default): applies its window size to xterm and demands it of the PTY
     - follower (phone default): demands nothing, draws at the PTY size (pans sideways)
*/
(() => {
  const $ = (s) => document.querySelector(s);
  // Start folder for new tabs. Empty means the server decides:
  //   config.json defaultCwd -> env WEBTERM_CWD -> user home.
  // Never hardcode a personal absolute path: it ships in the public repo and
  // silently falls back to home on anyone else's machine.
  let DEFAULT_CWD = "";

  // Same 16 colors as .wezterm.lua's built-in "Tokyo Night"
  // (checked against wezterm-src/docs/colorschemes/data.json).
  const THEME = {
    background: "#1a1b26", foreground: "#c0caf5",
    cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#283457",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
    brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  };
  // .wezterm.lua: JetBrains Mono weight="Medium", font_size=11 (about 14.7px), line_height=1.15
  let fontSize = +(localStorage.getItem("webterm.font") || 14.7);
  // Baseline that font.reset returns to; config.json fontSize overrides it at boot.
  let baseFont = 14.7;

  const isPhone = (() => {
    const f = /[?&]kb=([01])/.exec(location.search);
    return f ? f[1] === "1" : (matchMedia("(pointer: coarse)").matches && innerWidth < 900);
  })();
  // Is this a REMOTE browser? This is what decides where a paste comes from.
  // The PC path always reads `/api/clipboard` = the clipboard of the machine the
  // server runs on, so a remote browser pressing Ctrl+V would get the server's old
  // clipboard instead of its own. The real split is not "phone vs PC" but
  // "is the browser on the same machine as the server".
  // `?clip=pc|browser` forces it when the guess is wrong.
  const isRemote = (() => {
    const f = /[?&]clip=(pc|browser)/.exec(location.search);
    if (f) return f[1] === "browser";
    const h = location.hostname;
    return !(h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]");
  })();
  // "Fit to screen" is a STATE ("I am the size owner"), not a stored size value.
  // Freezing the size at click time broke foldables: folding/unfolding swings the
  // screen between ~475px and ~2048px while the frozen value stayed, cutting off the
  // statusline. So while `forced` is on, every size report carries force and refreshes
  // the value (see `resizePane`). Kept in localStorage so ownership survives a reload
  // or a reconnect.
  // Per-browser id - stable across reconnects so the server can tell it is the same
  // client (sent in the WS query).
  const CID = (() => {
    let v = localStorage.getItem("webterm.cid");
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("webterm.cid", v); }
    return v;
  })();
  // Restore the pin on phones only. A PC is the size owner by default, and a pinned PC
  // would both block the phone from taking over and stall the polling sync below,
  // leaving a permanent cell-count mismatch (the cause of overprinted screens).
  let forced = isPhone && localStorage.getItem("webterm.fit") === "1";
  // The PTY size is never pinned to a constant: PC or phone, folded or unfolded,
  // portrait or landscape, we demand whatever size the browser actually reports.
  // (Phones used to be follower-only, which drew an oversized PTY and clipped the
  // statusline.) Conflicts between two attached clients are settled by
  // "last one looking wins" plus the `forced` pin.
  // `?observe=1` = observe only: reports no size, so attaching a second browser for
  // debugging cannot shrink the screen the user is actually looking at.
  const APP_VER = 109;   // Bump together with index.html's ?v= on every static-file change.
  const OBSERVE = /[?&]observe=1/.test(location.search);
  // Merely attaching must not steal the size. Opening a second browser used to
  // squeeze the user's screen down to that window's size via "whoever is looking owns
  // it", and the `?observe=1` flag only helped when you remembered it. So the rule
  // itself changed:
  //   - right after connecting a client is an OBSERVER (draws at the PTY size)
  //   - it becomes the owner only once someone interacts (click / keypress)
  // Only the window a human looks at and touches decides the size, so opening several
  // windows is safe.
  let reportSize = false;
  const claimOwnership = () => {
    if (reportSize || OBSERVE) return;
    reportSize = true;
    scheduleResize();          // from now on, fit to my own screen
  };
  let typing = !isPhone;         // phones default to read mode (no soft keyboard)
  let togglePhoneKb = () => {};  // real implementation installed by the phone setup
  let setPhoneTyping = () => {}; // ditto (`setTyping`; used only to turn typing off)
  // A soft keyboard only covers the screen; it does not actually shrink the terminal.
  // Fitting to the squeezed height would push that size to the PTY and make TUIs
  // redraw on every keyboard open/close.
  let kbOpen = false;
  // Recomputes the usable height on phones (soft keyboard + key dock).
  // Real implementation is installed by the phone setup block.
  let applyViewport = () => {};
  // The input mode must be applied the moment a pane is created; applying it later
  // (via polling) lets a focus() on the way - a tab switch, say - pop up the Android
  // keyboard while we are still in read mode.
  // IME composition is a real state (jamo -> syllable). Touching the textarea or
  // redrawing mid-composition makes the IME drop it and leak partial jamo, so we
  // track composition and leave everything alone while it runs.
  let composing = false;
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => {
    composing = false;
    // flush any resize deferred during composition, else the size stays wrong
    if (typeof scheduleResize === "function") scheduleResize();
  }, true);

  const applyInputMode = (term) => {
    if (!isPhone || !term || !term.textarea) return;
    const ta = term.textarea;
    if (composing) return;                    // re-applying mid-composition cancels it
    // Assign only when the value actually differs: re-assigning the same value resets
    // the IME and breaks composition, and polling passes through here every 4s.
    if (ta.inputMode !== (typing ? "text" : "none")) ta.inputMode = typing ? "text" : "none";
    // In read mode focus must be impossible in the first place. inputMode="none",
    // guarding call sites and blur()-ing on focusin are all after-the-fact fixes, so
    // the keyboard still flashed on tab/pane switches. `disabled` stops Android from
    // raising it at all and costs nothing here: read mode needs no input and the
    // special keys go straight over the WebSocket (`readOnly` would kill input).
    if (ta.disabled === typing) ta.disabled = !typing;    // never re-assign the same value
  };
  // inputMode="none" is not enough: calling focus() inside a user-gesture handler
  // (a tab click) makes Android raise the keyboard anyway. So in read mode we simply
  // never hand out focus - the special keys do not need it.
  const focusTerm = (term) => {
    if (!term) return;
    applyInputMode(term);
    // Never grab focus while the window is in the background: ws.onopen calls this on
    // every reconnect (server restart, network drop, wake from sleep) and would steal
    // the cursor from whatever terminal the user is working in. A real pane click has
    // hasFocus() true, so normal use is unaffected.
    if (document.hidden || !document.hasFocus()) return;
    // On phones this function never focuses. Earlier guards only covered read mode,
    // but the failing path was typing mode left on: turn the keyboard on once, dismiss
    // it with the Android back button, and the app still believes typing=true - so the
    // next tab switch (focusPane -> focusTerm -> term.focus()) raised it again.
    // The single focus entry point on phones is now `setTyping(true)`; tab/pane
    // switches, reconnects and polling never focus.
    if (isPhone) return;
    if (typing) term.focus();
  };

  // Last line of defence: if the terminal textarea gains focus in read mode, undo it.
  // Patching call sites one by one kept missing new paths (xterm focuses internally
  // too), so guard the single point where focus lands - and log the stack so the real
  // source can be narrowed down.
  if (typeof window !== "undefined") {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains("xterm-helper-textarea")) return;
      if (typing) return;                       // focus is expected in typing mode
      t.blur();
      try {
        fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ev: "focus-blocked", typing,
                                 stack: String((new Error()).stack).slice(0, 400) }) });
      } catch (_) {}
    }, true);
  }

  // ---------- state ----------
  let sessions = [];              // every session the server knows
  let activeTab = null;           // current tab name
  let activeSid = null;           // current pane
  let zoomSid = null;             // zoomed pane (within the CURRENT tab)
  // Vertical session rail (PC only) - replaces the horizontal tab list and pane chips
  // when on. The toggle state is kept in the browser.
  let railOn = !isPhone && localStorage.getItem("webterm.rail") === "1";
  // Zoom is remembered per tab (tab name -> zoomed pane sid). With a single `zoomSid`
  // that `selectTab` cleared, leaving and returning to a tab dropped its zoom. Same
  // kind of state as `layouts` (per-tab split direction), so it is bound the same way.
  const zoomByTab = {};
  // The only way to change the zoom - it updates the per-tab memory too.
  // (Assigning `zoomSid` directly loses the value the moment you leave the tab.)
  const setZoom = (sid) => {
    zoomSid = sid || null;
    if (activeTab) zoomByTab[activeTab] = zoomSid;
  };
  // Pick the zoom that belongs to the current tab; drop it if that pane is gone.
  // `renderPanes` calls this every time, so no path that changes tabs (selectTab,
  // newTab, a tab vanishing during polling) can leave the zoom pointing at another
  // tab's pane. If it did, every pane of this tab would go `.dim`, and `.dim` counts
  // as `isOff`, which stops size negotiation entirely and freezes a broken screen.
  const syncZoom = () => {
    const z = zoomByTab[activeTab] || null;
    zoomSid = (z && tabPanes(activeTab).some(p => p.sid === z)) ? z : null;
    if (activeTab) zoomByTab[activeTab] = zoomSid;
  };
  // Set while a long-press text selection is in progress on a phone. Without it
  // `attachInertia` scrolls on the same touchmove, the absolute row under the finger
  // never changes, and the selection stays stuck on one line.
  let selecting = false;
  let pingAt = 0;
  const panes = new Map();        // sid -> { sid, el, host, term, fit, ws, retry, delay, attachedAt }
  const layouts = {};             // tab name -> "h" | "v" (split direction)

  // Expose app actions so the phone key bar (keyboard.js) can call them.
  // The Alt layer is not keys sent to the terminal but app-level actions (pane zoom,
  // pane move). A PC catches them in keydown; a phone has no Alt key, so the key bar
  // calls in here directly.
  window.__wt = { panes, get tab() { return activeTab; }, get sid() { return activeSid; },
                  get sessions() { return sessions; },
                  app: {
                    pane:   (d) => cyclePane(d),
                    zoom:   (n) => zoomPane(n - 1),          // the number shown on screen (1-based)
                    zoomCur: () => {
                      const ps = tabPanes(activeTab);
                      zoomPane(ps.findIndex(p => p.sid === activeSid));
                    },
                    unzoom: () => { setZoom(null); renderPanes(); },
                    tab:    (d) => cycleTab(d),
                    close:  () => { if (activeSid) closePane(activeSid); },
                    webgl:  () => toggleWebgl(),   // no context menu on phones, so the key bar calls it
                    kb:     () => togglePhoneKb(),  // soft-keyboard toggle (dock key)
                    // Paste - called by the dock's clipboard key. A PC catches Ctrl+V in
                    // keydown, but a phone has no character layer to build that chord, so
                    // this app action is the only entry point.
                    // `paste` = phone clipboard first, `pastePC` = PC clipboard first.
                    paste:   () => pasteClipboard(false),
                    pastePC: () => pasteClipboard(true),
                    // File upload - the dock's attach key. Uploads the picked file to the
                    // PC and pastes its PATH into the pane (claude reads a path it is given).
                    upload:  () => pickAndUpload(),
                    // Scrolling the view is NOT a key sent to the terminal: Up (ESC[A) means
                    // "previous history entry" to a shell or claude, and PgUp does nothing
                    // unless the app handles it. The scrollback belongs to xterm, so call it.
                    scroll: (d) => { const p = panes.get(activeSid); if (p) p.term.scrollPages(d); },
                    bottom: () => { const p = panes.get(activeSid); if (p) p.term.scrollToBottom(); },
                    font:   (d) => setFont(fontSize + d),
                  } };

  // One diagnostic line into the server log - asking a user to open the browser
  // console is a hassle.
  const diag = (obj) => {
    try {
      fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ ver: APP_VER }, obj)) });
    } catch (_) {}
  };

  // Short toast - a phone has neither a console nor a context menu, so borrow the tab
  // bar's latency slot (`#lag`) for 1.5s. The ping echo writes the same slot, so it is
  // held off for `lagHold` (see onmessage below).
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
    // Rename a tab through the per-tab API: the server checks duplicates and forbidden
    // characters and applies it to every pane at once (per-pane renames skip the check).
    renameTab: (name, next) => jpost(`/api/tabs/${encodeURIComponent(name)}/rename`, { name: next }),
  };

  // ---------- derived ----------
  const tabNames = () => [...new Set(sessions.map(s => s.name))];
  const tabPanes = (name) => sessions.filter(s => s.name === name);
  const sessOf = (sid) => sessions.find(s => s.sid === sid);

  // Renderer choice. The URL parameter wins over localStorage: if WebGL breaks the
  // screen you may not be able to reach the menu, so `?webgl=0` is the escape hatch.
  function useWebgl() {
    const m = /[?&]webgl=([01])/.exec(location.search);
    if (m) return m[1] === "1";
    return localStorage.getItem("webterm.webgl") === "1";
  }
  function toggleWebgl() {
    localStorage.setItem("webterm.webgl", useWebgl() ? "0" : "1");
    // Swapping renderers is most reliable via a fresh load; sessions live in the daemon
    // so a reload is harmless. Drop the ?webgl= parameter, else it overrides the store.
    location.href = location.pathname;
  }

  // ---------- pane names (manual is frozen, automatic follows) ----------
  // A name the user typed (Ctrl+P) is frozen; an unnamed pane keeps an automatic name
  // (number + process) that follows the current state. Freezing the automatic ones
  // brings back stale names.
  //
  // A session carries two names with different jobs:
  //   name  = the tab name AND the group key - sessions sharing it are one tab (Ctrl+T)
  //   label = the name of this one pane, no effect on the group (Ctrl+P)
  //
  // The daemon stores them (they used to live in localStorage, where the server, CLI
  // and shim could not see them, they did not match a phone on another origin, and
  // clearing browser data lost them). Now they live as long as the shell does.
  const paneLabel = (sid) => { const s = sessOf(sid); return (s && s.label) || ""; };

  // The tab bar's green "working" blink - detected explicitly from the claude spinner.
  //
  // claude Code rotates the FIRST character of the window title (OSC). It looks like
  // the spinner line in the screen body, but it is a different channel: we read the
  // title (`_scan_title` in session.py), which carries no elapsed time or token count.
  //
  //   U+2733 = idle, waiting for input.   Any other frame = working.
  //   Frames: U+25D0..25D3, U+2722, U+273B, U+273D, U+2736, U+25CF, "*", "."
  //
  // This used to be right by accident: the fallback when neither the idle glyph nor
  // "claude" was found was `busy`, and a working title happened to land on it - which
  // would break silently if claude changed its frames. Detection is now explicit and
  // the fallback dropped to `shell`, so a green blink means genuinely running.
  const SPIN_IDLE = "✳";                        // U+2733 - waiting for input
  const SPIN_BUSY = "◐◑◒◓✢✻✽✶●*·";              // rotating frames - working
  function spinState(title) {
    const t = (title || "").trim();
    if (!t) return "";
    if (t[0] === SPIN_IDLE) return "idle";
    // "*" and "." are frames too but also ordinary text, so only accept the
    // "<frame><space><summary>" shape
    if (SPIN_BUSY.indexOf(t[0]) >= 0 && /\s/.test(t[1] || "")) return "busy";
    return "";
  }

  // Process kind - derived from the window title the server read via OSC (the same
  // source as WezTerm's pane title).
  function kindOf(s) {
    const raw = (s && s.title) || "";
    const spin = spinState(raw);
    if (spin === "busy") return "busy";      // green blink - claude is running now
    if (spin === "idle") return "claude";    // amber - claude is up but idle
    const t = raw.toLowerCase();
    if (!t) return "shell";
    if (t.includes("claude")) return "claude";
    if (/\b(node|npm|npx|yarn|pnpm|vite)\b/.test(t)) return "node";
    if (/\bgit\b/.test(t)) return "git";
    if (/\b(vim|nvim|nano|code)\b/.test(t)) return "edit";
    if (/(powershell|pwsh|cmd\.exe|^ps )/.test(t)) return "shell";
    return "shell";
  }

  // ---------- tab bar ----------
  function renderTabs() {
    const box = $("#tabs");
    box.innerHTML = "";
    tabNames().forEach((name, i) => {
      const ps = tabPanes(name);
      const lead = ps.find(p => p.sid === activeSid) || ps[0];
      const el = document.createElement("div");
      el.className = "tab" + (name === activeTab ? " active" : "") +
                     (ps.some(p => p.alive) ? "" : " dead");
      el.title = `${name}\n${ps.length} panes\n${lead ? lead.cwd : ""}`;
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

  // Pane number chips on the right - same role as WezTerm's status-bar pane list.
  // Numbers follow SCREEN ORDER; numbering by pane_id gets tangled once panes are
  // closed and reopened.
  function renderChips() {
    // Single hook for the phone chip bar and drawer: both `renderTabs` (list refresh)
    // and `focusPane` (active change) end up here. It must stay ABOVE the
    // `ps.length < 2` early return - a one-pane tab still needs its chip bar drawn.
    if (isPhone) { renderPhoneNav(); if (!$("#drawer").hidden) renderDrawer(); }
    else if (railOn) renderRail();      // the PC rail uses the same hook (above the early return)
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
      // Only a named pane shows "N name". Hiding an existing name reads as "the feature
      // does not exist", while printing the automatic name (= the number) just eats width.
      const nm = paneLabel(p.sid);
      if (nm) {
        const s = document.createElement("span");
        s.className = "nm";
        s.textContent = nm;                 // never innerHTML - user-supplied string
        c.appendChild(s);
      }
      c.title = `pane ${i + 1}${nm ? ` - ${nm}` : ""} · Alt+${i + 1} fullscreen · Ctrl+P name`;
      c.onclick = () => focusPane(p.sid);
      box.appendChild(c);
    });
  }

  // ---------- vertical session rail (PC only) ----------
  // With ~10 sessions open a horizontal tab bar structurally cannot hold the names:
  // each tab costs 65px before any text (22 padding + 16 Powerline arrow + 27 for dot,
  // number and gap), so 10 tabs spend 650px first and flexbox then squeezes the rest
  // evenly - erasing even the name of the tab you are looking at. Turning the list on
  // its side fixes it: 190px fits name, pane count and the task title.
  //
  // Not used on phones - the chip bar (`renderPhoneNav`) plus drawer already do this,
  // and 190px out of a phone's width would leave the terminal unusable. The hook in
  // `renderChips` keeps the two mutually exclusive.

  // Strip the spinner glyph from the OSC window title and keep the task summary.
  // The dot color already says idle vs working, so do not repeat it in text.
  const railDesc = (s) => {
    const t = ((s && s.title) || "").trim();
    return spinState(t) ? t.slice(1).trim() : t;
  };

  function renderRail() {
    const box = $("#rail");
    if (!box || box.hidden) return;
    // The 4s poll calls this again; a full redraw would snap the scroll back to the top.
    const keep = box.scrollTop;
    box.innerHTML = "";

    // Header line - with ten sessions open, what you want to know is how many are
    // waiting for input.
    const wait = sessions.filter(s => spinState(s.title) === "idle").length;
    const busy = sessions.filter(s => spinState(s.title) === "busy").length;
    const head = document.createElement("div");
    head.className = "rl-head";
    head.innerHTML = `${sessions.length} sessions` +
                     (wait ? ` · <span class="wait">${wait} waiting</span>` : "") +
                     (busy ? ` · ${busy} busy` : "");
    box.appendChild(head);

    tabNames().forEach((name, ti) => {
      const ps = tabPanes(name);
      const isActive = name === activeTab;
      const lead = (isActive && ps.find(p => p.sid === activeSid)) || ps[0];
      const expand = isActive && ps.length > 1;      // only the visible tab expands its panes

      const t = document.createElement("div");
      t.className = "rl-tab" + (isActive ? " on" : "") + (ps.some(p => p.alive) ? "" : " dead");
      const l1 = document.createElement("div");
      l1.className = "l1";
      l1.innerHTML = `<span class="dot ${kindOf(lead)}"></span>` +
                     // Same number as Ctrl+1..9. From the tenth on there is no shortcut, so
                     // mark it explicitly - a blank would read as a render failure.
                     `<span class="num">${ti < 9 ? ti + 1 : "·"}</span>` +
                     `<span class="nm"></span>` +
                     (ps.length > 1 ? `<span class="cnt">▦${ps.length}</span>` : "");
      l1.querySelector(".nm").textContent = name;    // never innerHTML - user-supplied name
      t.appendChild(l1);
      const desc = railDesc(lead);
      // an expanded tab already shows a title on each pane row below
      if (desc && !expand) {
        const d = document.createElement("div");
        d.className = "desc";
        d.textContent = desc;                        // textContent, same reason
        t.appendChild(d);
      }
      t.title = `${name}${ps.length > 1 ? ` · ${ps.length} panes` : ""}` +
                (desc ? `\n${desc}` : "") +
                (lead && lead.cwd ? `\n${lead.cwd}` : "") +
                (ti < 9 ? `\nCtrl+${ti + 1}` : "\n(no Ctrl number past the 9th - click to switch)");
      t.onclick = () => selectTab(name);
      t.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(name); } };
      t.ondblclick = () => renameTab(name);
      t.oncontextmenu = (e) => { e.preventDefault(); openMenu(e, name, lead && lead.sid); };
      box.appendChild(t);

      if (!expand) return;
      ps.forEach((p, i) => {
        const nm = paneLabel(p.sid), pd = railDesc(p);
        const r = document.createElement("div");
        // `hassub` = a row carrying BOTH a name and a title. Capping the width on a
        // title-only row would truncate it with space left over (the CSS `max-width:58%`
        // is only needed for this case).
        r.className = "rl-pane" + (p.sid === activeSid ? " on" : "") +
                      (p.sid === zoomSid ? " zoomed" : "") + (p.alive ? "" : " dead") +
                      (nm && pd ? " hassub" : "");
        r.innerHTML = `<span class="dot ${kindOf(p)}"></span><span class="num">${i + 1}</span>` +
                      `<span class="nm"></span><span class="sub"></span>`;
        // named pane: name + dimmed title; automatic pane: title only (else the number)
        r.querySelector(".nm").textContent = nm || pd || `pane ${i + 1}`;
        r.querySelector(".sub").textContent = nm && pd ? pd : "";
        r.title = `pane ${i + 1}${nm ? ` - ${nm}` : ""}${pd ? `\n${pd}` : ""}` +
                  `\nAlt+${i + 1} fullscreen · Ctrl+P name`;
        r.onclick = () => focusPane(p.sid);
        r.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closePane(p.sid); } };
        r.oncontextmenu = (e) => { e.preventDefault(); openMenu(e, name, p.sid); };
        box.appendChild(r);
      });
    });
    box.scrollTop = keep;
  }

  // Toggle the rail. The width change makes `ResizeObserver(#panes)` drive the PTY
  // re-report through `scheduleResize`'s 400ms debounce - no size math needed here.
  const setRail = (on) => {
    if (isPhone) return;                     // phones use the chip bar + drawer instead
    railOn = !!on;
    localStorage.setItem("webterm.rail", railOn ? "1" : "0");
    document.body.classList.toggle("rail", railOn);
    $("#rail").hidden = !railOn;
    // the rail IS the tab list - showing the same thing twice only eats width
    $("#tabs").hidden = railOn;
    $("#panechips").hidden = railOn;
    if (railOn) renderRail();
    scheduleResize();
  };

  // ---------- phone navigation (big chip bar + full-list drawer) ----------
  // The PC Powerline tab bar is smaller than a fingertip on a phone, so the header is
  // replaced by [menu] [tab chip, pane chips | tab chip ...]. A tab chip jumps to that
  // tab and a pane chip to that pane in one tap - no drill-down.

  // If the pane is in another tab, switch tabs first, then pick it. A phone shows one
  // pane at a time, so `focusPane` also runs `renderPanes` (see its comments).
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
      tab.querySelector(".t").textContent = name;      // never innerHTML - user-supplied string
      tab.onclick = () => selectTab(name);
      box.appendChild(tab);
      // Only the tab being viewed expands its pane chips. Expanding all of them lets a
      // five-pane tab eat the whole bar and push the other tabs off screen, which is
      // worse at phone width. A collapsed tab just shows its pane count.
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
    // Center the active chip horizontally. `scrollIntoView` can move the whole page, so
    // adjust the bar's own `scrollLeft` instead.
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
                    (ps.length > 1 ? `<span class="cnt">${ps.length} panes</span>` : "");
      h.querySelector(".t").textContent = name;
      h.onclick = () => { selectTab(name); closeDrawer(); };
      list.appendChild(h);
      ps.forEach((p, i) => {
        const r = document.createElement("div");
        r.className = "dw-pane" + (p.sid === activeSid ? " on" : "") + (p.alive ? "" : " dead");
        r.innerHTML = `<span class="dot ${kindOf(p)}"></span><span class="num">${i + 1}</span>` +
                      `<span class="nm"></span><span class="cwd"></span>`;
        r.querySelector(".nm").textContent = paneLabel(p.sid) || `pane ${i + 1}`;
        r.querySelector(".cwd").textContent = (p.cwd || "").split(/[\\/]/).pop() || "";
        r.onclick = () => { goPane(name, p.sid); closeDrawer(); };
        list.appendChild(r);
      });
    });
  }

  // Closable with the Android back button. If back cannot dismiss a full-screen
  // overlay it exits the whole PWA instead - the most common phone accident. So push
  // one history entry on open and pop it on close.
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
  addEventListener("popstate", () => {          // arrived via back - a no-op if already closed
    if (!$("#drawer").hidden) { dwPushed = false; $("#drawer").hidden = true; }
  });

  // ---------- phone inertial scrolling ----------
  // xterm's viewport does not hand touch scrolling to the browser properly: flicks get
  // no inertia and move line by line (WebGL did not help, so it is not a render-cost
  // problem). wezterm-web solved this by dropping xterm entirely (ansi_up + plain divs),
  // which webterm cannot do because it is wired straight to a PTY - so roll our own.
  //
  // How: block the default touch scroll (`passive:false` + preventDefault) and drive
  // `scrollTop` ourselves; on release run a decay loop from the last velocity. xterm
  // redraws on its own from the scroll event.
  function attachInertia(paneEl) {
    const vp = paneEl.querySelector(".xterm-viewport");
    if (!vp || vp.dataset.inertia) return;
    vp.dataset.inertia = "1";
    // `touch-action` beats `preventDefault`. The CSS used to say `pan-y`, which RESERVES
    // vertical panning for the browser: it then starts a compositor scroll, ignores our
    // preventDefault and kills the in-flight touch with `touchcancel`, so a long-press
    // selection died while the screen scrolled anyway. The custom inertia below owns
    // scrolling entirely, so there is nothing to leave to the browser.
    // Done here rather than in CSS so that only viewports that actually got inertia are
    // set to `none` - otherwise a viewport we failed to attach to loses all scrolling.
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
      // Give up scrolling while selecting: both read the same touchmove, and if this one
      // does not back off the screen follows the finger and the selection stays on one line.
      if (selecting) { vel = 0; e.preventDefault(); return; }
      const now = performance.now();
      const dy = lastY - t.clientY;
      const dt = Math.max(1, now - lastT);
      vp.scrollTop += dy;
      // convert to px/frame (16ms) and blend with the previous velocity to damp spikes
      vel = vel * 0.3 + (dy / dt) * 16 * 0.7;
      lastY = t.clientY; lastT = now;
      e.preventDefault();          // stops the default scroll doubling our movement
    }, { passive: false });

    vp.addEventListener("touchend", () => {
      if (selecting) { vel = 0; return; }      // never add inertia to a selection gesture
      if (Math.abs(vel) < 0.6) return;
      const step = () => {
        vp.scrollTop += vel;
        vel *= 0.94;                                   // decay factor - higher slides further
        const atEdge = vp.scrollTop <= 0 ||
                       vp.scrollTop >= vp.scrollHeight - vp.clientHeight - 1;
        if (Math.abs(vel) < 0.4 || atEdge) { raf = 0; return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, { passive: true });
  }

  // ---------- pane layout ----------
  function renderPanes() {
    const wrap = $("#panes");
    syncZoom();          // pick this tab's zoom (switch tabs -> its zoom; closed pane -> none)

    // Losing focus during a render feels like the terminal going dead mid-typing (the
    // 4s poll calls this). So leave the DOM alone when positions already match, and
    // restore terminal focus at the end.
    const hadFocus = document.activeElement && document.activeElement.closest("#panes");

    // Only reap dead sessions. Switching tabs never destroys a pane: that would force a
    // WS reconnect plus a 2MB backlog replay and make switching slow.
    const alive = new Set(sessions.map(x => x.sid));
    for (const [sid] of [...panes]) if (!alive.has(sid)) destroyPane(sid);

    // Create missing panes for the active tab (other tabs keep only what exists).
    tabPanes(activeTab).forEach(s2 => { if (!panes.has(s2.sid)) createPane(s2.sid); });

    // One grid group per tab - see the `.tabgroup` comment in app.css for why.
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
      // on a phone a split still shows one pane at a time (both halves would be unusable)
      const zoom = isActive ? (zoomSid || (isPhone && n > 1 ? activeSid : null)) : null;
      const dir = layouts[name] || "h";

      // The grid keeps its split shape even while zoomed. Collapsing to 1x1 was only
      // correct back when the other panes were removed with `display:none`; they now stay
      // in the layout, so 1x1 would blow all three up to full width and they would shrink
      // again on unzoom, breaking scroll and rendering. Zoom is just `.pane.zoom` covering
      // the rest via `grid-area:1/1/-1/-1` (pane backgrounds are opaque), and the others
      // keep their own cell size.
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
        if (isPhone) attachInertia(p.el);   // the viewport may not exist right after open()
        // named -> "1 name", otherwise just the number (::before content:attr(data-idx))
        const nm = paneLabel(p.sid);
        const idxLabel = nm ? `${i + 1} ${nm}` : String(i + 1);
        if (p.el.dataset.idx !== idxLabel) p.el.dataset.idx = idxLabel;
        if (g.children[i] !== p.el) g.insertBefore(p.el, g.children[i] || null);
        p.el.classList.toggle("zoom", !!zoom && p.sid === zoom);
        p.el.classList.toggle("dim", !!zoom && p.sid !== zoom);   // covered while zoomed
        p.el.classList.toggle("active", p.sid === activeSid);
      });
    }

    // drop empty groups (tab is gone)
    for (const [name, g] of groups) if (!used.has(name)) g.remove();

    // restore terminal focus (see the hadFocus comment above)
    if (hadFocus) { const p = panes.get(activeSid); if (p) focusTerm(p.term); }
    scheduleResize();   // re-measure after render, debounced so it cannot feed back into polling
  }

  function createPane(sid) {
    const p2 = {};                         // box so late callbacks can reach this pane
    const el = document.createElement("div");
    el.className = "pane";
    const host = document.createElement("div");
    host.className = "host";
    el.appendChild(host);
    el.onmousedown = () => focusPane(sid);
    // once the user scrolls or types, stop all automatic scroll correction for that pane
    const markScrolled = () => {
      if (p.replaying) return;         // scrolling is meaningless during replay (see above)
      p.userScrolled = true;
      clearTimeout(p.settleT);
    };
    el.addEventListener("wheel", markScrolled, { passive: true });
    el.addEventListener("touchstart", markScrolled, { passive: true });
    el.addEventListener("keydown", markScrolled);
    // Not used on phones: Android Chrome fires `contextmenu` on a long press at ~500ms,
    // which collides with our 450ms selection gesture and triggers both at once. On a
    // phone the menu opens on "long press, do not drag, release" (touch gesture block).
    el.oncontextmenu = (e) => { e.preventDefault(); if (isPhone) return; openMenu(e, activeTab, sid); };
    // Double click = toggle full screen for this pane (the mouse version of Alt+N, as in
    // WezTerm). The trade-off is xterm's default word selection, exactly the trade WezTerm
    // makes too; drag-select with auto-copy still works, so no copy path is lost.
    // xterm has already grabbed the word by then, so clear the selection before zooming.
    el.ondblclick = () => {
      // Skipped on phones: the browser synthesizes `dblclick` from a double tap, so this
      // zoom toggle fired together with "double tap = typing toggle". Pane zoom on a phone
      // lives in the dock's Alt layer (`zoom`), so nothing is lost.
      if (isPhone) return;
      const ps = tabPanes(activeTab);
      const i = ps.findIndex((x) => x.sid === sid);
      if (i < 0) return;
      try { term.clearSelection(); } catch (e) {}
      zoomPane(i);
    };

    const term = new Terminal({
      theme: THEME,
      // Naming a font does not mean it is used: JetBrains Mono ships inside WezTerm and is
      // usually absent from the system, where this used to fall back to Consolas silently
      // (measured cell width 8.084 = Consolas).
      // Sarasa FIXED, not Mono: Mono draws ambiguous-width characters full width and they
      // spill into the neighbouring cell.
      // Emoji always fall back anyway, so name the system emoji font explicitly to keep it
      // consistent (WezTerm uses Noto Color Emoji; the browser gets Windows' Segoe UI Emoji).
      // Order is the division of labour - a missing glyph falls through to the next font:
      //   latin and symbols -> JetBrains Mono (the font WezTerm uses)
      //   CJK and ambiguous -> Sarasa Fixed K (exact width, ambiguous drawn half width)
      //   emoji             -> Segoe UI Emoji
      // The resulting width ratio matches WezTerm: cell / CJK / double = 83% either way.
      fontFamily: '"JetBrains Mono","Sarasa Fixed K","Segoe UI Emoji","Consolas",ui-monospace,monospace',
      fontSize,
      // 500 (Medium) matches .wezterm.lua's weight="Medium". JetBrains Mono really ships a
      // 500 file, so nothing is synthesized; Sarasa only has 300/400/700, and asking it for
      // 500 would make the browser fake the weight and smear the strokes.
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1.15,           // line_height from .wezterm.lua
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      // Let xterm draw box-drawing (U+2500..257F) and block characters itself instead of
      // using the font. Measured: 143 "=" fit on one line but 143 U+2500 overflowed, i.e.
      // the glyph is drawn ~1.1 cells wide. U+2500 is East Asian Ambiguous and is missing
      // from every font in the stack (the sarasa-fixed-k.css subsets have no U+2500 range),
      // so a fallback font drew it at its own width and claude's separators got clipped.
      // Only effective on the canvas/WebGL renderer - the DOM renderer draws with the font -
      // which is why whether WebGL actually attached matters (see attachWebgl below).
      customGlyphs: true,
      windowsPty: { backend: "conpty" },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(host);
    // WebGL renderer - draws the canvas at dpr resolution, so it is sharper on scaled
    // displays. The default DOM renderer positions glyphs in CSS px, so at a fractional
    // dpr like 1.5 the cell width (8.084px) misses physical pixel boundaries and blurs.
    // It is off by default because of an old bug where the whole picture was drawn
    // shifted (buffer fine, rendering skewed), and there are always ways back out:
    // the context menu toggle, `?webgl=0`, localStorage.
    //
    // WebGL is attached only AFTER the web fonts are loaded. The WebGL renderer bakes
    // glyphs into a texture atlas, and if the fonts are not there yet the FALLBACK glyphs
    // get baked in permanently - it never re-bakes when the font arrives, so it keeps
    // drawing at the fallback width (8.0px measured vs 8.82px for JetBrains Mono) and
    // claude's separators come out narrow with a gap on the right. The DOM renderer is
    // immune because the browser redraws every time. It also explains two panes on the
    // same page rendering at different widths: only the first was created pre-font.
    if (useWebgl()) {
      const attachWebgl = () => {
        try {
          const g = new WebglAddon.WebglAddon();
          // On context loss, drop WebGL and fall back to the DOM renderer. `dispose()`
          // restores the renderer and calls handleResize (see vendor/addon-webgl.js), but
          // the already-drawn screen does not come back, so force a full redraw too.
          // Do not re-attach: whatever caused the loss would just cause it again.
          g.onContextLoss(() => {
            try { g.dispose(); } catch (_) {}
            const q = p2.ref;
            if (q) { q.webgl = null; redraw(q); }
            diag({ ev: "webgl-context-lost", sid: sid.slice(0, 8) });
          });
          term.loadAddon(g);
          // Keep the addon on the pane so the atlas can be cleared later. This callback
          // runs after the fonts load, so the pane may already exist (`p2.ref`) or not yet
          // (park it in the box and move it below).
          if (p2.ref) p2.ref.webgl = g; else p2.webgl = g;
          // Log whether it attached, so "WebGL is on, why is nothing different" is not guesswork.
          diag({ ev: "webgl", ok: true, sid: sid.slice(0, 8),
                 fontsStatus: document.fonts ? document.fonts.status : "?" });
        } catch (e) {
          console.warn("webgl unsupported", e);
          diag({ ev: "webgl", ok: false, sid: sid.slice(0, 8), err: String(e).slice(0, 120) });
        }
      };
      // `document.fonts.status` cannot be trusted: subset web fonts (`unicode-range`) load
      // when their characters first appear, so early on there is nothing to load and the
      // status reads "loaded". Attaching WebGL then still bakes fallback glyphs for fonts
      // not used yet, which is why `fonts.ready` alone was not enough. Load the characters
      // we need explicitly first - including the box-drawing ones, which is the key part.
      const need = [
        ['500 ' + fontSize + 'px "JetBrains Mono"', 'M─│┌┐└┘├┤┬┴┼'],
        ['400 ' + fontSize + 'px "Sarasa Fixed K"', '가─│①←'],
      ];
      const warm = Promise.all(need.map(([f, t]) => {
        try { return document.fonts.load(f, t).catch(() => null); } catch (_) { return null; }
      }));
      Promise.race([warm, new Promise((r) => setTimeout(r, 1500))])   // proceed after 1.5s regardless
        .then(() => setTimeout(attachWebgl, 20));
    }
    applyInputMode(term);          // right at creation - must run before any focus()
    if (isPhone) attachInertia(el);

    const p = { sid, el, host, term, fit, ws: null, retry: null, delay: 500, attachedAt: 0 };
    p2.ref = p;                            // lets a late attachWebgl find this pane
    if (p2.webgl) p.webgl = p2.webgl;      // move over what was parked in the box
    panes.set(sid, p);

    // xterm auto-answers ConPTY's DA query and the reply echoes into the shell prompt as
    // `[?1;2c`. Drop those auto-replies, but only right after attaching.
    const AUTO_REPLY = /^\x1b\[\??[0-9;]*[cnR]$/;
    term.onData(d => {
      if (performance.now() - p.attachedAt < 1500 && AUTO_REPLY.test(d)) return;
      wsend(p, { t: "i", d });
    });
    // Paste takes different paths for text and images.
    // Intercepting Ctrl+V wholesale and sending 0x16 worked in PowerShell (PSReadLine binds
    // that key to Paste) but killed pasting in claude's input box: claude reads text as a
    // bracketed paste (ESC[200~ ... ESC[201~), and intercepting the key means the browser
    // paste event never fires, cutting that path.
    //
    // So they are split:
    //   - text  -> do nothing; xterm's default paste sends a bracketed paste.
    //   - image -> a web page cannot stream image bytes into a terminal, so send only 0x16
    //     (Ctrl+V) and let claude read the OS clipboard itself, producing `[Image #N]`.
    //     claude runs on this same PC, so the clipboard matches. Phones are the exception:
    //     the PC cannot read a phone's clipboard.
    host.addEventListener("paste", (e) => {
      if (isPhone) return;
      const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
      const hasImage = items.some((it) => it.type && it.type.indexOf("image/") === 0);
      const hasText = items.some((it) => it.kind === "string");
      if (!hasImage || hasText) return;          // with text present, xterm's default path is right
      e.preventDefault();
      e.stopPropagation();
      // Remotely, 0x16 makes claude read the SERVER's clipboard and paste the wrong image.
      // Upload the image the browser holds and paste its path instead (same trick as the
      // phone upload path).
      if (isRemote) {
        const f = items.map((it) => it.getAsFile && it.getAsFile()).filter(Boolean);
        if (f.length) uploadFiles(f, p);
        return;
      }
      wsend(p, { t: "i", d: "\x16" });
    }, true);
    // Drag-select copies to the clipboard immediately, like WezTerm's
    // CompleteSelection("ClipboardAndPrimarySelection").
    // Copy on `mouseup`, not `onSelectionChange`, because (1) that writes the clipboard once
    // at the end instead of on every pixel of the drag, and (2) writeText is only allowed
    // inside a user gesture - mouseup is one, an onSelectionChange callback may not be.
    host.addEventListener("mouseup", () => {
      const sel = term.getSelection();
      if (!sel || !sel.trim()) return;          // a plain click that cleared the selection
      copyToClipboard(sel);
    });
    // app shortcuts must not leak into the terminal (see the isAppKey comment)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Shift+Enter = newline (next line, do not submit).
      // The terminal protocol has no "Shift+Enter" signal; xterm ignores Shift and sends
      // CR. That is why claude installs a key binding for iTerm2 and VSCode
      // (isShiftEnterKeyBindingInstalled). Our terminal is not on that list, so send
      // claude's documented alternative instead: ctrl+j, i.e. line feed 0x0A - the same
      // byte the phone dock's newline key sends (KEY_SEQ.shiftenter).
      // Ctrl+V - same approach as WezTerm: an image is saved as PNG and its path pasted.
      // Two earlier attempts failed. Leaving it alone makes xterm send 0x16 (SYN) per the
      // terminal standard, which PowerShell pastes (PSReadLine) but claude interprets as
      // chat:imagePaste, so text never arrived. Switching to the browser clipboard
      // (navigator.clipboard.readText) fixed text but not images: a web page cannot stream
      // image bytes into a terminal, and claude reading the clipboard itself did not work
      // inside the webterm PTY.
      //
      // WezTerm had already solved it: its Ctrl+V handler runs the bundled
      // scripts/clipboard_paste.ps1, which saves an image to %TEMP% as PNG and pastes the
      // path (text is pasted as text); claude reads a path it is given. webterm runs the
      // same script on the server (`/api/clipboard`) and pastes the result.
      //
      // Phones are the exception - that script reads the PC clipboard, unrelated to what
      // was copied on the phone, so phones use the browser clipboard (text).
      // More generally the server clipboard is only correct when the browser and the server
      // are the same machine; remote clients read the browser clipboard. Ctrl+Shift+V
      // flips the source, to paste the SERVER's clipboard from a remote client.
      if ((e.key === "v" || e.key === "V") && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const browserClip = isPhone || isRemote;         // does this client default to the browser?
        const wantPc = e.shiftKey ? browserClip : !browserClip;   // Shift flips the source
        if (wantPc) {
          fetch("/api/clipboard")
            .then((r) => r.json())
            .then((j) => { if (j && j.ok) pasteText(p, j.text); })
            .catch(() => {
              // if the server path is blocked, fall back to the browser clipboard (text only)
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
        return false;                      // keep xterm from appending the submit (CR)
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
    // `cid` = per-browser id; the server decides size ownership from it.
    // Ownership must not be tied to the socket: a phone reconnects whenever the screen
    // turns off or the app is switched (that is the detach/attach churn in the log), and
    // losing ownership each time would snap the size back to the PC's.
    const ws = new WebSocket(`${proto}://${location.host}/ws/${p.sid}?cid=${encodeURIComponent(CID)}`);
    p.ws = ws;
    ws.onopen = () => {
      p.attachedAt = performance.now();
      // Clear only AFTER attaching; the backlog replay on attach is the single source of
      // restoration. Clearing on entry to `connect()` left the screen blank for as long as
      // the connection failed (phone waking from sleep, tunnel not up yet): the screen was
      // wiped but no backlog arrived, and not even a reload brought the text back.
      // Clearing after attach keeps the old screen readable while disconnected, and
      // `#offline` reports the state.
      p.term.reset();
      p.replaying = true;              // backlog incoming - stay pinned to the bottom until it ends
      p.userScrolled = false;
      p.delay = 500;
      $("#offline").hidden = true;
      resizePane(p);
      if (p.sid === activeSid) focusTerm(p.term);   // no focus in read mode
    };
    ws.onmessage = (ev) => {
      if (ev.data === "") {                       // ping echo = latency measurement
        const ms = performance.now() - pingAt, lag = $("#lag");
        if (performance.now() < lagHold) return;  // `flash()` is borrowing the same slot
        if (ms > 50) { lag.hidden = false; lag.textContent = ms.toFixed(0) + "ms"; }
        else lag.hidden = true;
        return;
      }
      p.term.write(ev.data);
      // Stay pinned to the bottom while the backlog replays.
      // Opening a tab creates the pane, attaches the WS and replays up to 2MB of backlog.
      // The buffer grows the whole time, so "scroll position" is not a meaningful concept
      // yet: scrolling mid-replay gets dragged to the very top by the growing buffer.
      // Stopping correction as soon as the user scrolled only trapped them at the top -
      // the right answer is to wait until the replay ends and then hand over control.
      // A replay normally finishes within a second (250ms of silence counts as done).
      // Also cap the replay state in time: a session that keeps printing (claude working)
      // never goes quiet for 250ms, so `replaying` would never clear and the user could
      // not scroll up at all. 3s is plenty, after which xterm's own behaviour takes over
      // (follow the bottom if you are at the bottom, hold position if you scrolled up).
      if (p.replaying && performance.now() - p.attachedAt > 3000) p.replaying = false;
      if (p.replaying) {
        p.term.scrollToBottom();
        clearTimeout(p.settleT);
        p.settleT = setTimeout(() => {
          p.replaying = false;                 // from here on the scroll belongs to the user
          p.term.scrollToBottom();
        }, 250);
      }
    };
    ws.onclose = (ev) => {
      p.closedAt = performance.now();          // the watchdog (`healPanes` step 2) times this
      if (p.sid === activeSid) $("#offline").hidden = false;
      // 4000/4004 = deliberate close by the server (session ended / unknown) - do not retry
      if (ev && (ev.code === 4000 || ev.code === 4004)) { refresh(); return; }
      p.retry = setTimeout(() => connect(p), p.delay);
      p.delay = Math.min(p.delay * 1.6, 5000);    // exponential backoff
    };
    ws.onerror = () => { if (p.sid === activeSid) $("#offline").hidden = false; };
  }

  // Sending a paste - the bracketed-paste markers are mandatory.
  // claude only treats text wrapped in ESC[200~ ... ESC[201~ as a paste, which is what
  // turns an image path into `[Image #N]` and keeps multi-line text as one chunk.
  //
  // xterm's `term.paste()` decides from the mode IT knows about, learned when the app
  // enables it (ESC[?2004h). webterm resets and replays the backlog on every reconnect,
  // so an old session whose enable sequence has scrolled out of the 2MB ring buffer never
  // learns the mode - two panes of the same tab were measured with bracketedPaste false
  // and true, and the false one printed the image path as plain text.
  // So when the mode is unknown we wrap it ourselves; PSReadLine understands the markers too.
  const pasteText = (p, text) => {
    if (!p || !text) return;
    const bp = p.term.modes && p.term.modes.bracketedPasteMode;
    if (bp) p.term.paste(text);                       // mode known - let xterm handle it
    else wsend(p, { t: "i", d: "\x1b[200~" + text + "\x1b[201~" });
  };

  // Clipboard -> current pane. There are two sources, so the priority is a parameter.
  //   - phone clipboard = navigator.clipboard.readText(), allowed only inside a user
  //     gesture (Android Chrome also shows a paste confirmation chip). A dock key tap is
  //     a gesture; a timer or automatic call is not.
  //   - PC clipboard = the server's /api/clipboard running scripts/clipboard_paste.ps1,
  //     the same script WezTerm's Ctrl+V uses: an image is saved to %TEMP% as PNG and its
  //     path returned, which claude reads. It is the only way to reach a screenshot taken
  //     on the PC from a phone.
  // Pasting always goes through `pasteText`, which owns the bracketed-paste wrapping.
  const readPhoneClip = () => (navigator.clipboard && navigator.clipboard.readText)
    ? navigator.clipboard.readText()
    : Promise.reject(new Error("browser clipboard unsupported"));
  const readPcClip = () => fetch("/api/clipboard").then(r => r.json()).then((j) => {
    if (!j || !j.ok) throw new Error((j && j.error) || "PC clipboard failed");
    return j.text;
  });

  // File upload (phone -> PC), same trick as paste: the server stores the file and we
  // paste only its PATH (a web page cannot stream bytes into a terminal).
  // `<input type="file">.click()` opens only inside a user gesture - a dock key tap works,
  // reopening it automatically after an upload does not. The input is created once and
  // reused; creating a new one each time can leave a stale picker open on Android.
  let fileInput = null;
  const pickAndUpload = () => {
    if (!panes.get(activeSid)) { flash("no pane"); return; }
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.multiple = true;
      fileInput.hidden = true;
      // without clearing the value, picking the same file twice fires no change event
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
    flash("uploading " + files.length + "...");
    fetch("/api/upload", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) throw new Error((j && j.error) || "upload failed");
        // paths contain no spaces (the server's `_safe_name` maps them to `_`), so joining
        // them with a space is safe
        pasteText(p, j.files.map((f) => f.path).join(" "));
        const kb = Math.round(total / 1024);
        flash("uploaded " + j.files.length + " " + (kb > 1024 ? (kb / 1024).toFixed(1) + "MB" : kb + "KB"));
        if (j.errors && j.errors.length) diag({ ev: "upload-partial", errors: j.errors });
      })
      .catch((e) => {
        flash("upload failed");
        diag({ ev: "upload-fail", n: files.length, bytes: total, err: String(e && e.message || e) });
      });
  };

  // Selection -> clipboard, and never fail silently.
  // `navigator.clipboard` exists only in a secure context: over https (tailscale serve) or
  // on localhost it is there, but on a raw IP such as http://100.x.x.x:8767 it is missing
  // entirely - the first suspect when "selecting does not copy" remotely. In that case fall
  // back to a hidden textarea plus execCommand("copy"), dated but the only path left
  // outside a secure context.
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

  // Paste from a remote browser (another PC or a phone): the clipboard lives on the
  // browser side. Text is pasted as is; an image is uploaded to the server (same trick as
  // the upload path) and only its path pasted, which claude reads.
  // `navigator.clipboard.read()` needs a secure context plus a user gesture. tailscale
  // serve wraps remote access in https, so it qualifies; a raw http://100.x connection
  // does not, and there even the readText fallback below is missing, so nothing happens.
  const pasteFromBrowserClip = (p) => {
    const api = navigator.clipboard;
    const readAll = (api && api.read) ? api.read() : Promise.reject(new Error("no clipboard.read"));
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
    if (!p) { flash("no pane"); return; }
    const first  = pcFirst ? readPcClip : readPhoneClip;
    const second = pcFirst ? readPhoneClip : readPcClip;
    // Try the other source when the first one fails OR comes back empty: a denied phone
    // permission and "the text only exists on the PC" both look like nothing happening.
    first()
      .then((t) => (t && t.length) ? t : second())
      .catch(() => second())
      .then((t) => {
        if (t && t.length) pasteText(p, t);
        else flash("clipboard is empty");
      })
      .catch((e) => {
        flash("paste failed");
        diag({ ev: "paste-fail", pcFirst: !!pcFirst, err: String(e && e.message || e) });
      });
  };

  // ---------- sizing ----------
  // A pane counts as hidden when its group is off or it is covered by a zoom.
  // (Panes themselves no longer use `.off` - see the `.tabgroup` comment in app.css.)
  const isOff = (p) => {
    if (p.el.classList.contains("dim")) return true;
    const g = p.el.parentElement;
    return !!(g && g.classList.contains("off"));
  };

  function resizePane(p) {
    if (!p || isOff(p)) return;
    // Never resize mid IME composition: a resize makes the shell redraw and xterm
    // reposition the textarea, which breaks the character being composed.
    if (composing) return;
    if (reportSize) {
      // An open keyboard no longer blocks this. Bailing out on `kbOpen` left the screen
      // covered and the prompt invisible. The phone block now shrinks the body height when
      // the keyboard opens, so the fit result IS the visible area and demanding that size
      // is correct.
      p.fit.fit();                                            // settle our own cell count
      // Skip the report based on the PTY's ACTUAL size, never on "what I sent last time".
      // Comparing against `p.reported` deadlocked: fit says 78, reported is 78 so the
      // report is skipped, the PTY stays at 69, polling sees the mismatch and calls
      // term.resize(69), fit says 78 again... xterm then occupied 78 columns while the PTY
      // had 69, so claude's separators stopped short of the right edge.
      // The only reason to skip is that the PTY already matches our size.
      const cur = sessOf(p.sid);
      if (cur && cur.cols === p.term.cols && cur.rows === p.term.rows) return;
      // just sent the same value? it may not be applied yet - wait briefly to avoid dupes
      if (p.reported && p.reported[0] === p.term.cols && p.reported[1] === p.term.rows
          && performance.now() - p.reportedAt < 1500) return;
      // Ignore small jitter while typing. A resize makes the shell redraw everything, and
      // mid-typing that overprints the completion list and input box. Opening the keyboard
      // or the dock is a big change (9+ rows) and passes through; the +/-4 rows an address
      // bar produces while sliding are dropped, but only while typing.
      if (typing && p.reported && p.reported[0] === p.term.cols
          && Math.abs(p.reported[1] - p.term.rows) <= 5) return;
      // While `forced`, carry force on EVERY report; otherwise the server holds the old
      // forced value and ignores new ones, leaving a foldable stuck at its folded size.
      wsend(p, { t: "r", c: p.term.cols, r: p.term.rows, force: forced || undefined });
      p.reported = [p.term.cols, p.term.rows];   // so polling does not revert us to the old PTY size
      p.reportedAt = performance.now();
    } else {
      // Follower mode always syncs, keyboard or not: all it does is apply the PTY size to
      // xterm, so the keyboard is irrelevant. A guard here once blocked it and xterm could
      // not follow a PTY resize, scattering glyphs (the cell-count mismatch this file opens
      // with).
      const s = sessOf(p.sid);                                // follower: take the PTY size as is
      if (s && s.cols && s.rows && (p.term.cols !== s.cols || p.term.rows !== s.rows)) {
        p.term.resize(s.cols, s.rows);
      }
    }
  }
  const resizeAll = () => panes.forEach(resizePane);
  // Coalesce event-driven re-measurements into one.
  // Measured: 77x22 <-> 77x35 bouncing every 16ms. Changing the body height wakes the
  // ResizeObserver, which measures again - a feedback loop that flips the PTY back and
  // forth and makes the shell redraw each time. Human-driven changes never finish inside
  // 100ms, so only the final state matters. This also filters a phone address bar sliding
  // in and out by ~96px (about 4 rows): intermediate values are dropped and only the
  // settled size reaches the PTY.
  let resizeTimer = 0;
  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAll, 400);
  };

  // ---------- blank-screen self-healing ----------
  // Force a full redraw to recover a screen that is blank while the buffer is intact.
  // xterm only paints changed lines, so after a renderer dies and comes back it has to be
  // told to repaint everything. Costs one frame.
  function redraw(p) {
    if (!p) return;
    try { p.term.refresh(0, p.term.rows - 1); } catch (_) {}
  }

  // Recovery path for a screen that intermittently goes blank on phones.
  // The daemon, PTY and session are all fine; something on the browser side has stalled.
  // Three ways that happens on a phone:
  //   1. WebGL context loss - Android Chrome reclaims GPU resources from background tabs.
  //      The addon falls back to the DOM renderer on `webglcontextlost`, but the context
  //      is sometimes invalidated with no event, so ask `isContextLost()` directly.
  //   2. Zombie socket - the WS closed while frozen and the reconnect timeout died with
  //      it, so nothing ever re-attaches (bfcache / tab-discard boundary).
  //   3. Collapsed layout - `visualViewport` reported a bogus height once, `applyViewport`
  //      shrank the body, and no sane value ever arrived to undo it.
  //
  // Called ONLY from refresh (`refitPane`); it never runs on a timer. The first version
  // also ran every 5s and on visibilitychange/pageshow, which contradicts this app's rule
  // that sizing is never automatic, and a periodic full redraw only adds risk surface in
  // normal use. When the screen looks wrong the user presses refresh; checking once then
  // is enough.
  //
  // Either way, fix it and record what was fixed in the server log
  // (`DIAG {"ev": "heal"...}` in webterm.log) so a recurrence needs no guessing.
  function healPanes(why) {
    const p = panes.get(activeSid);
    if (!p) return;
    const fixed = [];

    // 1. Is the WebGL context dead? Ask the context already attached to the canvas
    //    (`getContext` returns the same object for the same canvas and type, so this
    //    creates nothing new).
    if (p.webgl) {
      let lost = false;
      p.el.querySelectorAll("canvas").forEach((c) => {
        try {
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          if (gl && gl.isContextLost()) lost = true;
        } catch (_) {}
      });
      if (lost) {
        // dispose() restores the DOM renderer and calls handleResize (vendor/addon-webgl.js).
        // Do not re-attach: the cause (backgrounded, GPU reclaimed) would strike again.
        try { p.webgl.dispose(); } catch (_) {}
        p.webgl = null;
        fixed.push("webgl");
      }
    }

    // 2. The socket has been closed and idle for a while -> attach now.
    //    Do not test `p.retry` (the timer id): `connect` only clears the timeout without
    //    resetting the field, so any pane that reconnected once stays truthy forever.
    //    Measure from the close time; well past the 5s backoff cap means retries are dead.
    if (sessOf(p.sid) && (!p.ws || p.ws.readyState === 3)
        && performance.now() - (p.closedAt || 0) > 6000) {
      clearTimeout(p.retry);
      p.delay = 500;
      connect(p);
      fixed.push("ws");
    }

    // 3. No room to draw the terminal -> recompute the viewport (phone-only; no-op on PC)
    const box = p.el.getBoundingClientRect();
    if (box.height < 40 || box.width < 40) { applyViewport(); scheduleResize(); fixed.push("layout"); }

    redraw(p);                      // refresh means "repaint", so always paint once
    if (fixed.length) {
      diag({ ev: "heal", why: why, fixed: fixed,
             h: Math.round(box.height), w: Math.round(box.width),
             ws: p.ws ? p.ws.readyState : -1 });
    }
  }

  // ---------- tab / pane operations ----------
  function selectTab(name) {
    if (activeTab === name) return;
    activeTab = name;
    const ps = tabPanes(name);
    // Return to whatever pane was full screen in this tab (`zoomByTab`). The zoomed pane
    // IS the visible screen, so the active pane must match it; otherwise the screen shows
    // one pane while keystrokes go to another.
    const z = zoomByTab[name];
    const keep = (z && ps.some(p => p.sid === z)) ? z : null;
    activeSid = keep || (ps.length ? ps[0].sid : null);
    renderTabs(); renderPanes(); focusPane(activeSid);
  }
  function focusPane(sid) {
    if (!sid) return;
    const changed = activeSid !== sid;
    // Selecting another pane while zoomed moves the zoom to that pane.
    // Changing only `activeSid` was not enough: `.pane.zoom` covers the whole screen, so
    // the view stayed put while keystrokes went to an invisible pane. The rule used to
    // live in `cyclePane` alone, so arrow keys worked and clicks did not - it now lives in
    // this one function, which every selection path goes through (PC chips, phone chip
    // bar, drawer, context menu, pane click, cyclePane).
    const rezoom = !!zoomSid && zoomSid !== sid && tabPanes(activeTab).some(p => p.sid === sid);
    if (rezoom) setZoom(sid);
    activeSid = sid;
    for (const [id, q] of panes) q.el.classList.toggle("active", id === sid);
    const p = panes.get(sid);
    if (p) focusTerm(p.term);          // no focus in read mode (keeps the keyboard down)
    // On a phone, switching tab or pane means "go look at something", so turn typing off
    // and drop the keyboard. Typing is enabled explicitly by a double tap (or the keyboard
    // button) - that is the app's only keyboard rule.
    if (isPhone && changed) setPhoneTyping(false);
    // A phone shows one pane at a time even when split (`zoom = activeSid`), so a change
    // of active pane needs a re-render for the screen to actually move. Without it you
    // waited for the 4s poll.
    if (rezoom || (isPhone && changed)) renderPanes();
    renderChips();
  }
  function cyclePane(d) {
    const ps = tabPanes(activeTab);
    if (ps.length < 2) return;
    const i = ps.findIndex(p => p.sid === activeSid);
    const n = ((i < 0 ? 0 : i) + d + ps.length) % ps.length;
    focusPane(ps[n].sid);        // while zoomed, focusPane moves the zoom to that pane
  }
  function zoomPane(idx) {
    const ps = tabPanes(activeTab);
    const target = ps[idx];
    if (!target) return;
    setZoom(zoomSid === target.sid ? null : target.sid);      // same number again = unzoom
    if (zoomSid) activeSid = target.sid;
    renderPanes(); focusPane(activeSid);
  }

  async function splitPane(dir) {
    if (!activeTab) return;
    const cur = sessOf(activeSid);
    layouts[activeTab] = dir;
    // one more session with the same tab name IS the new pane
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
    if (!confirm(many ? `Close a pane of '${s.name}'?` : `Close tab '${s.name}'?`)) return;
    await api.kill(sid);
    if (zoomSid === sid) setZoom(null);
    await refresh();
  }
  async function closeTab(name) {
    const ps = tabPanes(name);
    if (!ps.length) return;
    if (!confirm(`Close tab '${name}' (${ps.length} panes)?`)) return;
    for (const p of ps) await api.kill(p.sid);
    await refresh();
  }
  // Ctrl+P - a manual name for this pane only; clearing it returns to the automatic
  // number. The prompt shows the number too, so it is clear which pane is being renamed.
  async function renamePane(sid) {
    const s = sessOf(sid);
    if (!s) return;
    const i = tabPanes(s.name).findIndex(p => p.sid === sid);
    const v = await ask(`Pane name (#${i + 1} · empty = auto)`, paneLabel(sid));
    if (v === null) return;
    // (tab name, label) is a composite key. The daemon validates it (direct API calls are
    // rejected too); here we only report the result.
    const r = await api.label(sid, v.trim());   // an empty string reverts to automatic
    if (r && r.ok === false) {
      alert(r.error || "could not rename");
      return renamePane(sid);                   // ask again instead of discarding the input
    }
    await refresh(true);                        // the label only shows after a list refresh
  }

  async function renameTab(name) {
    const v = await ask("Tab name", name);
    if (v === null) return;
    const t = v.trim();
    if (!t || t === name) return;
    // The server validates: colliding with another tab name would merge the two tabs and
    // break the (tab, pane label) composite key, so it answers 409.
    const r = await api.renameTab(name, t);
    if (r && r.ok === false) {
      alert(r.error || "could not rename the tab");
      return renameTab(name);      // ask again instead of discarding the input
    }
    if (activeTab === name) activeTab = t;
    await refresh(true);
  }

  // ---------- refresh ----------
  // Replacing the DOM on every 4s poll would flicker the screen and shake focus, so
  // re-render only when the session list actually changed.
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

    // Alone on this session? Become the owner immediately - there is nobody to take it
    // from, and the observer rule exists only to avoid disturbing someone else's screen.
    // With others attached, stay an observer until this window is clicked or typed in.
    {
      const act = sessions.find(x => x.sid === activeSid);
      if (act && act.clients <= 1) claimOwnership();
    }

    // Apply the PTY size (cols/rows) to xterm on EVERY poll, before the `sig` comparison.
    // Follower mode takes the PTY size in `resizePane`'s else branch, but that function was
    // only triggered by local screen changes (resize, ResizeObserver, resizeAll after a
    // render). So when another client changed the PTY size, a phone never found out and
    // kept drawing at the old cell count - breaking the "xterm cells == PTY cells" rule,
    // which is what clipped statuslines and skewed rows. `sig` carries no size, so even the
    // 4s poll missed it. Sizes are therefore synced regardless of whether we re-render.
    for (const [sid, p] of panes) {
      const s = sessions.find(x => x.sid === sid);
      if (!s || !s.cols || !s.rows) continue;
      if (p.term.cols === s.cols && p.term.rows === s.rows) continue;
      // A size we just demanded may not have reached the daemon yet (4s poll). Treating
      // that as a mismatch makes fit and polling push against each other and flicker, so
      // trust our own value briefly.
      if (p.reported && performance.now() - p.reportedAt < 3000
          && (p.reported[0] !== s.cols || p.reported[1] !== s.rows)) continue;
      // Getting here means our request was refused (another client pinned it, or the
      // server picked a different value). Follow it even while pinned: "xterm cells == PTY
      // cells" is the absolute rule at the top of this file, and breaking it misplaces
      // glyphs. The 3s grace above already filtered out "not applied yet", so this is a
      // real mismatch.
      p.term.resize(s.cols, s.rows);
    }

    // Never put cols/rows into `sig`. Doing so created a feedback loop:
    //   PTY resize -> sig change -> renderPanes() -> resizeAll() -> fit -> report new size
    //   -> PTY resize -> ... repeating on every 4s poll
    // Measured: 77x26 <-> 77x35 bouncing every 99ms, and the shell redrawing each time,
    // which is what made the statusline appear twice. The loop above already applies sizes
    // on every poll, so `sig` does not need to know about them.
    const sig = JSON.stringify(sessions.map(s => [s.sid, s.name, s.alive, s.title, s.clients]))
              + "|" + activeTab + "|" + activeSid + "|" + zoomSid;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    renderTabs();
    renderPanes();
  }

  // ---------- context menu ----------
  let menuTab = null, menuSid = null;
  function openMenu(e, name, sid) {
    menuTab = name; menuSid = sid || activeSid;
    const m = $("#menu");
    // The WebGL setting and what is actually attached can differ: attachment waits for
    // the fonts, and on unsupported devices it never happens. Show the two separately.
    const wgItem = m.querySelector('[data-act="webgl"]');
    if (wgItem) {
      const want = useWebgl();
      const live = !!(panes.get(menuSid) || {}).webgl;
      wgItem.textContent = want
        ? (live ? "✓ Sharpen (WebGL) — on · click to turn off"
                : "… Sharpen (WebGL) — on (pending/unsupported) · click to turn off")
        : "Sharpen (WebGL) — off · click to turn on";
    }
    m.hidden = false;
    menuAt = performance.now();
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  }
  const closeMenu = () => { $("#menu").hidden = true; };
  // On a phone a synthetic click follows the touch release and would immediately close
  // the menu that just opened. The gesture block preventDefault()s it, but some browsers
  // fire it anyway, so ignore clicks right after opening.
  let menuAt = 0;
  addEventListener("click", () => { if (performance.now() - menuAt > 350) closeMenu(); });
  addEventListener("blur", closeMenu);
  $("#menu").onclick = async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === "split-h") return splitPane("h");
    if (act === "split-v") return splitPane("v");
    if (act === "zoom") {                       // same as double click, reachable from the menu
      // `zoomPane` counts indexes within the CURRENT tab, so if another tab was
      // right-clicked in the tab bar, switch to it first or the index is wrong.
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

  // Re-measure cells and re-bake glyphs, rescuing a pane whose font arrived late.
  // Nudging `fontSize` makes xterm re-measure the character size; the WebGL atlas needs
  // `clearTextureAtlas()` for the fallback glyphs to go away.
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

  // Refresh = fit to my screen AND force a repaint.
  // When the size changes several times in quick succession, a TUI such as claude can miss
  // the last SIGWINCH and keep drawing at the old width (measured: a 69-column PTY filled
  // to only 63). The cell counts are right, so there is nothing to fix on our side - the
  // shell just has to redraw. Re-sending the same size is filtered out by the server
  // (`_applied_size`), so shrink by one column and restore it to raise SIGWINCH twice.
  //
  // This used to be two menu items - "redraw" and "fit to this screen" (an ownership
  // toggle) - but the user-visible symptom for both is simply "the screen is broken", so
  // they merged and the pinned/unpinned state disappeared.
  // Sizing is deliberately not automatic: a size that changes by itself is worse. Ownership
  // moves only when the button is pressed, on whichever device pressed it. That is why
  // there is no "unpin" item - the server releases a departed owner via FORCE_GRACE.
  function refitPane(sid) {
    const p = panes.get(sid || activeSid);
    if (!p) return;
    remeasureCells();                      // also rescues panes baked with fallback glyphs
    forced = true;                         // my screen is the reference now, rotation and folds included
    localStorage.setItem("webterm.fit", "1");
    try { p.fit.fit(); } catch (e) {}      // settle the cell count for the current screen
    const c = p.term.cols, r = p.term.rows;
    wsend(p, { t: "r", c: c, r: r, force: true });                                  // pin that size
    // If the cell count is unchanged the PTY ignores the resize and the TUI never redraws,
    // so shrink by one column and restore it to manufacture a change.
    setTimeout(() => wsend(p, { t: "r", c: Math.max(2, c - 1), r: r, force: true }), 60);
    setTimeout(() => wsend(p, { t: "r", c: c, r: r, force: true }), 200);
    // Refresh is the button you press when the screen looks wrong, so do more than
    // renegotiate the size: also check renderer, socket and viewport, and repaint
    // everything (see `healPanes`).
    healPanes("refit");
    flash("fit to screen " + c + "x" + r);
  }

  // ---------- fit to screen (pin) ----------
  // Sizing is automatic all the time (whatever width and height the browser reports is
  // demanded of the PTY). The pin sits on top of that: it keeps my screen's size even
  // while another client is attached.
  // It used to be a button in the tab bar, but it was easy to hit by accident on a phone
  // and took up space, so it moved to the long press / context menu.


  // ---------- inline prompt ----------
  function ask(labelText, initial) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.id = "ask";
      wrap.innerHTML = `<div class="box"><label></label>
        <input type="text" spellcheck="false" autocomplete="off">
        <div class="hint">Enter to confirm · Esc to cancel</div></div>`;
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

  // ---------- keys ----------
  // The key map is carried over from .wezterm.lua: Ctrl = tabs, Alt = panes.
  //   Ctrl+N new tab, Ctrl+T rename tab, Ctrl+] / Ctrl+\ split,
  //   Ctrl+1..9 and Ctrl+arrows switch tabs, Ctrl+plus/minus font size
  //   Alt+1..9 zoom pane, Alt+arrows move pane, Alt+0 unzoom
  //   plus Alt+B for the vertical session rail (webterm-only, for when there are many tabs)
  //
  // Chords the app uses must not leak into the terminal, and preventDefault() alone is not
  // enough: xterm listens for keydown on its own textarea, so `attachCustomKeyEventHandler`
  // has to return false (otherwise Alt+1 reached PSReadLine as `digit-argument: 1`).
  //
  // Shortcuts: action registry + key map.
  // "Do we intercept this key" (isAppKey) and "what does it do" (the keydown handler) used
  // to be hardcoded separately, so changing one key meant editing two places, and any drift
  // produced the nasty failure of intercepting a key that then did nothing. Both are now
  // derived from a single key map, so they cannot drift.
  //
  // The key map comes from the server (config.default.json <- config.json); only the action
  // implementations live here.

  const ACTIONS = {
    "pane.split.h": { desc: "split pane left/right",        run: () => splitPane("h") },
    "pane.split.v": { desc: "split pane top/bottom",        run: () => splitPane("v") },
    "pane.zoom":    { desc: "fullscreen pane N",     run: (n) => zoomPane(+n - 1) },
    "pane.unzoom":  { desc: "unzoom",               run: () => { setZoom(null); renderPanes(); } },
    "pane.prev":    { desc: "previous pane",             run: () => cyclePane(-1) },
    "pane.next":    { desc: "next pane",             run: () => cyclePane(1) },
    "pane.close":   { desc: "close pane",             run: () => { if (activeSid) closePane(activeSid); } },
    "pane.rename":  { desc: "pane name",             run: () => { if (activeSid) renamePane(activeSid); } },

    "tab.new":      { desc: "new tab",                 run: () => newTab(DEFAULT_CWD) },
    "tab.rename":   { desc: "tab name",               run: () => { if (activeTab) renameTab(activeTab); } },
    "tab.prev":     { desc: "previous tab",               run: () => cycleTab(-1) },
    "tab.next":     { desc: "next tab",               run: () => cycleTab(1) },
    "tab.select":   { desc: "go to tab N",            run: (n) => {
                        const names = tabNames();
                        if (names[+n - 1]) selectTab(names[+n - 1]);
                      } },

    "rail.toggle":  { desc: "toggle vertical session rail",   run: () => setRail(!railOn) },
    "view.refit":   { desc: "refit the screen", run: () => refitPane(activeSid) },

    "font.inc":     { desc: "bigger font",             run: () => setFont(fontSize + 1) },
    "font.dec":     { desc: "smaller font",             run: () => setFont(fontSize - 1) },
    "font.reset":   { desc: "reset font",         run: () => setFont(baseFont) },
  };

  // Event -> "Ctrl+Alt+Shift+key". It must spell chords exactly like the config file does,
  // so matching and dispatch share this one function.
  const chordOf = (e) =>
    (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") +
    (e.shiftKey ? "Shift+" : "") + e.key.toLowerCase();

  let keymap = new Map();                    // chord -> { id, arg }

  function setKeymap(obj) {
    keymap = new Map();
    for (const [chord, spec] of Object.entries(obj || {})) {
      if (!spec) continue;                   // "" = deliberately unbound = pass to the terminal
      const i = spec.indexOf(":");
      const id = i === -1 ? spec : spec.slice(0, i);
      const arg = i === -1 ? undefined : spec.slice(i + 1);
      if (!ACTIONS[id]) {
        // Ignoring this silently turns into "I configured it, why does nothing happen".
        console.warn(`[webterm] unknown action in keymap: "${spec}" (${chord})`);
        continue;
      }
      keymap.set(chord, { id, arg });
    }
  }

  // Built-in defaults for when the config cannot be fetched; without them one server
  // hiccup would kill every shortcut.
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

  // Notes: Ctrl+W (delete word) and Ctrl+R (reverse search) are deliberately left unbound
  // because PSReadLine really uses them (per Get-PSReadLineKeyHandler -Bound, unlike
  // Ctrl+P / Ctrl+N / Ctrl+T / Ctrl+O).
  // Ctrl+P is the browser's Print, so it has to be intercepted to be usable at all.
  // Close is Alt+X because Ctrl+W and Ctrl+Shift+W close the browser window before the app
  // sees them; the letter matches WezTerm's Leader+x.

  addEventListener("keydown", (e) => {
    // disable app shortcuts while the rename prompt is open, else Ctrl+P reopens it
    if (document.getElementById("ask")) return;
    const hit = keymap.get(chordOf(e));
    if (!hit) return;
    e.preventDefault();
    try {
      ACTIONS[hit.id].run(hit.arg);
    } catch (err) {
      console.error(`[webterm] action failed: ${hit.id}`, err);
    }
  }, true);

  // Fetch and apply the config. The app must still start if that fails, so fall back to
  // the built-in defaults.
  async function loadConfig() {
    let cfg = null;
    try {
      cfg = await fetch("/api/config").then(r => r.json());
    } catch (err) {
      console.warn("[webterm] /api/config failed - using built-in defaults", err);
    }
    if (cfg && cfg.ok) {
      DEFAULT_CWD = cfg.defaultCwd || "";
      // a font size the user set in this browser (localStorage) wins
      if (cfg.fontSize && localStorage.getItem("webterm.font") === null) {
        baseFont = +cfg.fontSize;
        fontSize = baseFont;
      }
    }
    const km = (cfg && cfg.keymap && Object.keys(cfg.keymap).length) ? cfg.keymap : FALLBACK_KEYMAP;
    setKeymap(km);
  }

  // Console helper - shows what can be written in the config file.
  window.webterm = {
    actions: () => Object.entries(ACTIONS).map(([id, a]) => `${id.padEnd(16)} ${a.desc}`).join("\n"),
    keymap: () => [...keymap].map(([c, h]) => `${c.padEnd(18)} ${h.id}${h.arg ? ":" + h.arg : ""}`).join("\n"),
    chordOf,
  };

  // Alt leaves the cursor stuck as a crosshair.
  // xterm reads Alt as "column (block) selection mode" and adds `column-select` to `.xterm`
  // (vendor/xterm.css: `.xterm.column-select.focus{cursor:crosshair}`), removing it on
  // keyup - but Alt+Tab leaves the window and that keyup never arrives. The class sticks,
  // so on return the crosshair remains and the mouse behaves as if column-selecting.
  // We use Alt as the pane layer (zoom, move, close), so there is no column-select mode at
  // all: the cursor is killed in CSS and the stuck class is cleared when the window blurs.
  // Alt+Tab itself is grabbed by the OS before the browser, so a web page cannot block it;
  // `isAppKey` does not touch Tab either. What is fixed here is the leftover state.
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

  // Vertical rail - the button and Alt+B share one path. Apply the stored state once at boot.
  $("#rail-toggle").onclick = () => setRail(!railOn);
  if (railOn) setRail(true);

  $("#new-tab").onclick = () => newTab(DEFAULT_CWD);
  $("#new-tab").oncontextmenu = async (e) => {
    e.preventDefault();
    const cur = sessOf(activeSid);
    const cwd = await ask("Starting folder for the new tab", cur ? cur.cwd : DEFAULT_CWD);
    if (cwd && cwd.trim()) newTab(cwd.trim());
  };

  // ---------- phone UI (keyboard.js adapter) ----------
  // keyboard.js expects the wezterm-web backend (/api/key, /api/send), so mimic that
  // interface here.
  const ESC = "\x1b";
  const KEY_SEQ = {
    esc: ESC, tab: "\t", shifttab: ESC + "[Z", enter: "\r", space: " ",
    backspace: "\x7f", delete: ESC + "[3~",
    up: ESC + "[A", down: ESC + "[B", right: ESC + "[C", left: ESC + "[D",
    home: ESC + "[H", end: ESC + "[F", pgup: ESC + "[5~", pgdn: ESC + "[6~",
    // Shift chords - looked up by these names when the dock's shift key is on
    // (keyboard.js `runAction`). Arrows/Home/End use the standard CSI modifier encoding
    // (`1;2` = Shift).
    shiftup: ESC + "[1;2A", shiftdown: ESC + "[1;2B",
    shiftright: ESC + "[1;2C", shiftleft: ESC + "[1;2D",
    shifthome: ESC + "[1;2H", shiftend: ESC + "[1;2F",
    // Shift+Enter = newline. The terminal protocol has no such signal, which is why claude
    // installs a key binding for iTerm2 and VSCode (isShiftEnterKeyBindingInstalled). Our
    // terminal is not on that list, so send claude's documented alternative: ctrl+j, i.e.
    // line feed 0x0A.
    shiftenter: "\n",
  };
  // Cursor keys are encoded differently depending on the terminal mode (DECCKM,
  // application cursor keys). TUIs such as claude turn it on and expect `ESC O`, so sending
  // the `ESC [` forms above unconditionally does not work. Arrows mostly worked because
  // many apps accept both; Home/End do not, which is why they did nothing.
  // pgup/pgdn (ESC[5~) and control characters are mode-independent.
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
  // keyboard.js asks whether a chord exists (to decide Shift+key support)
  window.hasKeySeq = (name) => !!KEY_SEQ[name];
  window.setStatus = (msg, isErr) => { if (isErr) console.warn("[kb]", msg); };
  window.refreshScreen = () => {};
  window.post = async (url, body) => {
    const p = panes.get(activeSid);
    if (!p) return { ok: false, msg: "no active pane" };
    if (url === "/api/key") {
      const seq = keySeq(p.term, body.key);      // encode for the current cursor-key mode
      if (!seq) return { ok: false, msg: "unknown key: " + body.key };
      wsend(p, { t: "i", d: seq });
      return { ok: true };
    }
    if (url === "/api/send") {
      // Sending the body and the Enter in one chunk makes a TUI such as claude treat it as
      // a paste and swallow the trailing CR as a newline rather than a submit (the text
      // lands but nothing is sent). Same rule as the server's /api/send: body first, then
      // the Enter separately after a short gap.
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

    // The special-key dock rides along with the soft keyboard.
    // The old flow was three steps - a floating button, expand the dock, then enable the
    // keyboard from inside it - and the floating button always covered part of the screen.
    // Now the dock appears with the keyboard: nothing floats while reading, and entering
    // typing mode (double tap, or the tab bar button) puts the special keys directly above
    // the keyboard. `applyViewport` decides the dock's visibility from `kbOpen`.
    const pad = $("#pad");
    pad.hidden = true;
    // touches inside the dock belong to keyboard.js and must not reach the terminal's
    // double-tap detection
    pad.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

    // Phone navigation - the header becomes [menu][chip bar][keyboard]
    // (renderPhoneNav / renderDrawer draw the chips and the drawer).
    // The "new tab" and "install" buttons are MOVED, not cloned: cloning splits the handler
    // across two elements and only one of them works. The PC header's buttons live on at
    // the bottom of the drawer.
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
    nt.textContent = "+ New tab";        // "+" alone was enough in the header; the drawer needs a label
    foot.appendChild(nt);
    foot.appendChild($("#install"));
    renderPhoneNav();

    // Reading dock - shown only while the keyboard is down (`applyViewport` decides).
    // These three drive xterm's scrollback; they are NOT keys sent to the terminal. Binding
    // `k:pgup` here once produced "pressing it does not scroll", because `k:*` goes to the
    // shell and leaves the view untouched.
    const spad = $("#scrollpad");
    spad.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    spad.addEventListener("click", (e) => {
      const v = e.target && e.target.dataset && e.target.dataset.scroll;
      if (!v) return;
      if (v === "end") window.__wt.app.bottom();
      else window.__wt.app.scroll(+v);
    });
    // Phones default to read mode. Calling `term.focus()` on every touchend caused two
    // symptoms at once: the Android keyboard popped up on any touch, and a scroll flick
    // died on release as focus was taken and the browser jumped back to the cursor.
    // Most phone time is spent reading, so typing is enabled explicitly.
    // `inputMode="none"` is the key: focus is kept (special keys and paste still work) but
    // the soft keyboard stays down; `readOnly` would kill input altogether.
    const setTyping = (on) => {
      typing = on;
      // The rule lives in `applyInputMode` alone: inputMode and disabled must move
      // together, and touching only inputMode here reopens the read-mode focus hole.
      panes.forEach(p => applyInputMode(p.term));
      const tgb = $("#kb-toggle");
      tgb.classList.toggle("on", on);
      tgb.title = on ? "Input mode — tap to close the keyboard and read" : "Read mode — tap or double-tap the screen for input mode";
      const p = panes.get(activeSid);
      if (!p) return;
      if (on) {
        p.term.focus();
        setTimeout(() => p.term.scrollToBottom(), 350);   // reveal the cursor once the keyboard is up
      } else if (p.term.textarea) {
        p.term.textarea.blur();
        setTimeout(() => { window.scrollTo(0, 0); p.term.scrollToBottom(); }, 260);
      }
    };

    togglePhoneKb = () => setTyping(!typing);   // called by the dock's keyboard key
    // Entry point for outside callers (focusPane and friends). Acts only on a real change;
    // re-applying the same value spins the blur/scrollTo timers and makes the screen twitch.
    setPhoneTyping = (on) => { if (typing !== on) setTyping(on); };
    const tg = $("#kb-toggle");
    // Secondary way to turn the keyboard on; the main one is a double tap on the screen.
    // This button was hidden while the dock's own key did the job, but once the dock only
    // appears together with the keyboard, a double tap was the only way in - so it is back.
    tg.hidden = false;
    tg.onclick = () => setTyping(!typing);
    setTyping(false);                 // open in read mode

    // Terminal gestures, all branching from one place:
    //   - single tap: nothing (so scrolling is not disturbed)
    //   - double tap: toggle typing mode (keyboard on/off)
    //   - long press (450ms) then drag: select text; copy to clipboard on release
    //
    // A scroll gesture's touchend must not be mistaken for a tap, so ignore it once the
    // finger moved more than 12px.
    //
    // Why selection is implemented by hand: xterm's selection sits on mouse events
    // (mousedown/mousemove), and mobile browsers synthesize those for taps but not for
    // drags, so drag-select cannot work on a phone. We convert touch coordinates to cell
    // coordinates and call `term.select()` ourselves.
    //
    // Precision limit: the public API only offers `select(col, row, len)` (within one line)
    // and `selectLines(start, end)`. So dragging within a line selects characters and
    // crossing lines selects whole lines - which is actually the right granularity for
    // lifting a claude answer. Reaching into the internal SelectionService would break on
    // every xterm upgrade.
    {
      let sx = 0, sy = 0, tapAt = 0;
      let lpTimer = 0;              // long-press timer
      let sel = null;               // while selecting: { p, col, row } (the anchor)
      const el = $("#panes");

      // Touch coordinates -> cell coordinates. Cell width/height come from the measured
      // `.xterm-screen` size divided by cols/rows; constants drift because of dpr and font
      // fallback.
      const cellAt = (p, x, y) => {
        const scr = p.el.querySelector(".xterm-screen");
        if (!scr) return null;
        const r = scr.getBoundingClientRect();
        const cw = r.width / p.term.cols, ch = r.height / p.term.rows;
        if (!(cw > 0) || !(ch > 0)) return null;
        const cl = (v, hi) => Math.max(0, Math.min(hi, v));
        return {
          col: cl(Math.floor((x - r.left) / cw), p.term.cols - 1),
          // absolute row including scrollback (select/selectLines take buffer coordinates)
          row: p.term.buffer.active.viewportY + cl(Math.floor((y - r.top) / ch), p.term.rows - 1),
        };
      };
      const paneAt = (target) => {
        for (const p of panes.values()) if (p.el.contains(target)) return p;
        return panes.get(activeSid) || null;
      };

      const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };

      // Extend the selection to the finger. Both touch movement and edge auto-scroll
      // funnel through here.
      const applySelTo = (x, y) => {
        if (!sel) return;
        const c = cellAt(sel.p, x, y);
        if (!c) return;
        // Count it as a drag only when the CELL changed; counting finger jitter turns a
        // long press meant to open the menu into a one-character copy.
        if (c.col !== sel.col || c.row !== sel.row) sel.moved = true;
        if (c.row === sel.row) {
          const c0 = Math.min(c.col, sel.col);
          sel.p.term.select(c0, sel.row, Math.abs(c.col - sel.col) + 1);
        } else {
          sel.p.term.selectLines(Math.min(c.row, sel.row), Math.max(c.row, sel.row));
        }
      };

      // Edge auto-scroll - roll one line at a time while the finger rests in the top or
      // bottom band. `cellAt` adds `viewportY` to produce an absolute row, so scrolling is
      // what extends the selection.
      // Use `term.scrollLines()` rather than pushing `vp.scrollTop`: the unit of scrolling
      // is lines, not pixels, and more importantly `viewportY` follows reliably. If only
      // the view moved and `viewportY` stayed, the selection would not grow at all.
      let lastX = 0, lastY = 0, autoDir = 0, autoTimer = 0;
      const autoStop = () => { if (autoTimer) { clearInterval(autoTimer); autoTimer = 0; } autoDir = 0; };
      const autoStep = () => {
        if (!sel || !autoDir) { autoStop(); return; }
        sel.p.term.scrollLines(autoDir);
        lockTop = -1;                    // our own scroll - move the lock baseline along
        applySelTo(lastX, lastY);
      };

      // Scroll lock during selection - stop trying to persuade every scroller via a flag.
      // Setting `selecting` and hoping the inertia handler backs off did not work: measured
      // logs showed `viewportY` DROPPING as the finger moved down, 1:1 with the movement,
      // so something was still pushing `scrollTop`. Instead of chasing each source, undo it
      // at the single point where it lands (the `scroll` event): inertia, the browser's own
      // pan or xterm internals alike, any drift during a selection is reverted. Only our
      // own auto-scroll (`autoStep`) may move the baseline.
      let lockTop = -1, lockVp = null;
      const onLockScroll = () => {
        if (!sel || !lockVp) return;
        if (lockTop < 0) { lockTop = lockVp.scrollTop; return; }   // new baseline set by autoStep
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
        if (dir) { autoStep(); autoTimer = setInterval(autoStep, 90); }   // about 11 lines/s
      };

      // Temporary diagnostic - measures what actually moves during a drag, the terminal
      // viewport or the page. If `vy` (viewportY) stays put while the screen moves, the
      // PAGE is moving, the finger-to-cell mapping is unchanged, and the selection cannot grow.
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
        if (p) p.term.clearSelection();      // a new gesture clears the previous selection
        sel = null; selecting = false;       // clears state even if the last gesture ended badly
        autoStop(); unlockScroll();
        clearLp();
        if (e.touches.length > 1) return;    // two fingers (pinch/scroll) is not a selection
        lpTimer = setTimeout(() => {
          lpTimer = 0;
          // Temporary diagnostic: tells apart where "long press does not select" breaks -
          // the timer never fires, the cell math fails, or the selection is made but is not
          // visible on screen.
          if (!p) { diag({ ev: "lp-nopane" }); return; }
          const c = cellAt(p, sx, sy);
          if (!c) { diag({ ev: "lp-nocell" }); return; }
          diag({ ev: "lp-fire", col: c.col, row: c.row, rows: p.term.rows, cols: p.term.cols });
          sel = { p, col: c.col, row: c.row };
          selecting = true;                 // switch that makes the inertia handler back off
          lockScroll(p);                    // lock for whoever ignores that switch
          p.term.select(c.col, c.row, 1);
          if (navigator.vibrate) navigator.vibrate(15);   // the only signal that selection mode began
          flash("drag to select/copy · release for menu");
        }, 450);
      }, { passive: true });

      // This listener alone is non-passive: during a selection the browser scroll has to be
      // preventDefault()ed for the selection to follow the finger.
      el.addEventListener("touchmove", (e) => {
        const t = e.touches[0];
        if (!t) return;
        if (!sel) {
          // not selecting yet, so movement means scrolling - cancel the long press
          if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearLp();
          return;
        }
        e.preventDefault();
        lastX = t.clientX; lastY = t.clientY;
        applySelTo(lastX, lastY);
        // Scroll along when the finger reaches an edge; without it a selection could never
        // exceed the visible rows, since we turned the browser scroll off.
        // Measure the edge against the same box as `cellAt` (.xterm-screen): using the pane
        // box would be off by padding and scrollbar and create a dead band where the finger
        // is at the edge but nothing rolls.
        const scr = sel.p.el.querySelector(".xterm-screen");
        const r = (scr || sel.p.el).getBoundingClientRect();
        const EDGE = 44;                                   // thickness of the edge band (px)
        autoStart(lastY > r.bottom - EDGE ? 1 : (lastY < r.top + EDGE ? -1 : 0));
        dragLog("move");
      }, { passive: false });

      // Ends a gesture that began as a long press. Returns "this was not a tap".
      //   - dragged     -> copy the selected text to the clipboard
      //   - not dragged -> open the context menu (split, zoom, rename, close). The
      //     `contextmenu` path is blocked on phones, so it lives here instead.
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
        diag({ ev: "lp-end", moved: true, len: (text || "").length });   // temporary diagnostic
        if (!text || !text.trim()) { flash("nothing selected"); return true; }
        // writeText is allowed only inside a user gesture, and a touchend handler is one.
        // (Outside a secure context the API is missing and `copyToClipboard` falls back.)
        copyToClipboard(text);
        flash("copied " + text.length + " chars");
        return true;
      };

      // Non-passive too: a gesture that ended as a long press has to suppress the synthetic
      // click that follows (it would close the menu that just opened and confuse tap detection).
      el.addEventListener("touchend", (e) => {
        clearLp();
        if (endSel()) {                             // was a selection/menu gesture - not a tap
          tapAt = 0;
          if (e.cancelable) e.preventDefault();
          return;
        }
        const t = e.changedTouches[0];
        if (!t) return;
        if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) return;  // that was a scroll
        const now = performance.now();
        if (now - tapAt < 350) { tapAt = 0; setTyping(!typing); }   // second tap = toggle
        else tapAt = now;
      }, { passive: false });

      // `touchcancel` usually means the browser took the gesture over as a scroll. Getting
      // it during a selection signals a surviving `touch-action` reservation, so log it.
      el.addEventListener("touchcancel", () => {
        if (sel) diag({ ev: "lp-touchcancel", moved: !!sel.moved });
        clearLp(); autoStop(); unlockScroll(); sel = null; selecting = false;
      }, { passive: true });
    }
    // Keep new panes in the current mode; the textarea only exists after a render.
    setInterval(() => setTypingSync(), 5000);   // backup - the main path is applyInputMode
    function setTypingSync() {
      panes.forEach(p => {
        const ta = p.term.textarea;
        if (!ta) return;
        if (ta.inputMode !== (typing ? "text" : "none") || ta.disabled === typing) applyInputMode(p.term);
      });
    }

    // Soft keyboard handling: shrink the body to the visible height and re-fit the terminal.
    // An earlier version only corrected the scroll, because forcing the height (the
    // wezterm-web approach) drew the terminal at the top with blank space below. What was
    // missing was re-running `fit()` after the height change: xterm computes its own size,
    // so changing the height from outside without telling it goes wrong, and telling it
    // makes it exact. Height change and `resizeAll()` (fit -> report to the PTY) are
    // therefore one unit.
    // The cost is that opening and closing the keyboard resizes the PTY and makes TUIs such
    // as claude redraw - deliberately preferred over looking at a covered screen.
    {
      const vv = window.visualViewport;
      let vvTimer = 0;
      applyViewport = () => {
        // Keyboard height = layout viewport minus visual viewport.
        // Using "the largest `vv.height` seen without a keyboard" as the baseline collapses
        // on foldables: unfolded 1104, folded 709, and the 395px difference was mistaken
        // for a keyboard, latching `kb-open`. `innerHeight` shrinks along with a fold and
        // does not react to the soft keyboard, so the difference is purely the keyboard.
        // Address-bar noise (about 96px) stays under the 150 threshold.
        const vh = vv ? vv.height : window.innerHeight;
        const kbH = Math.max(0, Math.round(window.innerHeight - vh));
        const open = kbH > 150;
        const changed = open !== kbOpen;
        kbOpen = open;
        document.body.classList.toggle("kb-open", kbOpen);

        // A closed keyboard means typing mode is off. Dismissing it with the Android back
        // button fires no event, so the app kept believing typing=true and that stale state
        // raised the keyboard again on the next tab switch. Treat the real keyboard state
        // as the truth and roll the app state back.
        // Only on `changed && !open`: right after enabling it (not up yet) `changed` is
        // false, so this is safe.
        if (changed && !open && typing) { setTyping(false); diag({ ev: "kb-closed-sync" }); }

        // The dock is visible only while the keyboard is up, sitting right above it.
        // `position:fixed` is relative to the LAYOUT viewport even after the body shrinks,
        // so without lifting it explicitly the dock hides behind the keyboard.
        pad.hidden = !kbOpen;
        pad.style.bottom = kbOpen ? kbH + "px" : "";
        // the reading dock is the opposite - it yields to the key dock when the keyboard is up
        spad.hidden = kbOpen;

        // The keyboard is not the only thing covering the screen - the dock does too.
        // Being `position:fixed`, it is absent from the layout but still covers pixels, so
        // subtracting only the keyboard height left exactly the dock (about 90-130px) of
        // the terminal hidden.
        // Covered height = keyboard + whatever the dock occupies while open. The dock now
        // sits flush against the keyboard, so its own height is exactly what it hides.
        const dockH = (pad.hidden ? 0 : pad.offsetHeight) + (spad.hidden ? 0 : spad.offsetHeight);
        const usable = Math.max(120, vh - dockH);        // floor - a height of 0 breaks xterm
        document.body.style.height = (kbOpen || dockH) ? usable + "px" : "";

        clearTimeout(vvTimer);
        vvTimer = setTimeout(() => {
          // The browser scrolls the PAGE itself to reveal the caret, and closing the
          // keyboard does not undo that scroll, leaving the screen shifted - so reset it.
          window.scrollTo(0, 0);
          resizeAll();                                   // fit, then demand the new size of the PTY
          const toBottom = () => { const p = panes.get(activeSid); if (p) p.term.scrollToBottom(); };
          toBottom();                                    // bring the cursor above the keyboard
          // Once is not enough: the shell takes time to redraw at the size just demanded,
          // and when that output arrives the scroll position is off again.
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

    // Foldables and rotation - always re-fit to the new size. `resize` and ResizeObserver
    // also fire, but on a fold they can arrive before the layout settles (measuring an
    // intermediate size), so measure again one beat later.
    const refit = () => setTimeout(resizeAll, 350);
    addEventListener("resize", refit);
    if (screen.orientation) screen.orientation.addEventListener("change", refit);
  }

  // ---------- add to home screen ----------
  // The install requirements (HTTPS, manifest, service worker, icons) are already met, but
  // digging through the Chrome menu is awkward, so capture `beforeinstallprompt` and offer
  // it inside the app. The event only fires when the browser considers the app installable;
  // if it is already installed or a requirement is missing it never arrives and the button
  // stays hidden, which is the correct behaviour.
  let installPrompt = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();               // suppress the default banner and choose our own timing
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
      await installPrompt.userChoice;   // accepted or not, this prompt cannot be reused
      installPrompt = null;
      b.hidden = true;
    };
  }

  // ---------- render environment diagnostics ----------
  // Write one line to the server log describing what the browser is actually drawing with.
  // Naming a font does not mean it is used - a missing one falls back silently.
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
          ver: APP_VER,              // code version this browser really runs (cache check)
          dpr: devicePixelRatio,
          zoom: Math.round(devicePixelRatio * 100) + "%",
          fontSize, lineHeight: 1.15,
          has: { jetbrains: probe("JetBrains Mono"), consolas: probe("Consolas"),
                 cascadia: probe("Cascadia Mono"), malgun: probe("Malgun Gothic"),
                 d2coding: probe("D2Coding") },
          // Whether a font really attached is judged by width, not by name. Measuring each
          // one alone shows which is drawing (JetBrains 0.6em, Sarasa 0.5em, Consolas 0.55em).
          widthM: { consolas: wid("Consolas"), fallback: wid("monospace"),
                    jbmOnly: wid('"JetBrains Mono"'), sarasaOnly: wid('"Sarasa Fixed K"') },
          // Same idea, measured against "M" (one cell): an ambiguous-width character equal
          // to M is half width (correct), twice M is full width (spills into the next cell).
          w: (() => {
            // measure with the real font chain and infer which font draws from the width
            const f = `${fontSize}px "JetBrains Mono","Sarasa Fixed K",monospace`;
            cv.font = f;
            const one = cv.measureText("M").width;
            const r = {};
            for (const ch of ["M", "①", "·", "←", "가", "⚡"]) {
              r[ch] = +(cv.measureText(ch).width / one).toFixed(2);   // width in cells relative to M
            }
            return r;
          })(),
          // `document.fonts.check` is unreliable (true even for absent local fonts), so
          // report the real load status.
          loaded: [...document.fonts].filter(f => /Sarasa|JetBrains/.test(f.family))
                    .map(f => f.family + ":" + f.status).slice(0, 6),
          cell: dims && dims.css ? dims.css.cell : null,
          screen: `${innerWidth}x${innerHeight}`,
        }),
      });
    } catch (e) { /* a failed diagnostic must never disturb the terminal */ }
  }, 1500);

  // Ownership is claimed only when the user actually touches this window (see
  // `claimOwnership`). `focus` is deliberately not in the list: merely raising a window
  // fires it, which would break "attaching alone does not steal".
  addEventListener("mousedown", claimOwnership, true);
  addEventListener("keydown", claimOwnership, true);
  addEventListener("touchstart", claimOwnership, { capture: true, passive: true });
  addEventListener("wheel", claimOwnership, { capture: true, passive: true });

  // Size diagnostics - values instead of guesses. Logs the user's xterm/PTY/pixel sizes so
  // "the cell counts look off" no longer has to be reverse-engineered from a screenshot.
  // Runs every 5s but reports only on a mismatch, keeping the log clean when all is well.
  {
    let lastSig = "";
    setInterval(() => {
      const rows = [];
      for (const [sid, p] of panes) {
        if (isOff(p)) continue;
        const sess = sessions.find((x) => x.sid === sid);
        if (!sess) continue;
        const ok = p.term.cols === sess.cols && p.term.rows === sess.rows;
        if (ok) continue;                       // matching sizes pass silently
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
      if (sig === lastSig) return;              // do not resend an unchanged state
      lastSig = sig;
      try {
        fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ev: "size-diag", ver: APP_VER, rows: rows }) });
      } catch (_) {}
    }, 5000);
  }

  // ---------- periodic tasks ----------
  addEventListener("resize", scheduleResize);
  // Rotation - on some devices `resize` fires mid-animation and measures an intermediate
  // size, so listen for the orientation event too and re-measure one beat later.
  if (screen.orientation) screen.orientation.addEventListener("change", () => setTimeout(resizeAll, 350));
  addEventListener("orientationchange", () => setTimeout(resizeAll, 350));
  // Whoever is looking owns the size. With a PC and a phone attached at once the sizes
  // necessarily differ, so re-report on focus or return and the PTY matches the screen
  // actually in use. Without it, coming back to the PC from the phone leaves the PC stuck
  // at the phone's size until the window is resized.
  addEventListener("focus", () => setTimeout(resizeAll, 120));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(resizeAll, 200); });
  // Window-controls overlay changes in an installed PWA (maximize and so on): the tab bar
  // width changes even when the window size does not.
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

  // ---------- boot ----------
  (async () => {
    await loadConfig();          // keymap, default cwd, font
    await refresh();
    if (!sessions.length) await newTab(DEFAULT_CWD);
    else focusPane(activeSid);
  })();
})();
