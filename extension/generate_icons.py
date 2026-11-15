"""
Generates the Lynch Digitance Alerts extension icons.

Design: black rounded square, silver/copper "LD" monogram, and a small alert dot
in the top-right corner (the thing the extension actually does — it pings you).
Rendered at 4x then downsampled so the curves stay clean at 16px.

Run:  python generate_icons.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

# Lynch Digitance brand (2026-09-17 rebrand): black ground, silver "L", copper "D".
BLACK = (0, 0, 0, 255)
GOLD = (217, 122, 61, 255)       # copper — name kept so the rest of the file reads the same
WHITE = (255, 255, 255, 255)
DOT = (217, 122, 61, 255)        # alert dot, copper
EDGE = (56, 32, 17, 255)         # subtle copper rim

SS = 4                           # supersample factor
SIZES = [16, 32, 48, 128]
HERE = os.path.dirname(os.path.abspath(__file__))


def load_font(px):
    for path in (r"C:\Windows\Fonts\arialbd.ttf",
                 r"C:\Windows\Fonts\segoeuib.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                pass
    return ImageFont.load_default()


def draw_icon(size, monogram=True):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square body with a thin gold rim.
    radius = int(S * 0.24)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius,
                        fill=BLACK, outline=EDGE, width=max(1, int(S * 0.02)))

    if monogram:
        # Two-tone "LD" — white/silver L, copper D — echoing the LDS wordmark.
        font = load_font(int(S * 0.38))
        box = d.textbbox((0, 0), "LD", font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        x = S / 2 - w / 2 - box[0] - S * 0.03
        y = S / 2 - h / 2 - box[1] + S * 0.06
        d.text((x, y), "L", font=font, fill=WHITE)
        lw = d.textbbox((0, 0), "L", font=font)[2]
        d.text((x + lw - S * 0.015, y), "D", font=font, fill=GOLD)
    else:
        # Tiny sizes: a chat bubble reads far better than two letters.
        pad = S * 0.22
        d.rounded_rectangle([pad, pad, S - pad, S - pad * 1.35],
                            radius=int(S * 0.1), fill=GOLD)
        d.polygon([(S * 0.34, S - pad * 1.4), (S * 0.34, S - pad * 0.72),
                   (S * 0.52, S - pad * 1.4)], fill=GOLD)

    # Alert dot, top-right.
    r = S * 0.115
    cx, cy = S - r - S * 0.08, r + S * 0.08
    d.ellipse([cx - r - S * 0.035, cy - r - S * 0.035,
               cx + r + S * 0.035, cy + r + S * 0.035], fill=BLACK)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT)

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    # At 16px a two-letter monogram turns to mush — use the bubble mark instead.
    icon = draw_icon(size, monogram=size >= 32)
    icon.save(os.path.join(HERE, f"icon{size}.png"))
    print(f"wrote icon{size}.png")

print("done")
