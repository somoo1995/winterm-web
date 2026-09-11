"""webterm 아이콘 생성기 — Tokyo Night 팔레트의 `❯_` 프롬프트 로고.

폰트에 의존하지 않고 도형으로 직접 그린다(글리프가 없는 환경에서도 동일하게 나오도록).
크기별로 따로 렌더해서 .ico 에 넣는다 — 256 하나를 축소하면 16px 에서 셰브론이 뭉갠다.

    python tools/make_icon.py

출력:
    assets/webterm.ico        exe 아이콘 (256~16 다중 해상도)
    static/icon-512.png       PWA/바로가기용
    static/icon-192.png
    static/favicon.png        브라우저 탭 · Chrome 앱 모드 창 아이콘
"""
import os

from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# .wezterm.lua / app.css 와 같은 Tokyo Night 값
BG = (26, 27, 38, 255)       # #1a1b26  배경
EDGE = (59, 66, 97, 255)     # #3b4261  테두리(탭 hover 색)
FG = (122, 162, 247, 255)    # #7aa2f7  프롬프트(활성 탭 색)
CUR = (255, 158, 100, 255)   # #ff9e64  커서


def render(size, bold=False):
    """size px 아이콘 한 장. 4배로 그린 뒤 축소해 안티앨리어싱을 얻는다."""
    ss = 4
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 둥근 사각 배경
    pad = n * 0.02
    d.rounded_rectangle(
        [pad, pad, n - pad - 1, n - pad - 1],
        radius=n * 0.22, fill=BG,
        outline=EDGE, width=max(1, int(n * 0.014)),
    )

    # ❯ 셰브론 — 작은 크기에서는 굵게(안 그러면 16px 에서 사라진다)
    w = n * (0.115 if bold else 0.092)
    # 잉크의 광학 중심을 캔버스 중앙에 맞춘 값(선 두께 w 까지 포함해 계산)
    x0, xm = n * 0.263, n * 0.503
    y0, y1 = n * 0.33, n * 0.67
    ym = (y0 + y1) / 2
    d.line([(x0, y0), (xm, ym), (x0, y1)], fill=FG, width=int(round(w)), joint="curve")
    # ImageDraw.line 의 끝은 각지므로 원을 덧대 둥글게 만든다
    for px, py in ((x0, y0), (x0, y1), (xm, ym)):
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=FG)

    # _ 커서 블록 — 셰브론 아래 끝선에 맞춘다
    by1 = y1 + w / 2
    by0 = by1 - w * 0.92
    d.rounded_rectangle([n * 0.568, by0, n * 0.783, by1], radius=w * 0.28, fill=CUR)

    return img.resize((size, size), Image.LANCZOS)


def maskable(size):
    """PWA maskable 아이콘 — OS 가 원형/스퀘어클로 잘라내므로 안전영역(80%) 안에 그린다."""
    inner = int(size * 0.78)
    img = Image.new("RGBA", (size, size), BG)
    logo = render(inner)
    img.paste(logo, ((size - inner) // 2, (size - inner) // 2), logo)
    return img


def main():
    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    imgs = [render(s, bold=(s <= 32)) for s in ico_sizes]

    os.makedirs(os.path.join(BASE, "assets"), exist_ok=True)
    ico = os.path.join(BASE, "assets", "webterm.ico")
    imgs[0].save(ico, format="ICO",
                 sizes=[(s, s) for s in ico_sizes], append_images=imgs[1:])
    print("생성:", ico)

    static = os.path.join(BASE, "static")
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("favicon.png", 64)):
        p = os.path.join(static, name)
        render(size, bold=(size <= 32)).save(p)
        print("생성:", p)

    p = os.path.join(static, "icon-maskable-512.png")
    maskable(512).save(p)
    print("생성:", p)

    # 시안 확인용 대지 (16~256 나란히)
    sheet = Image.new("RGBA", (520, 300), (36, 40, 59, 255))
    x = 16
    for s in (256, 128, 64, 48, 32, 16):
        im = render(s, bold=(s <= 32))
        sheet.paste(im, (x, 24 + (256 - s) // 2), im)
        x += s + 16
    p = os.path.join(BASE, "docs", "icon-preview.png")
    sheet.save(p)
    print("생성:", p)


if __name__ == "__main__":
    main()
