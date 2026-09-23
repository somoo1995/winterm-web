"""Put `local()` sources in front of every bundled @font-face.

Why: the bundled fonts are SUBSETS (JetBrains Mono latin only, Sarasa in 108 unicode-range
slices) that load lazily, and both renderers pay for that - the WebGL atlas bakes fallback
glyphs when a slice is late, the DOM renderer draws box-drawing from whichever font happens
to have it. A machine with the real fonts installed should simply use them: whole font, every
weight, no network, no race. `local()` first does exactly that, and machines without them
keep the bundled subsets as before.

Idempotent: a src line that already has local() is left alone. Run from the repo root:
    python tools/add_local_fonts.py
"""
import io
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(BASE, "static", "fonts")

# family -> weight -> style -> local names (full name first, then PostScript name; browsers
# match either, and which one works differs between Windows, macOS and Linux)
LOCAL = {
    "JetBrains Mono": {
        (500, "normal"): ["JetBrains Mono Medium", "JetBrainsMono-Medium"],
        (700, "normal"): ["JetBrains Mono Bold", "JetBrainsMono-Bold"],
        (500, "italic"): ["JetBrains Mono Medium Italic", "JetBrainsMono-MediumItalic"],
        (700, "italic"): ["JetBrains Mono Bold Italic", "JetBrainsMono-BoldItalic"],
    },
    "Sarasa Fixed K": {
        (300, "normal"): ["Sarasa Fixed K Light", "SarasaFixedK-Light"],
        (400, "normal"): ["Sarasa Fixed K", "Sarasa Fixed K Regular", "SarasaFixedK-Regular"],
        (700, "normal"): ["Sarasa Fixed K Bold", "SarasaFixedK-Bold"],
        (300, "italic"): ["Sarasa Fixed K Light Italic", "SarasaFixedK-LightItalic"],
        (400, "italic"): ["Sarasa Fixed K Italic", "SarasaFixedK-Italic"],
        (700, "italic"): ["Sarasa Fixed K Bold Italic", "SarasaFixedK-BoldItalic"],
    },
}

FACE = re.compile(r"@font-face\s*\{(.*?)\}", re.S)


def patch_face(body):
    fam = re.search(r'font-family:\s*"([^"]+)"', body)
    wt = re.search(r"font-weight:\s*(\d+)", body)
    st = re.search(r"font-style:\s*(\w+)", body)
    if not (fam and wt):
        return body
    names = LOCAL.get(fam.group(1), {}).get((int(wt.group(1)), st.group(1) if st else "normal"))
    if not names:
        return body
    if "local(" in body:
        return body
    locals_ = ", ".join(f'local("{n}")' for n in names)
    return re.sub(r"src:\s*url\(", f"src: {locals_}, url(", body, count=1)


def patch_file(name):
    path = os.path.join(FONTS, name)
    with io.open(path, encoding="utf-8") as f:
        css = f.read()
    out = FACE.sub(lambda m: "@font-face {" + patch_face(m.group(1)) + "}", css)
    changed = out.count("local(") - css.count("local(")
    if out != css:
        with io.open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
    print(f"{name}: {changed} local() sources added")


if __name__ == "__main__":
    patch_file("jetbrains-mono.css")
    patch_file("sarasa-fixed-k.css")
