#!/usr/bin/env python3
"""Regenerates the app's brand assets from the CommuniOne logo.

Source: assets/brand/communione-logo-source.png (the full lockup: mark,
wordmark and tagline on a white background). Outputs, all in assets/:

  icon.png                     1024 px app icon: the mark on white (iOS / store)
  splash-icon.png              the mark, transparent around it (splash screen)
  android-icon-foreground.png  the mark inside the adaptive-icon safe zone
  android-icon-background.png  plain white
  android-icon-monochrome.png  the mark's silhouette (Android themed icons)
  brand/mark.png               the mark, transparent around it (in-app)
  brand/wordmark-light.png     "CommuniOne" for light backgrounds
  brand/wordmark-dark.png      the same with the navy letters in white (dark mode)

Around the mark, white becomes transparent (the bubble's opening joins its
inner disc to the background, so the disc is transparent too: on dark
backgrounds the app shows the mark on a white tile). In the wordmark every
white area becomes transparent, letter counters included.

Development-time tool, not part of the app or CI. Needs Pillow:
    python3 -m pip install Pillow
    python3 apps/mobile/scripts/brand-assets.py
"""
from collections import deque
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SOURCE = ASSETS / "brand" / "communione-logo-source.png"
NAVY = (22, 43, 70)


def outside_mask(img: Image.Image, tolerance: int = 18) -> list[list[bool]]:
    """Near-white pixels connected to the border (the background around the logo)."""
    w, h = img.size
    px = img.load()
    seen = [[False] * w for _ in range(h)]
    queue = deque((x, y) for x in range(w) for y in (0, h - 1))
    queue.extend((x, y) for y in range(h) for x in (0, w - 1))
    while queue:
        x, y = queue.popleft()
        if not (0 <= x < w and 0 <= y < h) or seen[y][x]:
            continue
        if 255 - min(px[x, y]) > tolerance:
            continue
        seen[y][x] = True
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return seen


def transparent_background(img: Image.Image, everywhere: bool = False) -> Image.Image:
    """White → alpha (color-to-alpha) for the background around the art and its
    anti-aliased edge; with `everywhere`, for every white area (letter counters too)."""
    img = img.convert("RGB")
    w, h = img.size
    outside = [[False] * w for _ in range(h)] if everywhere else outside_mask(img)
    near = [[False] * w for _ in range(h)]
    band = 4  # edge pixels next to the background are blends of logo colour and white
    for y in range(h):
        for x in range(w):
            if outside[y][x]:
                for dy in range(-band, band + 1):
                    yy = y + dy
                    if 0 <= yy < h:
                        row = near[yy]
                        for dx in range(-band, band + 1):
                            xx = x + dx
                            if 0 <= xx < w:
                                row[xx] = True
    src = img.load()
    out = Image.new("RGBA", (w, h))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            if outside[y][x]:
                dst[x, y] = (255, 255, 255, 0)
            elif everywhere or near[y][x]:
                a = max(255 - r, 255 - g, 255 - b)
                if a == 0:
                    dst[x, y] = (255, 255, 255, 0)
                    continue
                un = lambda c: max(0, min(255, round((c - 255 * (1 - a / 255)) / (a / 255))))
                dst[x, y] = (un(r), un(g), un(b), a)
            else:
                dst[x, y] = (r, g, b, 255)
    return out


def bbox(img: Image.Image, top: int, bottom: int) -> tuple[int, int, int, int]:
    """Bounding box of the non-white content between two rows."""
    region = img.convert("RGB").crop((0, top, img.width, bottom))
    px = region.load()
    xs, ys = [], []
    for y in range(region.height):
        for x in range(region.width):
            if 255 - min(px[x, y]) > 40:
                xs.append(x)
                ys.append(y)
    return min(xs), top + min(ys), max(xs) + 1, top + max(ys) + 1


def on_canvas(art: Image.Image, size: int, fill: float, background=(255, 255, 255, 0)) -> Image.Image:
    """`art` scaled to `fill` of a square canvas, centred."""
    scale = fill * size / max(art.size)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), background)
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def main() -> None:
    logo = Image.open(SOURCE).convert("RGB")
    # The lockup: the mark on top, then "CommuniOne", then the tagline.
    mark_box = bbox(logo, 150, 740)
    word_box = bbox(logo, 745, 910)
    pad = 6
    mark = transparent_background(logo.crop((mark_box[0] - pad, mark_box[1] - pad, mark_box[2] + pad, mark_box[3] + pad)))
    word = transparent_background(
        logo.crop((word_box[0] - pad, word_box[1] - pad, word_box[2] + pad, word_box[3] + pad)), everywhere=True
    )

    (ASSETS / "brand").mkdir(exist_ok=True)
    mark.save(ASSETS / "brand" / "mark.png", optimize=True)
    word.save(ASSETS / "brand" / "wordmark-light.png", optimize=True)

    # Dark mode: the navy letters become white; the green "One" keeps its colour.
    dark = word.copy()
    px = dark.load()
    for y in range(dark.height):
        for x in range(dark.width):
            r, g, b, a = px[x, y]
            if a and abs(r - NAVY[0]) + abs(g - NAVY[1]) + abs(b - NAVY[2]) < 120 and g < 120:
                px[x, y] = (255, 255, 255, a)
    dark.save(ASSETS / "brand" / "wordmark-dark.png", optimize=True)

    white = (255, 255, 255, 255)
    on_canvas(mark, 1024, 0.78, white).convert("RGB").save(ASSETS / "icon.png", optimize=True)
    on_canvas(mark, 1024, 0.9).save(ASSETS / "splash-icon.png", optimize=True)
    # Adaptive icons: launchers mask to the central 66%; keep the mark inside it.
    on_canvas(mark, 1024, 0.58).save(ASSETS / "android-icon-foreground.png", optimize=True)
    Image.new("RGB", (1024, 1024), (255, 255, 255)).save(ASSETS / "android-icon-background.png", optimize=True)
    silhouette = on_canvas(mark, 1024, 0.58)
    alpha = silhouette.getchannel("A")
    mono = Image.new("RGBA", silhouette.size, (255, 255, 255, 0))
    mono.putalpha(alpha)
    mono.save(ASSETS / "android-icon-monochrome.png", optimize=True)
    print("mark", mark.size, "wordmark", word.size)


if __name__ == "__main__":
    main()
