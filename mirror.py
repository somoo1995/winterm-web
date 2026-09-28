"""
webterm - server-side screen mirror (the tmux model for reconnects).

Why this exists:
    A browser used to be restored by REPLAYING the daemon's ring buffer - up to 2MB of raw
    output, much of it laid out for widths the terminal no longer has. Replayed into the
    current width it came out as duplicated paragraphs and words dropped to the start of a
    line (2026-09-23). No trick on the app side fixes that: measured on 2026-09-28, claude
    never re-prints history that has scrolled off - not on a row change, not on a column
    change (100 -> 180 either), not on Ctrl+L. Only ConPTY's repaint of the visible rows.

    So the server keeps the SCREEN instead of the stream: one pyte terminal per session is
    fed every byte as it happens, at the size the PTY had at that moment. A browser that
    attaches gets that screen - history plus the current rows - drawn once, then the live
    stream from exactly the point the snapshot was taken.

    [daemon] --raw--> [Hub: pyte model] --snapshot, then raw--> [browser, browser, ...]

Cost, measured on the ring buffers of 8 live sessions (0.4-2.3MB each):
    - memory 0.6-1.6MB per session - history is kept as rendered strings, not pyte cells
      (pyte's own HistoryScreen keeps one object per cell)
    - pyte parses ~1.6MB/s; live output is far below that, but seeding a fresh hub from a
      2MB ring buffer takes ~1.3s, so the seed is fed in slices that yield to the event loop
    - a snapshot takes 8-17ms to build

pyte is LGPL-3.0 and used as an installed dependency only - never copy it into this repo.
"""
import asyncio
import collections
import logging
import re
import time

import pyte
from pyte import graphics
from pyte.screens import Margins

import daemon_client as dc

log = logging.getLogger("webterm.mirror")

HISTORY_LINES = 5000            # per session. ~1-2MB as rendered strings (measured)
MODEL_SLICE = 1024               # chars parsed per event-loop turn (a few ms of pyte at worst)
MODEL_BACKLOG_MAX = 8 * 1024 * 1024   # chars waiting for the parser before the model resets
COALESCE_MAX = 64 * 1024        # chars of queued output merged into one feed
PUMP_YIELD = 0.002              # seconds the relay may run before giving the event loop away
SUB_QUEUE_MAX = 4096            # chunks a browser may lag behind before it is made to resync
SIZE_FALLBACK = 1.6             # seconds - same as app.js: no repaint seen, apply the size anyway

# Queue item telling a browser socket to close and reconnect (it comes back with a fresh
# snapshot). An object, not a string: a shell can print any string, "resync" included.
RESYNC = object()

# Same boundary as app.js `REPAINT_MARK`: the first thing ConPTY sends after a resize is a full
# repaint, so a new size takes effect exactly there. Bytes before it were laid out for the old size.
REPAINT_MARK = re.compile(r"\x1b\[H\x1b\[2K|\x1b\[2J")

# DEC private modes a snapshot must re-establish. They change what the browser SENDS (cursor
# keys, bracketed paste, mouse, focus), so a restored screen without them types wrong -
# the Home/End and pasted-image-path incidents both came from a mode xterm never learned.
_PRIVATE_MODES = (1, 1000, 1002, 1003, 1004, 1006, 2004)

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


class MirrorScreen(pyte.Screen):
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


