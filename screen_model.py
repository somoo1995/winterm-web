"""
webterm - the screen model: one pyte terminal whose scrolled-off rows are kept as rendered text.

Shared by the session daemon (which keeps one per session from the first byte, so a reconnect
is always exact) and the web server (`mirror.Hub`, the fallback for a daemon that predates it).
It imports nothing from either side, so the daemon can load it without the web server's modules.

pyte is LGPL-3.0 and used as an installed dependency only - never copy it into this repo.
If it is missing, AVAILABLE is False and both sides fall back to replaying the ring buffer.
"""
import collections
import re

try:
    import pyte
    from pyte import graphics
    from pyte.screens import Margins
    AVAILABLE = True
except ImportError:                     # an install that skipped requirements.txt
    pyte = None
    AVAILABLE = False

HISTORY_LINES = 5000            # per session. ~1-2MB as rendered strings (measured)

# Same boundary as app.js `REPAINT_MARK`: the first thing ConPTY sends after a resize is a full
# repaint, so a new size takes effect exactly there. Bytes before it were laid out for the old size.
REPAINT_MARK = re.compile(r"\x1b\[H\x1b\[2K|\x1b\[2J")

# Sequences pyte misreads, removed before it sees them. None of them draws anything:
#   CSI with a private marker < > =   keyboard protocols and queries. pyte ignores the marker, so
#                                     claude's `ESC[>4m` (modifyOtherKeys) became SGR 4: every cell
#                                     after it underlined, and the snapshot handed the browser an
#                                     underline that ConPTY never turns off (2026-09-29). `ESC[<u`
#                                     and `ESC[=1;1u` were printed as text.
#   CSI with ':' sub-parameters       `ESC[4:3m` (curly underline), `ESC[38:2::r:g:bm`: pyte prints
#                                     the part after the colon. Dropping them costs a styling detail.
_UNSEEN = re.compile(r"\x1b\[[<>=][0-9;:]*[ -/]*[@-~]|\x1b\[[0-9;]*:[0-9;:]*[ -/]*[@-~]")
# An escape sequence cut by a chunk boundary. Held back until the rest arrives, so the filter
# above always sees whole sequences.
_OPEN_TAIL = re.compile(r"\x1b(?:\[[0-?]*[ -/]*)?$")

# DECSET/DECRST. pyte has no alternate screen: it ignored `ESC[?1049h`, so a full-screen app
# (claude with `"tui": "fullscreen"`, vim, less) drew over the main screen, and a snapshot handed
# the browser a normal buffer - a phone that reconnected scrolled 15 rows of leftovers instead of
# the app (2026-09-30). The alternate-screen modes are taken out before pyte sees them and
# switch screens in `Mirror` instead; the other modes in the same sequence still go to pyte.
_DECSET = re.compile(r"\x1b\[\?([0-9;]*)([hl])")
_ALT_MODES = ("47", "1047", "1049")

# Bumped when the model's behaviour changes in a way the web server has to know about.
# 2: the sequences above are filtered. A daemon reporting 1 (or nothing) still carries the
#    underline bug, and the web server strips underline from its snapshots.
# 3: the alternate screen is modelled (snapshot re-enters it), and `text` can add history.
MODEL_VERSION = 3

# DEC private modes a snapshot must re-establish. They change what the browser SENDS (cursor
# keys, bracketed paste, mouse, focus), so a restored screen without them types wrong -
# the Home/End and pasted-image-path incidents both came from a mode xterm never learned.
# The resets go out before the sets: in xterm, resetting ANY of 1000/1002/1003 turns mouse
# reporting off altogether, so `1000h 1002h 1003l` (an app that never asked for 1003) left the
# browser with no mouse, and a phone's scroll came out as arrow keys (2026-09-30).
_PRIVATE_MODES = (1, 1000, 1002, 1003, 1004, 1006, 2004)


