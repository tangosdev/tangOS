#!/usr/bin/env python3
"""Build tangOS icon.ico (+ icon.png) from the mascot art (build/mascot.png).

Multi-resolution: large sizes use the full body, small sizes use just the head
(upper portion) so the character still reads at 16-48px. Output: build/icon.ico
(desktop shortcut + electron-builder) and build/icon.png (runtime window icon).
"""
import io
import struct
import pathlib
import numpy as np
import cv2
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "mascot.png"
# Head crop at every size - the full body is too busy to read as an app icon.
SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_transparent() -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    a = np.array(im)
    whiteish = (a[:, :, :3].min(2) > 238).astype(np.uint8)
    _, lab = cv2.connectedComponents(whiteish, 4)
    border = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    a[np.isin(lab, list(border)), 3] = 0
    return Image.fromarray(a, "RGBA")


def content_box(im: Image.Image):
    a = np.array(im)
    m = (a[:, :, 3] > 20) & (a[:, :, :3].min(2) < 236)
    ys, xs = np.where(m)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def square(im: Image.Image, box, pad_frac=0.06) -> Image.Image:
    x0, y0, x1, y1 = box
    crop = im.crop((x0, y0, x1, y1))
    w, h = crop.size
    side = int(max(w, h) * (1 + 2 * pad_frac))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - w) // 2, (side - h) // 2), crop)
    return canvas


def png(im: Image.Image, size: int) -> bytes:
    b = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(b, "PNG")
    return b.getvalue()


def write_ico(entries, out: pathlib.Path):
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dirs, datas = b"", b""
    for size, data in entries:
        wb = 0 if size >= 256 else size
        dirs += struct.pack("<BBBBHHII", wb, wb, 0, 0, 1, 32, len(data), offset)
        datas += data
        offset += len(data)
    out.write_bytes(header + dirs + datas)


def main():
    im = load_transparent()
    box = content_box(im)
    # The source is already a full-body bust on transparent - center it in a square by
    # its widest dimension with NO padding so it fills the frame as large as possible
    # (nothing cut, ears included). The user crops the source to control zoom.
    art = square(im, box, pad_frac=0.0)

    entries = [(s, png(art, s)) for s in SIZES]
    write_ico(entries, HERE / "icon.ico")
    # 512px so electron-builder can auto-generate the macOS .icns (it needs >=512);
    # Windows uses icon.ico and just downscales this for the runtime window icon.
    art.resize((512, 512), Image.LANCZOS).save(HERE / "icon.png")
    print("wrote icon.ico (%d sizes, centered) + icon.png 512px; content %s canvas %dpx" % (len(entries), box, art.size[0]))


if __name__ == "__main__":
    main()