class Mirror:
    """The screen model of one session, plus the pending-size rule shared with app.js."""

    def __init__(self, cols, rows, history=HISTORY_LINES):
        self.screen = MirrorScreen(cols, rows, history)
        self.stream = pyte.Stream(self.screen)
        self.pending = None

    @property
    def size(self):
        return self.screen.columns, self.screen.lines

    def resize(self, cols, rows):
        if (cols, rows) == self.size:
            self.pending = None
        else:
            self.pending = (cols, rows)

    def flush_pending(self):
        if self.pending:
            c, r = self.pending
            self.pending = None
            self.screen.resize(r, c)

    def feed(self, data):
        if self.pending:
            m = REPAINT_MARK.search(data)
            if m:
                if m.start():
                    self.stream.feed(data[:m.start()])
                self.flush_pending()
                data = data[m.start():]
        self.stream.feed(data)

    def snapshot(self):
        """Everything a blank xterm of this size needs to look exactly like the model."""
        s = self.screen
        out = ["\x1b[0m"]
        for ln in s.history:
            out.append(ln)
            out.append("\r\n")
        for y in range(s.lines):
            out.append(render_line(s.buffer[y], s.columns))
            if y < s.lines - 1:
                out.append("\r\n")
        if s.margins and (s.margins.top, s.margins.bottom) != (0, s.lines - 1):
            out.append(f"\x1b[{s.margins.top + 1};{s.margins.bottom + 1}r")
        c = s.cursor
        out.append(f"\x1b[{c.y + 1};{c.x + 1}H")
        out.append(_sgr(c.attrs))
        for m in _PRIVATE_MODES:
            out.append(f"\x1b[?{m}{'h' if (m << 5) in s.mode else 'l'}")
        out.append("\x1b[?7h" if pyte.modes.DECAWM in s.mode else "\x1b[?7l")
        out.append("\x1b[?25l" if c.hidden else "\x1b[?25h")
        return "".join(out)

    def text(self):
        """The current screen as plain text (what a person would read)."""
        return "\n".join(ln.rstrip() for ln in self.screen.display)


