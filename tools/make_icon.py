"""webterm icon generator - the Tokyo Night `>_` prompt logo.

Drawn from shapes, not a font (so it looks the same where the glyph is missing).
Rendered per size and packed into the .ico - shrinking one 256 makes the chevron mush at 16px.

    python tools/make_icon.py

Outputs:
    assets/webterm.ico        exe icon (256..16 multi-resolution)
    static/icon-512.png       for PWA / shortcut
    static/icon-192.png
    static/favicon.png        browser tab / Chrome app-mode window icon
"""
import os

from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The same Tokyo Night values as .wezterm.lua / app.css
BG = (26, 27, 38, 255)       # #1a1b26  background
EDGE = (59, 66, 97, 255)     # #3b4261  border (tab hover color)
FG = (122, 162, 247, 255)    # #7aa2f7  prompt (active-tab color)
CUR = (255, 158, 100, 255)   # #ff9e64  cursor


def render(size, bold=False):
    """One icon at `size` px. Drawn at 4x and shrunk for anti-aliasing."""
    ss = 4
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded-rect background
    pad = n * 0.02
    d.rounded_rectangle(
        [pad, pad, n - pad - 1, n - pad - 1],
        radius=n * 0.22, fill=BG,
        outline=EDGE, width=max(1, int(n * 0.014)),
    )

    # the ">" chevron - bolder at small sizes (or it vanishes at 16px)
    w = n * (0.115 if bold else 0.092)
    # values that center the ink's optical center on the canvas (accounting for stroke width w)
    x0, xm = n * 0.263, n * 0.503
    y0, y1 = n * 0.33, n * 0.67
    ym = (y0 + y1) / 2
    d.line([(x0, y0), (xm, ym), (x0, y1)], fill=FG, width=int(round(w)), joint="curve")
    # ImageDraw.line has square ends, so overlay circles to round them
    for px, py in ((x0, y0), (x0, y1), (xm, ym)):
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=FG)

    # the "_" cursor block - aligned to the chevron's lower endpoint
    by1 = y1 + w / 2
    by0 = by1 - w * 0.92
    d.rounded_rectangle([n * 0.568, by0, n * 0.783, by1], radius=w * 0.28, fill=CUR)

    return img.resize((size, size), Image.LANCZOS)


def maskable(size):
    """PWA maskable icon - the OS crops to a circle/squircle, so draw within the 80% safe zone."""
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
    print("wrote:", ico)

    static = os.path.join(BASE, "static")
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("favicon.png", 64)):
        p = os.path.join(static, name)
        render(size, bold=(size <= 32)).save(p)
        print("wrote:", p)

    p = os.path.join(static, "icon-maskable-512.png")
    maskable(512).save(p)
    print("wrote:", p)

    # A preview sheet (16..256 side by side)
    sheet = Image.new("RGBA", (520, 300), (36, 40, 59, 255))
    x = 16
    for s in (256, 128, 64, 48, 32, 16):
        im = render(s, bold=(s <= 32))
        sheet.paste(im, (x, 24 + (256 - s) // 2), im)
        x += s + 16
    docs = os.path.join(BASE, "docs")
    os.makedirs(docs, exist_ok=True)   # docs/ is gitignored, so it may not exist on a fresh clone
    p = os.path.join(docs, "icon-preview.png")
    sheet.save(p)
    print("wrote:", p)


if __name__ == "__main__":
    main()
