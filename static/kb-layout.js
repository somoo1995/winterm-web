/* Virtual keyboard layout data - edit only this file to change the arrangement.
   (Rendering, gestures and the Hangul composer live in keyboard.js)

   -- Key object -------------------------------------------------
     c    action on tap (required)
     n ne e se s sw w nw    action when swiped that way (8 directions, like Unexpected Keyboard)
     lp   action on long press (see LONG_MS in keyboard.js)
     l    display label (defaults to c)
     wd   width multiplier (default 1) - named `wd` because `w` is the west swipe
     cls  extra CSS class - "fn" (gray function key) / "act" (accent)

   -- Three kinds of action string -------------------------------
     "k:esc"      sent straight to the terminal. The name is a key of `_KEY_MAP` in wezterm_bridge.py.
                  (esc tab shifttab enter space backspace delete up down left right
                   home end pgup pgdn ctrla ctrlb ctrlc ctrld ctrle ctrlf ctrlg
                   ctrlk ctrll ctrln ctrlo ctrlp ctrlr ctrlu ctrlw ctrly ctrlz)
     "a:xxx"      app action - enter / bs / shift / layer:en|ko|sym|toggle
                  / send:<cmd> (runs that command at once, bypassing the input box) / move (Tab completion)
     anything else   inserted into the input box. Hangul jamo go through the composer.

   Note: a multi-character literal action inserts the whole string ("k:"/"a:" are the only reserved prefixes).
*/
"use strict";

/* Special-key bar mode (the webterm default)
   webterm is a direct PTY connection, not a polling mirror, so typing on the phone's own
   keyboard reaches the terminal instantly (slash completion shows up after just `/we`).
   So no character rows and no staging input box are needed - only the keys a phone lacks.

   (wezterm-web mirrored with a 1.5s delay, which forced the "stage in a box, then send"
    design. That constraint is gone, so the character layers were removed outright.) */

// The action bar was removed (2026-08-20): its buttons were typeable on the phone keyboard,
// and the WebGL render toggle made no measurable difference in practice.
// The freed row went to making the arrow keys bigger.
const KB_ACTIONBAR = [];

