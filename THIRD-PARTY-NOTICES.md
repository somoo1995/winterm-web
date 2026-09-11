# Third-Party Notices

This repository **vendors** the components below (bundles them in the source). We don't use
a CDN so it works offline and on intranets. Each component is licensed by its original
authors; the notices below plus the bundled license texts satisfy those terms.

| Component | Path | License | Copyright |
| --- | --- | --- | --- |
| xterm.js 5.5.x (+ addon-fit / addon-webgl / addon-web-links) | `static/vendor/` | MIT | Copyright (c) 2017-2022, The xterm.js authors<br>Copyright (c) 2014-2016, SourceLair Private Company<br>Copyright (c) 2012-2013, Christopher Jeffrey |
| JetBrains Mono (Latin subset, woff2) | `static/fonts/jbm/` | SIL Open Font License 1.1 | Copyright 2020 The JetBrains Mono Project Authors |
| Sarasa Fixed K (CJK woff2) | `static/fonts/woff2/` | SIL Open Font License 1.1 | Copyright (c) 2018 Belleve Invis |

Full license texts:

- JetBrains Mono — `static/fonts/jbm/LICENSE-JetBrainsMono.txt`
- Sarasa Gothic — `static/fonts/LICENSE-Sarasa.txt`
- xterm.js — `static/vendor/LICENSE-xterm.txt`

## Runtime dependencies (not bundled, installed via pip)

| Package | License |
| --- | --- |
| FastAPI | MIT |
| uvicorn | BSD-3-Clause |
| websockets | BSD-3-Clause |
| pywinpty | MIT |
| python-multipart | Apache-2.0 |

## Inspiration (no code taken)

- [WezTerm](https://github.com/wez/wezterm) — tab-bar look, keybinding scheme, and the
  Tokyo Night palette values. No code was copied; the palette was matched against the
  published color-scheme definition.
- [tmux](https://github.com/tmux/tmux) — the "server owns the sessions, clients attach and
  detach" model.
