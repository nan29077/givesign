from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
HERO = ROOT / "public" / "assets" / "tornado-hero-creator-v1.png"
FONT_REGULAR = Path(r"C:\Windows\Fonts\malgun.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\malgunbd.ttf")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def rounded_gradient(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = canvas.load()
    start = (149, 119, 255)
    end = (71, 33, 173)
    for y in range(size):
        ratio = y / max(size - 1, 1)
        color = tuple(int(start[i] * (1 - ratio) + end[i] * ratio) for i in range(3)) + (255,)
        for x in range(size):
            pixels[x, y] = color
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * .29), fill=255)
    canvas.putalpha(mask)
    return canvas


def draw_mark(image: Image.Image, box: tuple[int, int, int, int], width: int) -> None:
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = box
    white = (255, 255, 255, 245)
    draw.arc((x0, y0, x1, y0 + int((y1-y0) * .48)), 190, 535, fill=white, width=width)
    draw.arc((x0 + int((x1-x0)*.17), y0 + int((y1-y0)*.23), x1 - int((x1-x0)*.13), y0 + int((y1-y0)*.70)), 185, 520, fill=white, width=width)
    draw.arc((x0 + int((x1-x0)*.32), y0 + int((y1-y0)*.48), x1 - int((x1-x0)*.27), y0 + int((y1-y0)*.88)), 190, 500, fill=white, width=width)
    draw.line((int((x0+x1)/2), y0 + int((y1-y0)*.75), int((x0+x1)/2), y1), fill=white, width=width)


def make_icon() -> None:
    icon = rounded_gradient(512)
    draw_mark(icon, (72, 92, 440, 410), 28)
    icon.save(ROOT / "public" / "tornado-icon-v2.png", optimize=True)
    icon.resize((180, 180), Image.Resampling.LANCZOS).save(ROOT / "public" / "apple-touch-icon-v2.png", optimize=True)
    icon.save(ROOT / "src" / "app" / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])


def make_og() -> None:
    width, height = 1200, 630
    source = Image.open(HERO).convert("RGB")
    target_ratio = width / height
    source_ratio = source.width / source.height
    if source_ratio > target_ratio:
        crop_width = int(source.height * target_ratio)
        left = source.width - crop_width
        source = source.crop((left, 0, source.width, source.height))
    else:
        crop_height = int(source.width / target_ratio)
        top = (source.height - crop_height) // 2
        source = source.crop((0, top, source.width, top + crop_height))
    canvas = source.resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ov = overlay.load()
    for x in range(width):
        ratio = x / width
        alpha = int(222 * max(0, 1 - ratio / .78))
        for y in range(height):
            bottom = max(0, (y - 420) / 210)
            ov[x, y] = (19, 14, 43, min(238, alpha + int(bottom * 40)))
    canvas = Image.alpha_composite(canvas, overlay)

    mark = rounded_gradient(72)
    draw_mark(mark, (11, 13, 61, 58), 4)
    canvas.alpha_composite(mark, (72, 64))
    draw = ImageDraw.Draw(canvas)
    draw.text((162, 67), "토네이도", font=font(FONT_BOLD, 29), fill=(255, 255, 255, 255))
    draw.text((163, 106), "TORNADO", font=font(FONT_BOLD, 13), fill=(184, 162, 255, 255))
    draw.text((72, 242), "문자 한 통이", font=font(FONT_BOLD, 55), fill=(255, 255, 255, 255))
    draw.text((72, 312), "방송을 움직입니다", font=font(FONT_BOLD, 55), fill=(255, 255, 255, 255))
    draw.text((75, 405), "크리에이터에게 메시지를 보내고,", font=font(FONT_REGULAR, 22), fill=(226, 221, 239, 255))
    draw.text((75, 439), "실시간으로 응원과 후원을 전달하세요.", font=font(FONT_REGULAR, 22), fill=(226, 221, 239, 255))
    draw.rounded_rectangle((72, 511, 300, 566), radius=28, fill=(255, 255, 255, 235))
    draw.text((111, 524), "문자 후원 플랫폼", font=font(FONT_BOLD, 18), fill=(76, 40, 170, 255))
    canvas.convert("RGB").save(ROOT / "public" / "assets" / "tornado-og-share-v1.png", optimize=True)


if __name__ == "__main__":
    make_icon()
    make_og()
    print("Generated Tornado icon, favicon, Apple touch icon, and OG card.")