class Hub:
    """One daemon attach per session, shared by every browser on it.

    Before this, each browser WS had its own daemon attach and the daemon fanned out. Now the
    web server holds the only attach, keeps the model current even while nobody is watching,
    and fans out itself - which is what lets a new browser start from the model instead of
    from the ring buffer.

    Two tasks, on purpose:
      _pump   daemon -> browsers, at once. Never parses anything.
      _model  the same chunks -> pyte, in slices, yielding to the event loop between them.

    The first version fed pyte inline in `_pump`, and under a burst (100KB/s of output) the
    event loop was held for hundreds of ms at a time: ping p90 went 0.8ms -> 443ms, max 627ms
    (measured against the old server on the same daemon). Keystrokes and every other session
    waited behind the parser. Now the parser only gets the loop between slices.

    Ordering is kept by a work queue: output, size changes and snapshot requests go in the
    order they happened, so a snapshot is the model after exactly the chunks broadcast before
    the subscriber was registered - even when the model is running behind.
    """

    def __init__(self, sid):
        self.sid = sid
        self.att = dc.Attach(sid)
        self.mirror = None
        self.subs = set()              # asyncio.Queue per browser
        self.ready = asyncio.Event()
        self.alive = True
        self.task = None
        self._model_task = None
        self._work = collections.deque()
        self._work_chars = 0
        self._wake = asyncio.Event()
        self._flush_h = None

    async def start(self):
        info = await self.att.open()
        sess = (info or {}).get("session") or {}
        self.mirror = Mirror(int(sess.get("cols") or 120), int(sess.get("rows") or 30))
        self._model_task = asyncio.create_task(self._model())
        self.task = asyncio.create_task(self._pump())
        # The daemon sends its ring buffer as the first event, right after the ack. A fresh
        # session has none, so do not wait for it forever.
        try:
            await asyncio.wait_for(self.ready.wait(), 5.0)
        except asyncio.TimeoutError:
            pass
        if not self.ready.is_set():
            self.ready.set()

    # ---------- the model side ----------
    def _enqueue(self, item):
        if item[0] in ("out", "seed"):
            self._work_chars += len(item[1])
            if self._work_chars > MODEL_BACKLOG_MAX:
                # The parser cannot keep up at all. Rather than let the queue eat memory, drop
                # the pending output and start the model over: ConPTY's next repaint refills
                # the visible rows; only the history of this burst is lost.
                log.warning("mirror backlog over %d chars sid=%s - model reset", MODEL_BACKLOG_MAX, self.sid)
                self._work = collections.deque(w for w in self._work if w[0] not in ("out", "seed"))
                self._work.append(("reset",))
                self._work_chars = 0
                self._wake.set()
                return
        self._work.append(item)
        self._wake.set()

    def _feed(self, data):
        """Feed the model without ever letting a parser error take the hub down.

        The browsers are served the raw stream, not the model, so a sequence pyte chokes on
        must cost at most the model's accuracy - never the live view. On an error the model
        starts over at the same size; ConPTY's next repaint refills the visible rows."""
        try:
            self.mirror.feed(data)
        except Exception as e:
            cols, rows = self.mirror.size
            log.warning("mirror feed error sid=%s (%s) - model reset at %dx%d", self.sid, e, cols, rows)
            self.mirror = Mirror(cols, rows)

    async def _feed_sliced(self, data):
        # A pending size must see the repaint marker whole, so that chunk goes in at once
        # (it is the rare one right after a resize). pyte's parser keeps its state across
        # feeds, so cutting inside an escape sequence is otherwise harmless.
        if self.mirror.pending:
            self._feed(data)
            await asyncio.sleep(0)
            return
        for i in range(0, len(data), MODEL_SLICE):
            self._feed(data[i:i + MODEL_SLICE])
            await asyncio.sleep(0)

    async def _model(self):
        while True:
            if not self._work:
                self._wake.clear()
                await self._wake.wait()
                continue
            item = self._work.popleft()
            kind = item[0]
            try:
                if kind == "out":
                    # Coalesce the run of output chunks waiting behind this one. A burst arrives
                    # as thousands of tiny chunks (measured: 2,200/s averaging 44 chars), and
                    # the per-item overhead cost more CPU than parsing them did.
                    parts = [item[1]]
                    n = len(item[1])
                    while self._work and self._work[0][0] == "out" and n < COALESCE_MAX:
                        nxt = self._work.popleft()[1]
                        parts.append(nxt)
                        n += len(nxt)
                    self._work_chars -= n
                    await self._feed_sliced("".join(parts))
                elif kind == "seed":
                    self._work_chars -= len(item[1])
                    await self._feed_sliced(item[1])
                    # The ring buffer was produced at sizes this model never saw, so its
                    # history is the old staircase all over again (seen right after a server
                    # restart, 2026-09-28). Keep the screen - the kick that follows the first
                    # attach repaints it anyway - and start the history clean.
                    dropped = len(self.mirror.screen.history)
                    self.mirror.screen.history.clear()
                    log.info("mirror seeded sid=%s chars=%d (history from the ring buffer dropped: %d rows)",
                             self.sid, len(item[1]), dropped)
                elif kind == "size":
                    self.mirror.resize(item[1], item[2])
                elif kind == "flush":
                    self.mirror.flush_pending()
                elif kind == "reset":
                    cols, rows = self.mirror.pending or self.mirror.size
                    self.mirror = Mirror(cols, rows)
                elif kind == "snap":
                    fut = item[1]
                    if not fut.done():
                        m = self.mirror
                        fut.set_result((m.snapshot(), m.size, m.pending))
                elif kind == "stop":
                    return
            except Exception as e:
                log.warning("mirror model error sid=%s (%s): %s", self.sid, kind, e)
                if kind == "snap" and not item[1].done():
                    item[1].set_exception(e)

    # ---------- the browser side ----------
    async def _pump(self):
        first = True
        ended = False
        yielded = time.perf_counter()
        quiet = asyncio.get_running_loop().call_later(1.0, self.ready.set)
        try:
            async for kind, data in self.att.events():
                if kind == "end":
                    ended = True
                    break
                if first and not self.subs:
                    # The ring buffer (or the first output of a new shell). No browser can be
                    # subscribed yet - get_hub waits for `ready` - so it goes to the model only.
                    self._enqueue(("seed", data))
                else:
                    self._broadcast(data)
                    self._enqueue(("out", data))
                first = False
                quiet.cancel()
                self.ready.set()
                # readline returns without suspending while data is buffered, so a burst would
                # otherwise run this loop without ever giving the event loop away. Every 2ms,
                # not every chunk: per-chunk yields were measurable CPU at 2,200 chunks/s.
                now = time.perf_counter()
                if now - yielded > PUMP_YIELD:
                    yielded = now
                    await asyncio.sleep(0)
        except Exception as e:
            log.info("mirror pump error sid=%s: %s", self.sid, e)
        finally:
            quiet.cancel()
            self.alive = False
            self.ready.set()
            if _hubs.get(self.sid) is self:
                _hubs.pop(self.sid, None)
            # Only a real end of the session may tell the browsers to stop (4000 = no retry).
            # A lost daemon connection with the session still alive must make them reconnect,
            # which starts a new hub.
            self._broadcast(None if ended else RESYNC)
            self._enqueue(("stop",))           # after any snapshot still waiting in the queue
            self.att.close()
            log.info("mirror closed sid=%s (%s)", self.sid, "session ended" if ended else "connection lost")

    def _broadcast(self, data):
        for q in list(self.subs):
            if data is RESYNC:
                self.subs.discard(q)
                q.put_nowait(RESYNC)
                continue
            if data is not None and q.qsize() >= SUB_QUEUE_MAX:
                # A browser this far behind would need chunks we would have to drop, and a
                # dropped chunk is a permanently wrong screen. Make it reconnect instead: it
                # comes back with a fresh snapshot.
                self.subs.discard(q)
                q.put_nowait(RESYNC)
                continue
            q.put_nowait(data)

    async def subscribe(self):
        """-> (queue, snapshot, size, pending).

        The queue is registered and the snapshot requested in the same event-loop turn: the
        queue gets every chunk from here on, and the model answers the request after exactly
        the chunks before it. Nothing is in both, nothing is in neither."""
        q = asyncio.Queue()
        fut = asyncio.get_running_loop().create_future()
        self.subs.add(q)
        self._enqueue(("snap", fut))
        try:
            snap, size, pending = await asyncio.wait_for(fut, 30)
        except BaseException:
            self.subs.discard(q)
            raise
        return q, snap, size, pending

    def unsubscribe(self, q):
        self.subs.discard(q)

    @property
    def clients(self):
        return len(self.subs)

    # The same two calls as dc.Attach, so the sizing code (`_sync_size`, `_kick`) takes a Hub.
    async def input(self, data):
        await self.att.input(data)

    async def resize(self, cols, rows, model=True):
        """`model=False` for the kick's row flap: the browsers keep their cell count through it
        (server `_kick`), so the model must too. Following it cost one duplicated history row per
        kick - the shrink pushed the top row into history, and the repaint after the regrow
        drew that same row again (measured: 3 kicks -> `105 104 104` in the history)."""
        await self.att.resize(cols, rows)
        if self.mirror is None or not model:
            return
        # Queued, not applied: the model may still be behind, and output it has not parsed
        # yet was laid out for the old size.
        self._enqueue(("size", cols, rows))
        if self._flush_h:
            self._flush_h.cancel()
        self._flush_h = asyncio.get_running_loop().call_later(
            SIZE_FALLBACK, lambda: self._enqueue(("flush",)))

    def text(self):
        return self.mirror.text() if self.mirror else ""


_hubs = {}                    # {sid: Hub}
_hub_locks = {}               # {sid: asyncio.Lock} - two browsers must not start two hubs


async def get_hub(sid):
    """The live hub for `sid`, started on first use. Raises dc.DaemonDown if there is no such session."""
    h = _hubs.get(sid)
    if h and h.alive:
        return h
    lock = _hub_locks.setdefault(sid, asyncio.Lock())
    async with lock:
        h = _hubs.get(sid)
        if h and h.alive:
            return h
        h = Hub(sid)
        _hubs[sid] = h
        try:
            await h.start()
        except Exception:
            _hubs.pop(sid, None)
            raise
        return h


def clients(sid):
    h = _hubs.get(sid)
    return h.clients if h else 0


def peek(sid):
    return _hubs.get(sid)
