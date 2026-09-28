"""
webterm - restoring a reconnecting browser from a screen model (the tmux model for reconnects).

Why this exists:
    A browser used to be restored by REPLAYING the daemon's ring buffer - up to 2MB of raw
    output, much of it laid out for widths the terminal no longer has. Replayed into the
    current width it came out as duplicated paragraphs and words dropped to the start of a
    line (2026-09-23). No trick on the app side fixes that: measured on 2026-09-28, claude
    never re-prints history that has scrolled off - not on a row change, not on a column
    change (100 -> 180 either), not on Ctrl+L, not on Ctrl+O.

    So a screen is kept instead of a stream: a pyte terminal (screen_model.py) fed every byte
    as it happens, at the size the PTY had at that moment. A browser that attaches gets that
    screen - history plus the current rows - drawn once, then the live stream from exactly the
    point the snapshot was taken.

Where the model lives - two sources behind one surface (`open_view`):
    DaemonView  the daemon keeps the model per session (session.py). Survives web server
                restarts; the web server is a pure relay again.
    Hub         fallback for a daemon that predates that: this server keeps one model per
                session and fans out itself. A server restart rebuilds it from the ring buffer
                and drops that history, so a restart cuts the scrollback.

Cost, measured on 8 live sessions: 0.6-1.6MB per session; pyte parses ~0.6-1.6MB/s depending
on the output; under a 100KB/s burst the Hub costs ~+18% of a core over plain relaying.
"""
import asyncio
import collections
import logging
import time

import daemon_client as dc
from screen_model import Mirror

log = logging.getLogger("webterm.mirror")

MODEL_SLICE = 1024               # chars parsed per event-loop turn (a few ms of pyte at worst)
MODEL_BACKLOG_MAX = 8 * 1024 * 1024   # chars waiting for the parser before the model resets
COALESCE_MAX = 64 * 1024        # chars of queued output merged into one feed
PUMP_YIELD = 0.002              # seconds the relay may run before giving the event loop away
SUB_QUEUE_MAX = 4096            # chunks a browser may lag behind before it is made to resync
SIZE_FALLBACK = 1.6             # seconds - same as app.js: no repaint seen, apply the size anyway

# Queue item telling a browser socket to close and reconnect (it comes back with a fresh
# snapshot). An object, not a string: a shell can print any string, "resync" included.
RESYNC = object()

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


class DaemonView:
    """One browser's own daemon attach, restored from the DAEMON's screen model.

    The daemon keeps the model from a session's first byte (session.py), so it survives web
    server restarts - which the Hub cannot: a restarted Hub has to rebuild from the ring
    buffer, and that rebuild was either the staircase again or history thrown away
    (2026-09-28: a 2,166-row scrollback cut at the restart). With this, the web server is back
    to a pure relay: one attach per browser, fan-out in the daemon.

    Same surface as Hub for `ws_term`: subscribe / unsubscribe / input / resize / clients.
    """

    def __init__(self, sid):
        self.sid = sid
        self.att = dc.Attach(sid)
        self._task = None

    async def open(self):
        """-> True when the daemon answered with a snapshot, False when it is too old to."""
        info = await self.att.open(snapshot=True)
        return bool((info or {}).get("snapshot"))

    async def subscribe(self):
        events = self.att.events()
        kind, m = await asyncio.wait_for(events.__anext__(), 30)
        if kind != "snap":
            raise dc.DaemonDown(f"expected a snapshot, got {kind!r}")
        q = asyncio.Queue()

        async def pump():
            ended = False
            try:
                async for kind, data in events:
                    if kind == "end":
                        ended = True
                        break
                    if kind == "out":
                        q.put_nowait(data)
            except Exception as e:
                log.info("daemon view error sid=%s: %s", self.sid, e)
            # A real end tells the browser to stop (4000); a lost connection makes it reconnect.
            q.put_nowait(None if ended else RESYNC)

        self._task = asyncio.create_task(pump())
        pending = m.get("pending")
        return q, m.get("data", ""), (m.get("cols"), m.get("rows")), tuple(pending) if pending else None

    def unsubscribe(self, q):
        if self._task:
            self._task.cancel()
        self.att.close()

    @property
    def clients(self):
        return 0          # the daemon counts its own attaches; /api/sessions passes that through

    async def input(self, data):
        await self.att.input(data)

    async def resize(self, cols, rows, model=True):
        await self.att.resize(cols, rows, model=model)


_daemon_mirror = {"at": 0.0, "value": None}


async def _daemon_has_mirror():
    """Does the running daemon keep screen models? Cached briefly - asked on every attach."""
    now = time.monotonic()
    if _daemon_mirror["value"] is not None and now - _daemon_mirror["at"] < 10:
        return _daemon_mirror["value"]
    try:
        res = await dc.request({"op": "ping"}, timeout=3)
        value = bool((res.get("result") or {}).get("mirror"))
    except Exception:
        value = False
    _daemon_mirror.update(at=now, value=value)
    return value


async def open_view(sid):
    """The source a browser on `sid` is restored from and relayed through.

    A daemon with screen models (after the daemon restart that loads session.py with them):
    the browser gets its own DaemonView. An older daemon: the shared Hub, which keeps the
    model here in the web server. Raises dc.DaemonDown if there is no such session."""
    if await _daemon_has_mirror():
        v = DaemonView(sid)
        try:
            if await v.open():
                return v
        except Exception:
            v.att.close()
            raise
        v.att.close()                    # the ack said no snapshot after all - fall back
        _daemon_mirror.update(at=time.monotonic(), value=False)
    return await get_hub(sid)


def clients(sid):
    """Browsers on a Hub, or None when there is no Hub (the daemon's own count is then right)."""
    h = _hubs.get(sid)
    return h.clients if h else None
