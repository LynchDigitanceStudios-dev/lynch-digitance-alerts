"""
Cuts site-ready assets out of the master Lynch Digitance Studios logo.

The master is a stacked lockup (monogram over wordmark) on a solid black
background. We cut:

  logo.png      full lockup, trimmed  -> footer / uninstall page
  mark.png      LDS monogram only     -> nav bar
  wordmark.png  text lockup only      -> nav bar
  og.png        logo on navy, 1200x630 -> social-share preview (needs an opaque bg)

Every cut is turned TRANSPARENT (black -> alpha) so the logo sits on any dark
background, not just black. Over pure black it looks identical to the original.

Run:  python make_logo_assets.py
"""

from PIL import Image, ImageChops
import numpy as np
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r"C:\Users\USER\Downloads\lynch digitance.png"
NAVY = (11, 32, 56, 255)          # site background, see index.html --ink

img = Image.open(SRC).convert("RGB")
W, H = img.size
print(f"master: {W}x{H}")


def trim(im, tol=18):
    """Crop away uniform near-black border so the art fills the frame."""
    bg = Image.new("RGB", im.size, (0, 0, 0))
    diff = ImageChops.difference(im, bg).convert("L")
    box = diff.point(lambda p: 255 if p > tol else 0).getbbox()
    return im.crop(box) if box else im


def cut(x0, y0, x1, y1):
    return trim(img.crop((int(W * x0), int(H * y0), int(W * x1), int(H * y1))))


def pad(im, frac=0.06):
    """Breathing room on a tight trim, so art doesn't sit flush to the frame."""
    p = round(max(im.size) * frac)
    out = Image.new("RGB", (im.width + p * 2, im.height + p * 2), (0, 0, 0))
    out.paste(im, (p, p))
    return out


def to_alpha(im):
    """Black -> transparent. The brightest channel says how much light a pixel
    carries; that becomes its opacity, and the colour is un-premultiplied so it
    stays true. Composited back over black it reproduces the original exactly."""
    a = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    m = a.max(axis=2)
    rgb = np.where(m[..., None] > 0.02, a / np.maximum(m[..., None], 1e-6), 0.0)
    alpha = np.where(m < 0.03, 0.0, m)               # clear out the near-black haze
    out = np.dstack([np.clip(rgb, 0, 1), alpha])
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")


# Fractions measured off the 2026-09-17 copper/chrome master (1536x1024).
# A per-row brightness scan found the real bands: monogram 15.7%-67.8%,
# wordmark+tagline 70.5%-82.6%. Generous bounds — trim() finds the true edge.
mark = pad(cut(0.0, 0.08, 1.0, 0.70), 0.04)
word = cut(0.0, 0.70, 1.0, 0.86)
full = trim(img)

for name, im in (("mark", mark), ("wordmark", word), ("logo", full)):
    # Cap the long edge — nobody needs a 1200px nav logo.
    cap = 900 if name == "logo" else 700
    if max(im.size) > cap:
        r = cap / max(im.size)
        im = im.resize((round(im.width * r), round(im.height * r)), Image.LANCZOS)
    im = to_alpha(im)
    im.save(os.path.join(HERE, f"{name}.png"))
    print(f"wrote {name}.png  {im.width}x{im.height}  (transparent)")

# Social previews need an opaque background, so og.png is the logo on navy.
lg = Image.open(os.path.join(HERE, "logo.png"))
h = 500
w = round(lg.width * h / lg.height)
lg = lg.resize((w, h), Image.LANCZOS)
card = Image.new("RGBA", (1200, 630), NAVY)
card.alpha_composite(lg, ((1200 - w) // 2, (630 - h) // 2))
card.convert("RGB").save(os.path.join(HERE, "og.png"))
print("wrote og.png  1200x630")

print("done")