// Function dock - a single row, sitting above where character rows used to be so that
// Esc/Tab come first like on a physical keyboard. Merging the arrows into one cluster
// freed space, so shell line editing was packed onto the Esc/^C swipes.
//
// It used to be two rows and held a keyboard toggle and Enter. The dock now appears only
// while the soft keyboard is up, so neither is needed - a double tap on the screen opens
// the keyboard, and Enter is on the phone keyboard. That slot became newline.
const KB_TOP = [
  [
    // s was k:ctrlg (Unix cancel), but Windows PSReadLine has no such binding -> undo instead
    { c: "k:esc", l: "Esc", n: "k:ctrll", s: "k:ctrlz", wd: 0.95, cls: "fn" },
    { c: "k:tab", l: "Tab", n: "k:shifttab", wd: 0.95, cls: "fn" },
    // Ctrl is a real modifier - tap and the next key becomes Ctrl+key. Double tap locks.
    // The swipe combos target Windows PSReadLine; the upstream wezterm-web set assumed Unix,
    // where half of them (Ctrl+U/E/D/O) are simply unbound here.
    // Unix Ctrl+U (clear whole line) is Escape (RevertLine) on Windows.
    // Shift is a 3-state modifier like Ctrl (tap = one-shot / double tap = lock / again = off).
    //   With no character rows it is not for capitals but for special-key combos:
    //     Shift+Tab (move backwards), Shift+arrows, Shift+Enter (newline).
    //   The sequences live in `KEY_SEQ` in app.js under `shift*` names.
    { c: "a:shift", l: "⇧", wd: 0.85, cls: "fn" },
    { c: "a:ctrl", l: "Ctrl", cls: "fn",
      n: "k:ctrlc",   s: "k:ctrld",      // interrupt / EOF
      w: "k:home",    e: "k:end",        // line start / line end
      nw: "k:ctrlr",  ne: "k:ctrlz",     // history search / undo
      sw: "k:esc",    se: "k:ctrlw" },   // clear whole line / delete word
    // Alt is not a key bound for the terminal but an app function (pane zoom/move, tab switch).
    // It mirrors the PC `Alt+digit`/`Alt+arrow`/`Alt+X` layer; phones have no Alt key, so the
    // app functions are called directly through `a:app:*`.
    { c: "a:app:unzoom", l: "Alt", cls: "fn",
      w: "a:app:pane:-1", e: "a:app:pane:1",     // previous / next pane
      n: "a:app:zoomCur", s: "a:app:close",      // zoom current pane / close (asks first)
      nw: "a:app:tab:-1", ne: "a:app:tab:1",     // previous / next tab
      sw: "a:app:zoom:1", se: "a:app:zoom:2" },  // fullscreen pane 1 / pane 2
    // Long press first used `k:pgup`, which never scrolled anything - `k:*` sends a key to the
    // terminal, while the scrollback belongs to xterm. Use `a:app:scroll` instead (same family
    // as the Alt layer). Home/End really are terminal keys that move the cursor, so `k:*` fits.
    { c: "k:left",  l: "←", lp: "k:home",          wd: 0.8, cls: "fn nav2" },   // hold = line start
    { c: "k:up",    l: "↑", lp: "a:app:scroll:-1", wd: 0.8, cls: "fn nav2" },   // hold = one page up
    { c: "k:down",  l: "↓", lp: "a:app:scroll:1",  wd: 0.8, cls: "fn nav2",
      s: "a:app:bottom" },                                             // swipe down = jump to bottom
    { c: "k:right", l: "→", lp: "k:end",           wd: 0.8, cls: "fn nav2" },   // hold = line end
    // Newline - moves to the next line without submitting.
    //   claude uses Shift+Enter for that, but a terminal has no Shift+Enter signal
    //   (which is why iTerm2 and VSCode install their own keybinding). claude's on-screen
    //   hint offers `ctrl+j for newline` instead, and Ctrl+J is just linefeed (0x0A),
    //   so it works in any terminal - this is what fixed newlines on the phone.
    { c: "k:ctrlj", l: "↵", cls: "fn act" },
    // Paste - a phone has no way to produce Ctrl+V. Ctrl here is a real modifier, but the
    //   character rows it would combine with are gone, and whatever the phone keyboard types
    //   lands straight in xterm's textarea, never meeting our Ctrl state. Hence a dedicated key.
    //   It is an app action, not a terminal key: it reads the clipboard and wraps it in a
    //   bracketed paste. Sending 0x16 via `k:ctrlv` makes claude read it as `chat:imagePaste`
    //   and no text arrives.
    //   Tap = phone clipboard first / swipe up = PC clipboard first (an image yields a PNG path).
    { c: "a:app:paste", l: "📋", n: "a:app:pastePC", wd: 0.8, cls: "fn" },
    // File upload - sends a file picked on the phone to a temp folder on the PC and pastes
    //   its path (for handing claude a photo, log or document). Same idea as paste: raw bytes
    //   cannot be sent, so a path stands in.
    { c: "a:app:upload", l: "📎", wd: 0.8, cls: "fn" },
  ],
];

// There are no character rows - the phone keyboard types into the terminal directly
// (instantly, thanks to the direct PTY connection). KB_EN / KB_KO / KB_SYM (three layers,
// about 110 lines) and a bottom row (space, en/ko toggle, submit, Enter) used to exist,
// backed by the 2-beolsik composer in keyboard.js, but they sat disabled behind
// `KB_SPECIAL_ONLY` as dead code and were deleted on 2026-08-20.
// The originals remain in wezterm-web and `_backup/`.
const KB_BOTTOM = [];

const KB_LAYERS = { en: [] };   // no character layers (special-key bar only)
