"""Render the simple JEX home-screen mark as iOS/Android PNG assets.

The matching vector source is public/icons/jex-icon.svg. The script requires
Pillow and a bold sans-serif font (Segoe UI Bold on Windows).
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public" / "icons"
FONT = Path("C:/Windows/Fonts/arialbd.ttf")
NAVY = "#111827"
GOLD = "#F2B84B"


def render(size: int) -> None:
    scale = size / 512
    image = Image.new("RGB", (size, size), NAVY)
    draw = ImageDraw.Draw(image)

    def box(coords):
        return tuple(round(value * scale) for value in coords)

    draw.rounded_rectangle(box((61, 70, 153, 84)), radius=round(7 * scale), fill=GOLD)
    font = ImageFont.truetype(str(FONT), round(174 * scale))
    text = "JEX"
    bounds = draw.textbbox((0, 0), text, font=font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    draw.text(((size - width) / 2 - bounds[0], 286 * scale - height / 2 - bounds[1]), text, font=font, fill="white")
    draw.rounded_rectangle(box((166, 352, 346, 364)), radius=round(6 * scale), fill=GOLD)
    image.save(DEST / f"jex-icon-{size}.png", optimize=True)


if __name__ == "__main__":
    for dimension in (180, 192, 512):
        render(dimension)
