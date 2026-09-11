# 서드파티 고지

이 저장소는 아래 구성요소를 **소스에 동봉(vendoring)** 한다. CDN 을 쓰지 않는 이유는
오프라인·사내망에서도 그대로 뜨게 하기 위해서다. 각 구성요소의 라이선스는 원저작자의 것이며,
아래 표기와 동봉된 라이선스 전문이 그 조건을 만족시킨다.

| 구성요소 | 경로 | 라이선스 | 저작권자 |
| --- | --- | --- | --- |
| xterm.js 5.5.x (+ addon-fit / addon-webgl / addon-web-links) | `static/vendor/` | MIT | Copyright (c) 2017-2022, The xterm.js authors<br>Copyright (c) 2014-2016, SourceLair Private Company<br>Copyright (c) 2012-2013, Christopher Jeffrey |
| JetBrains Mono (라틴 서브셋 woff2) | `static/fonts/jbm/` | SIL Open Font License 1.1 | Copyright 2020 The JetBrains Mono Project Authors |
| Sarasa Fixed K (한글·CJK woff2) | `static/fonts/woff2/` | SIL Open Font License 1.1 | Copyright (c) 2018 Belleve Invis |

라이선스 전문:

- JetBrains Mono — `static/fonts/jbm/LICENSE-JetBrainsMono.txt`
- Sarasa Gothic — `static/fonts/LICENSE-Sarasa.txt`
- xterm.js — `static/vendor/LICENSE-xterm.txt`

## 런타임 의존성 (동봉하지 않음, pip 로 설치)

| 패키지 | 라이선스 |
| --- | --- |
| FastAPI | MIT |
| uvicorn | BSD-3-Clause |
| websockets | BSD-3-Clause |
| pywinpty | MIT |
| python-multipart | Apache-2.0 |

## 영감을 받은 것 (코드는 가져오지 않음)

- [WezTerm](https://github.com/wez/wezterm) — 탭바 외형·키바인딩 체계·Tokyo Night 팔레트 값을
  참고했다. 코드를 가져오지는 않았고, 색상표는 공개된 컬러스킴 정의를 대조해 맞춘 것이다.
- [tmux](https://github.com/tmux/tmux) — "서버가 세션을 소유하고 클라이언트는 붙었다 떨어진다"는
  모델을 그대로 빌렸다.
