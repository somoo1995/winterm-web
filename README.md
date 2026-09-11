# winterm-web

**A Windows shell in your browser — a real terminal, not a screen scraper.**
It holds the ConPTY directly and streams it over a WebSocket, so TUIs, tab-completion,
and colors all work exactly as they would in a native terminal. Open a shell on your PC,
then pick it up from your phone and keep typing in the same session.

> The executable, logs, and API keep the original working name `webterm`.

---

## Requirements

- **Windows 10 1809+ / 11** — ConPTY is required. No other OS is supported.
- **Python 3.12 recommended** (3.10+ works). The only native dependency is `pywinpty`;
  stick to a version that ships a prebuilt wheel — a too-new Python may fall back to a source build.
- Browser: Chrome / Edge family recommended (used for PWA install and Window Controls Overlay).

> Verified on a fresh venv with the current dependency set
> (fastapi 0.141 / starlette 1.6 / anyio 4.15 / websockets 17 / pywinpty 3.0):
> startup, shell execution, and WebSocket all work.

## Install

### One-click (recommended)

**[Download webterm-setup.bat](https://raw.githubusercontent.com/somoo1995/winterm-web/main/webterm-setup.bat)**
→ right-click, "Save link as", then **double-click** it. That's all.

This single file does everything:

1. Downloads the source from GitHub into `%LOCALAPPDATA%\winterm-web`
2. Installs Python 3.12 via winget if it's missing
3. Installs the dependencies
4. **Asks whether to enable autostart on logon** (one keystroke: `y`)
5. Starts the server and opens the browser

When it finishes, a **`winterm-web` shortcut** is placed on your Desktop. It starts the
server if it isn't running and opens the browser, so you can use it that way even without autostart.

To run unattended (no prompt) and enable autostart in one go, from `cmd`:

```
webterm-setup.bat -Autostart
```

| Needs | |
| --- | --- |
| OS | Windows 10 1803+ / 11 (bundled `curl`/`tar`) |
| Privileges | **No admin required** — everything installs per-user |
| Anything else | No. The installer sets up Python too |

To change the install location, from `cmd`: `set WINTERM_DEST=D:\apps\winterm-web` then run it.

To remove: run **`uninstall.bat`** in the install folder — it clears autostart and the
shortcut and stops the server. Delete the folder to remove it completely.

> **Why `.bat` and not `.exe`/`.msi`:** an unsigned installer trips SmartScreen's
> "unknown publisher" warning (a code-signing certificate costs money), and a `.ps1` is
> blocked by PowerShell's execution policy. A `.bat` avoids both.

### From a folder you already have

If you cloned the repo or unzipped it, just double-click **`install.bat`** inside it —
it's the same installer `webterm-setup.bat` calls at the end.

```
install.bat -Autostart      # enable autostart without asking
install.bat -NoAutostart    # skip autostart
install.bat -NoStart        # install only, don't launch
install.bat -NoShortcut     # no Desktop shortcut
```

### Manual

If you want to see exactly what the installer does, or you got stuck.

```powershell
python --version                  # if not 3.12.x, install below
winget install Python.Python.3.12 # then open a NEW PowerShell window
```

```powershell
git clone https://github.com/somoo1995/winterm-web.git
cd winterm-web
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r requirements.txt
```

`Set-ExecutionPolicy` is a one-time step. Under the default `Restricted` policy,
`start.ps1` won't run. No admin required.

Use `python -m pip`, not `pip`: `pip.exe` lives in `Scripts\`, a **separate PATH entry**
that's often left out even when `python` is on PATH. `python -m pip` doesn't rely on PATH.

### Autostart only

```powershell
.\install.bat -Autostart -NoStart
```

Launches on logon after a 30-second delay, windowless (`--no-browser`). The scheduled
task (or Startup-folder shortcut, when a task can't be registered without admin) is named
`WebtermServer`; remove it with `uninstall.bat`.

## ⚠ Security — read this first

**This program hands a shell to the browser. Anyone who can reach it can run anything as you.**

Access control is delegated to the network by design. There is no login screen and no token.

- Default binding is `127.0.0.1` — unreachable from outside that PC.
- To use it from a phone or another device, put it behind a **private network like
  Tailscale**. Being unreachable outside the tailnet is what serves as authentication.
- **Do not set `WEBTERM_HOST` to `0.0.0.0`.** Exposing it on the public internet or an
  office LAN turns it into an unauthenticated remote shell.

### What a private network can't stop — so the code does

An attack from **your own browser** hitting loopback doesn't require the attacker to be
inside your tailnet, so a VPN can't help; the server has to reject it directly. Measured
on an isolated instance:

| Attack | Before the guard | Now |
| --- | --- | --- |
| `Host` spoofing (DNS rebinding) → read sid from `/api/sessions` | 200, sid leaked | **403** |
| Cross-origin WebSocket `/ws/{sid}` | accepted, shell read/write | **403** |
| Cross-origin multipart `POST /api/upload` | 200, file planted | **403** |
| Classic CSRF via `text/plain` on `/api/send` | 422 (already blocked) | 422 |

Tune this with `security.allowedHosts` in `config.json`. The default is
`127.0.0.1` · `localhost` · `[::1]` · `*.ts.net` (Tailscale MagicDNS).
Requests **without an Origin header (curl, scripts) pass through**, so API automation is unaffected.

## Why it exists

The previous approach polled a native terminal (WezTerm) via `get-text` every 1.5s and
mirrored it to the web. A PTY master is owned by a single process, so that design can't go
faster, and anything that reacts instantly to input — slash autocompletion, for one — is
**structurally impossible**.

winterm-web owns the PTY directly, so real-time isn't an achievement; it's the default.

| | Polling mirror | **winterm-web (direct PTY)** |
| --- | --- | --- |
| Key round-trip | 79ms | **0.26ms** |
| Screen update | 229ms + 1.5s poll | **4.6ms** (push) |
| Instant-reaction UI (autocomplete, …) | ❌ impossible by design | ✅ |

## Architecture

```
[session daemon daemon.py]   owns the PTY, stays alive (tmux-server role).  127.0.0.1:8771
      | local TCP (NDJSON)
[web server server.py]       pure relay, holds zero session state.          127.0.0.1:8767
      | HTTP + WebSocket
[browser xterm.js]           close it and the session lives on
```

**The point is that the web server and the daemon are separate.** Edit the code and
restart the web server, and the open shells and their variables survive. Same when you
close the browser — reconnect and the screen is restored from a ring buffer.

## Running

```powershell
.\start.ps1              # (re)start the web server; starts the daemon too if needed -> http://127.0.0.1:8767
.\start.ps1 -Status      # daemon / web server / open sessions
.\start.ps1 -Stop        # stop the web server only (sessions stay alive)
.\start.ps1 -StopAll     # stop the daemon too  (WARNING: kills all open shells)
.\start.ps1 -fg          # foreground (watch the logs)
```

**After editing code, just run `.\start.ps1`** — it leaves the daemon alone, so sessions don't die.

### GUI launcher (optional)

To launch from an icon with no console window, build the exe launcher.

```powershell
.\build.ps1              # generate icon + build exe
.\build.ps1 -Shortcut    # also create a Desktop shortcut
```

```powershell
.\webterm.exe            # start + open the app window  (this is the double-click target)
.\webterm.exe --restart  # restart web server only (sessions kept)
.\webterm.exe --status   # status + open session list
.\webterm.exe --no-browser
.\webterm.exe --install  # open a normal window for PWA install (removes the title bar)
```

The exe is **only a launcher; it does not bundle Python.** You don't need to rebuild after
editing `server.py`/`app.js` — only after editing `launcher.py`. `WEBTERM_PYTHON` /
`WEBTERM_ROOT` override the paths.

## Configuration

`config.default.json` holds the defaults. **Don't edit it** — create `config.json` next to
it and list only what you want to change. `config.json` is `.gitignore`d, so it survives updates.

```jsonc
{
  "defaultCwd": "C:/work",
  "fontSize": 16,
  "keymap": {
    "Ctrl+d": "pane.split.v",   // add a binding
    "Ctrl+]": "pane.split.v",   // override a default
    "Ctrl+n": ""                // disable — the app won't intercept it, it goes to the terminal
  }
}
```

Merging is **per-key**: list three bindings like above and the rest of the defaults stay.
Apply by restarting the web server (`.\start.ps1`) and refreshing the browser.

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultCwd` | `""` (home) | starting folder for new sessions |
| `shell` | `""` | shell to launch; empty means `powershell.exe -NoLogo` |
| `fontSize` | `14.7` | default font size (adjusting it in the browser wins) |
| `security.allowedHosts` | loopback + `*.ts.net` | allowed `Host` values; a leading `*.` is a wildcard |
| `security.allowedOrigins` | `[]` | WebSocket Origin allowlist; empty follows `allowedHosts` |
| `security.enabled` | `true` | master switch for the checks above |
| `keymap` | see below | shortcuts |

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBTERM_PORT` | `8767` | web server port |
| `WEBTERM_DAEMON_PORT` | `8771` | session daemon port |
| `WEBTERM_HOST` | `127.0.0.1` | bind address. **Do not change** (see Security) |
| `WEBTERM_SHELL` | `powershell.exe -NoLogo` | shell to launch; may include arguments |
| `WEBTERM_CWD` | user home | starting folder for new sessions |
| `WEBTERM_ROOT` | (auto-detected) | folder containing `server.py`; needed only if the exe lives elsewhere |
| `WEBTERM_PYTHON` | (auto-detected) | Python executable to use |

> Precedence: **request value → `config.json` → environment variable → default.**
> When both sides set the same thing, `config.json` wins.

## Keybindings

Everything is remappable via `keymap` in `config.json`. In the browser console,
`webterm.actions()` lists the available actions and `webterm.keymap()` shows the current bindings.

| Key | Action | Action name |
| --- | --- | --- |
| `Ctrl+]` / `Ctrl+\` | split pane left-right / top-bottom | `pane.split.h` / `.v` |
| `Ctrl+N` | new tab | `tab.new` |
| `Ctrl+T` / `Ctrl+P` | rename tab / rename pane | `tab.rename` / `pane.rename` |
| `Ctrl+←` `Ctrl+→` / `Ctrl+1~9` | switch tab / go to tab number | `tab.prev` `.next` / `tab.select:N` |
| `Alt+1~9` / `Alt+0` | zoom pane N / unzoom | `pane.zoom:N` / `pane.unzoom` |
| `Alt+←` `Alt+→` | cycle panes (keeps zoom) | `pane.prev` `.next` |
| `Alt+X` | close pane | `pane.close` |
| `Alt+B` | toggle the vertical session rail | `rail.toggle` |
| `Ctrl+Shift+R` or `Alt+R` | refit the screen | `view.refit` |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | font size | `font.inc` `.dec` `.reset` |

`Ctrl+W` (delete word) and `Ctrl+R` (reverse search) are **intentionally not intercepted** —
PSReadLine uses them. Close is `Alt+X` because the browser grabs `Ctrl+W` and its variants
to close the window before the app can react.

## On a phone

Open the same session on your phone. The terminal **content** is shared; only the **shell**
adapts to the device — a phone has no Ctrl/Esc/Tab/arrow keys, so there's a virtual
special-key bar and an 8-direction swipe keyboard.

Edit `static/kb-layout.js` alone to change the key layout.

## HTTP API

Sessions can be driven from scripts. A tab is a session `name`, and **sessions sharing a
`name` are the panes of one tab**.

| Purpose | Endpoint |
| --- | --- |
| Health | `GET /api/health` |
| List sessions / tabs | `GET /api/sessions` · `GET /api/tabs` |
| Create session | `POST /api/sessions` `{name, cwd, cols, rows}` |
| Send text | `POST /api/send` `{target, text, submit}` |
| Read screen | `GET /api/capture?target=...` |
| Resolve a target | `GET /api/resolve?target=3-2` |
| Rename | `POST /api/tabs/{name}/rename` · `POST /api/panes/label` |
| Close | `DELETE /api/sessions/{sid}` · `DELETE /api/tabs/{name}` |
| Terminal stream | `WebSocket /ws/{sid}` |

`target` syntax: `3-2` (2nd pane of tab 3) · `tab:pane` · `tab:2` · sid prefix.
**Partial matching is disabled on purpose** — a command once went to the wrong session.
When ambiguous, the server refuses to pick and returns `409` with a list of candidates.

```powershell
Invoke-RestMethod "http://127.0.0.1:8767/api/send" -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"target":"1-1","text":"dir","submit":true}'))
```

## Troubleshooting

Verified on a clean Windows + fresh venv, from `pip install` through startup and shell
execution. The usual first-run snags:

### 1. `.\start.ps1` fails with "cannot be loaded because running scripts is disabled"

Windows clients default to the `Restricted` execution policy, which blocks **all** `.ps1`
files. This is the most common first hurdle. Unblock it for the current user (no admin):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If you'd rather not change the policy, bypass it for that one run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

### 2. `python` isn't found / opens the Microsoft Store

`WindowsApps\python.exe` on `PATH` is a **Store stub**, not real Python. `start.ps1` and
`launcher.py` filter it out, but they still need a real Python installed. Use the
[python.org](https://www.python.org/downloads/windows/) installer with **Add to PATH**
checked, or point `WEBTERM_PYTHON` at the executable.

### 3. `pip` is not recognized

`python --version` works but `pip` doesn't. `python.exe` is in `...\Python312\` and
`pip.exe` is in `...\Python312\Scripts\` — **separate PATH entries**, and often only the
first gets registered.

```powershell
python -m pip install -r requirements.txt
```

`python -m pip` doesn't rely on PATH — Python invokes its own pip module. To get the bare
`pip` command, add Scripts to PATH (takes effect in a new window):

```powershell
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";" + (Split-Path (Get-Command python).Source) + "\Scripts", "User")
```

### 4. Ports 8767 / 8771 are already in use

```powershell
.\start.ps1 -Status        # check whether our process is already up
$env:WEBTERM_PORT=9767; $env:WEBTERM_DAEMON_PORT=9771; .\start.ps1   # use other ports
```

### 5. The clone is ~26MB

24MB of it is the CJK font (Sarasa Fixed K, 216 woff2 subsets). The browser fetches only
the slices it needs via `unicode-range`, so it **doesn't affect runtime** — it's only
heavy to download. Not using a CDN is deliberate, so it works offline and on intranets.

### Sanity check

```powershell
.\start.ps1 -Status
Invoke-RestMethod http://127.0.0.1:8767/api/health
```

## Known limitations

- Windows only (ConPTY / pywinpty).
- No login or token. Access control is delegated to the network (private network / Tailscale) — see Security.
- The PTY has one size, so when a PC and a phone attach together it takes **the larger**
  (a deliberate choice to protect the PC).
- The WebGL renderer draws shifted when display scale isn't 1, so it's **off by default**
  (enable with `?webgl=1`).

## License

MIT — see [LICENSE](LICENSE). Bundled third-party components are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