def _private_modes(s):
    on = [m for m in _PRIVATE_MODES if (m << 5) in s.mode]
    off = [m for m in _PRIVATE_MODES if (m << 5) not in s.mode]
    return "".join(f"\x1b[?{m}l" for m in off) + "".join(f"\x1b[?{m}h" for m in on)

_FG, _BG = {}, {}
if AVAILABLE:
    _FG = {v: k for k, v in graphics.FG_ANSI.items()}
    _FG.update({v: k for k, v in graphics.FG_AIXTERM.items()})
    _BG = {v: k for k, v in graphics.BG_ANSI.items()}
    _BG.update({v: k for k, v in graphics.BG_AIXTERM.items()})


def _color(c, fg):
    """pyte color (name or 6-digit hex) -> SGR parameters, or None for the default."""
    if c == "default":
        return None
    table = _FG if fg else _BG
    if c in table:
        return str(table[c])
    if len(c) == 6:
        try:
            r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
        except ValueError:
            return None
        return f"{38 if fg else 48};2;{r};{g};{b}"
    return None


_SGR_CACHE = {}


def _sgr(ch):
    """SGR for a cell's attributes. Cached: a screen uses a handful of attribute sets, and
    building the string per cell was a third of the cost of turning a row into history."""
    key = ch[1:]                      # everything but the glyph
    s = _SGR_CACHE.get(key)
    if s is None:
        if len(_SGR_CACHE) > 4096:    # truecolor output could grow this without bound
            _SGR_CACHE.clear()
        s = _SGR_CACHE[key] = _build_sgr(ch)
    return s


def _build_sgr(ch):
    parts = ["0"]
    if ch.bold:
        parts.append("1")
    if ch.italics:
        parts.append("3")
    if ch.underscore:
        parts.append("4")
    if ch.blink:
        parts.append("5")
    if ch.reverse:
        parts.append("7")
    if ch.strikethrough:
        parts.append("9")
    f = _color(ch.fg, True)
    if f:
        parts.append(f)
    b = _color(ch.bg, False)
    if b:
        parts.append(b)
    return "\x1b[" + ";".join(parts) + "m"


def render_line(line, cols):
    """One pyte row -> text with SGR. Trailing default blanks are dropped."""
    # Only the cells that exist - a pyte row is a sparse dict and missing cells are blank
    # (dict.get / iteration never trigger its __missing__, so nothing is inserted).
    xs = sorted(x for x in line if x < cols)
    while xs:
        ch = line[xs[-1]]
        if ch.data in (" ", "") and ch.bg == "default" and not ch.reverse:
            xs.pop()
        else:
            break
    out, cur, nxt = [], "\x1b[0m", 0
    for x in xs:
        ch = line[x]
        if ch.data == "":             # right half of a wide glyph
            nxt = x + 1
            continue
        if x > nxt:                   # a gap of missing (blank, default) cells
            if cur != "\x1b[0m":
                out.append("\x1b[0m")
                cur = "\x1b[0m"
            out.append(" " * (x - nxt))
        s = _sgr(ch)
        if s != cur:
            out.append(s)
            cur = s
        out.append(ch.data)
        nxt = x + 1
    if cur != "\x1b[0m":
        out.append("\x1b[0m")
    return "".join(out)


class MirrorScreen(pyte.Screen if AVAILABLE else object):
    """A pyte screen whose scrolled-off rows are kept as rendered strings."""

    def __init__(self, columns, lines, history=HISTORY_LINES):
        self.history = collections.deque(maxlen=history)
        super().__init__(columns, lines)

    def _push(self, y):
        self.history.append(render_line(self.buffer[y], self.columns))

    def index(self):
        top, bottom = self.margins or Margins(0, self.lines - 1)
        if self.cursor.y == bottom and top == 0:     # a real scroll, not one inside a region
            self._push(0)
        super().index()

    def erase_in_display(self, how=0, *args, **kwargs):
        if how == 3:                                 # ED 3 = clear scrollback
            self.history.clear()
        super().erase_in_display(how, *args, **kwargs)

    def resize(self, lines=None, columns=None):
        lines = lines or self.lines
        if lines < self.lines:
            # pyte drops rows off the top on a shrink; they belong in history, not in the bin
            for y in range(self.lines - lines):
                self._push(y)
        super().resize(lines, columns)


def _margins(s):
    """DECSTBM restoring `s`'s scroll region - `ESC[r` (the whole screen) when it has none."""
    if s.margins and (s.margins.top, s.margins.bottom) != (0, s.lines - 1):
        return f"\x1b[{s.margins.top + 1};{s.margins.bottom + 1}r"
    return "\x1b[r"


_SGR_ONLY = re.compile(r"\x1b\[[0-9;]*m")


class Mirror:
    """The screen model of one session, plus the pending-size rule shared with app.js.

    Two screens, as in xterm: `main` keeps the history, `alt` exists only while a full-screen app
    has switched to the alternate screen. `screen` is whichever one output goes to now. Modes and
    cursor visibility are the terminal's, not a screen's, so they follow every switch."""

    def __init__(self, cols, rows, history=HISTORY_LINES):
        self.main = MirrorScreen(cols, rows, history)
        self._main_stream = pyte.Stream(self.main)
        self.alt = None
        self.screen = self.main
        self.stream = self._main_stream
        self.pending = None
        self._carry = ""

    @property
    def size(self):
        return self.main.columns, self.main.lines

    def resize(self, cols, rows):
        if (cols, rows) == self.size:
            self.pending = None
        else:
            self.pending = (cols, rows)

    def flush_pending(self):
        if self.pending:
            c, r = self.pending
            self.pending = None
            self.main.resize(r, c)
            if self.alt:
                self.alt.resize(r, c)

    def feed(self, data):
        data = self._carry + data
        self._carry = ""
        t = _OPEN_TAIL.search(data)
        if t and len(data) - t.start() < 64:
            self._carry = data[t.start():]
            data = data[:t.start()]
        data = _UNSEEN.sub("", data)
        if not data:
            return
        pos = 0
        for m in _DECSET.finditer(data):
            params = m.group(1).split(";")
            alt = [p for p in params if p in _ALT_MODES]
            if not alt:
                continue
            self._feed_screen(data[pos:m.start()])
            rest = [p for p in params if p not in _ALT_MODES]
            if rest:
                self._feed_screen(f"\x1b[?{';'.join(rest)}{m.group(2)}")
            self._switch(alt[-1], m.group(2) == "h")
            pos = m.end()
        self._feed_screen(data[pos:])

    def _feed_screen(self, data):
        if not data:
            return
        if self.pending:
            m = REPAINT_MARK.search(data)
            if m:
                if m.start():
                    self.stream.feed(data[:m.start()])
                self.flush_pending()
                data = data[m.start():]
        self.stream.feed(data)

    def _switch(self, mode, on):
        """Enter (`on`) or leave the alternate screen. 1049 also saves/restores the main cursor.

        The alternate screen starts blank each time it is entered (xterm clears it for 1049 and
        1047; for 47 it would keep the old contents, which no app relies on)."""
        main = self.main
        if on:
            if self.alt is not None:
                return                              # already there - xterm ignores it too
            if mode == "1049":
                main.save_cursor()
            alt = pyte.Screen(main.columns, main.lines)
            alt.mode = main.mode                    # one set of modes for the terminal
            alt.cursor.x, alt.cursor.y = main.cursor.x, main.cursor.y
            alt.cursor.attrs = main.cursor.attrs
            alt.cursor.hidden = main.cursor.hidden
            self.alt = alt
            self.screen = alt
            self.stream = pyte.Stream(alt)
        else:
            alt = self.alt
            if alt is None:
                return
            main.mode = alt.mode                    # a reset inside the alt screen replaced the set
            self.alt = None
            self.screen = main
            self.stream = self._main_stream
            if mode == "1049":
                main.restore_cursor()
            main.cursor.hidden = alt.cursor.hidden

    def snapshot(self):
        """Everything a blank xterm of this size needs to look exactly like the model.

        With the alternate screen active, the main screen is drawn first and then entered the
        way the app did (`ESC[?1049h`), so the browser also has the right screen to return to."""
        main = self.main
        out = ["\x1b[0m"]
        for ln in main.history:
            out.append(ln)
            out.append("\r\n")
        for y in range(main.lines):
            out.append(render_line(main.buffer[y], main.columns))
            if y < main.lines - 1:
                out.append("\r\n")
        s = main
        if self.alt is not None:
            out.append(_margins(main))
            c = main.cursor
            out.append(f"\x1b[{c.y + 1};{c.x + 1}H")   # saved by the 1049h below, as the app's was
            out.append(_sgr(c.attrs))
            out.append("\x1b[?1049h")
            s = self.alt
            # Absolute rows: in the alternate screen a newline on the last row would scroll it.
            for y in range(s.lines):
                row = render_line(s.buffer[y], s.columns)
                if row:
                    out.append(f"\x1b[{y + 1};1H{row}")
        out.append(_margins(s))
        c = s.cursor
        out.append(f"\x1b[{c.y + 1};{c.x + 1}H")
        out.append(_sgr(c.attrs))
        out.append(_private_modes(s))
        out.append("\x1b[?7h" if pyte.modes.DECAWM in s.mode else "\x1b[?7l")
        out.append("\x1b[?25l" if c.hidden else "\x1b[?25h")
        return "".join(out)

    def text(self, history=0):
        """-> (plain text a person would read, alternate screen active?).

        The rows on screen now, preceded by up to `history` rows of scrollback (-1 = all of it).
        A full-screen app has no scrollback of its own: while the alternate screen is up, the
        main screen's history is not what anyone sees, so it is left out."""
        rows = [ln.rstrip() for ln in self.screen.display]
        if self.alt is None and history:
            h = list(self.main.history)
            if history > 0:
                h = h[-history:]
            rows = [_SGR_ONLY.sub("", ln).rstrip() for ln in h] + rows
        return "\n".join(rows), self.alt is not None


# -- Driving a model from the daemon ---------------------------------------------------------
#
# The daemon reads each PTY on its own thread and relays on an asyncio loop. The model gets a
# third place: one worker thread per session, fed through an ordered queue. Parsing on the PTY
# reader thread would slow the read itself (ConPTY backs up and every client lags); parsing on
# the loop would stall the relay - the web server's first mirror did exactly that (ping p90
# 443ms under a 100KB/s burst). A thread still shares the GIL, but the interpreter hands it
# over every few ms, so neither the reader nor the loop waits for a whole chunk to be parsed.

import logging
import threading
import concurrent.futures

_log = logging.getLogger("webterm.screen_model")

MODEL_BACKLOG_MAX = 8 * 1024 * 1024   # chars waiting for the parser before the model resets
COALESCE_MAX = 64 * 1024              # chars of queued output merged into one feed
SIZE_FALLBACK = 1.6                   # seconds - as app.js: no repaint seen, apply the size anyway


class ThreadedModel:
    """A Mirror owned by a worker thread. Every call is safe from any thread.

    Order is the whole contract: output, sizes and snapshot requests are applied in the order
    they were queued. The daemon queues output and registers a subscriber under one lock, so a
    snapshot is the model after exactly the chunks that subscriber will never receive live.
    """

    def __init__(self, cols, rows, name=""):
        self._mirror = Mirror(cols, rows)
        self._work = collections.deque()
        self._chars = 0
        self._cv = threading.Condition()
        self._closed = False
        self._timer = None
        self._name = name
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"model-{name}")
        self._thread.start()

    # ---------- producers ----------
    def _put(self, item):
        with self._cv:
            if self._closed:
                return
            if item[0] == "out":
                self._chars += len(item[1])
                if self._chars > MODEL_BACKLOG_MAX:
                    # The parser cannot keep up at all. Drop the queued output and start over:
                    # ConPTY's next repaint refills the visible rows, only this burst's history is lost.
                    _log.warning("model backlog over %d chars (%s) - reset", MODEL_BACKLOG_MAX, self._name)
                    self._work = collections.deque(w for w in self._work if w[0] != "out")
                    self._work.append(("reset",))
                    self._chars = 0
                    self._cv.notify()
                    return
            self._work.append(item)
            self._cv.notify()

    def push(self, data):
        self._put(("out", data))

    def resize(self, cols, rows):
        self._put(("size", cols, rows))
        if self._timer:
            self._timer.cancel()
        self._timer = threading.Timer(SIZE_FALLBACK, lambda: self._put(("flush",)))
        self._timer.daemon = True
        self._timer.start()

    def request_snapshot(self):
        """-> concurrent.futures.Future of (snapshot, (cols, rows), pending or None)."""
        fut = concurrent.futures.Future()
        self._put(("snap", fut))
        if self._closed and not fut.done():
            fut.set_exception(RuntimeError("model closed"))
        return fut

    def request_text(self, history=0):
        """-> concurrent.futures.Future of (text, alternate screen active?) - see Mirror.text."""
        fut = concurrent.futures.Future()
        self._put(("text", fut, history))
        if self._closed and not fut.done():
            fut.set_exception(RuntimeError("model closed"))
        return fut

    def close(self):
        with self._cv:
            self._closed = True
            pending = [w for w in self._work if w[0] in ("snap", "text")]
            self._work.clear()
            self._cv.notify()
        for w in pending:
            if not w[1].done():
                w[1].set_exception(RuntimeError("model closed"))
        if self._timer:
            self._timer.cancel()

    # ---------- the worker ----------
    def _take(self):
        with self._cv:
            while not self._work and not self._closed:
                self._cv.wait()
            if self._closed:
                return None
            item = self._work.popleft()
            if item[0] == "out":
                # Coalesce the run of output behind it: a burst arrives as thousands of tiny
                # chunks (2,200/s averaging 44 chars, measured) and per-item overhead adds up.
                parts, n = [item[1]], len(item[1])
                while self._work and self._work[0][0] == "out" and n < COALESCE_MAX:
                    nxt = self._work.popleft()[1]
                    parts.append(nxt)
                    n += len(nxt)
                self._chars -= n
                item = ("out", "".join(parts))
            return item

    def _feed(self, data):
        try:
            self._mirror.feed(data)
        except Exception as e:
            # Clients are served the raw stream, not the model: a sequence pyte chokes on may
            # cost the model's accuracy, never the live view.
            cols, rows = self._mirror.size
            _log.warning("model feed error (%s): %s - reset at %dx%d", self._name, e, cols, rows)
            self._mirror = Mirror(cols, rows)

    def _run(self):
        while True:
            item = self._take()
            if item is None:
                return
            kind = item[0]
            try:
                if kind == "out":
                    self._feed(item[1])
                elif kind == "size":
                    self._mirror.resize(item[1], item[2])
                elif kind == "flush":
                    self._mirror.flush_pending()
                elif kind == "reset":
                    cols, rows = self._mirror.pending or self._mirror.size
                    self._mirror = Mirror(cols, rows)
                elif kind == "snap":
                    m = self._mirror
                    item[1].set_result((m.snapshot(), m.size, m.pending))
                elif kind == "text":
                    item[1].set_result(self._mirror.text(item[2]))
            except Exception as e:
                _log.warning("model error (%s, %s): %s", self._name, kind, e)
                if kind in ("snap", "text") and not item[1].done():
                    item[1].set_exception(e)
