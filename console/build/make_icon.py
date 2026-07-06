#!/usr/bin/env python3
"""Generate a tangOS bubble icon.ico with pure Python (no deps).

Draws a glossy aqua->lime bubble with a specular highlight, at several sizes,
packed as 32bpp BGRA BMP-in-ICO. Output: build/icon.ico (used by the desktop
shortcut and electron-builder for P3).
"""
import math
import struct
import pathlib

SIZES = [16, 32, 48, 64, 128, 256]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def render(s):
    """Return top-down RGBA bytes for an s x s bubble."""
    cx = cy = (s - 1) / 2.0
    r = s * 0.46
    top = (120, 210, 250)     # light aqua
    bot = (110, 190, 40)      # lime
    mid = (0, 150, 220)       # aqua primary
    white = (255, 255, 255)
    px = bytearray(s * s * 4)
    for y in range(s):
        for x in range(s):
            dx = x - cx
            dy = y - cy
            d = math.hypot(dx, dy)
            i = (y * s + x) * 4
            if d > r + 0.7:
                px[i:i + 4] = b"\x00\x00\x00\x00"
                continue
            # vertical two-stop blend (aqua top -> primary -> lime bottom)
            t = y / (s - 1)
            if t < 0.55:
                base = lerp(top, mid, t / 0.55)
            else:
                base = lerp(mid, bot, (t - 0.55) / 0.45)
            # specular highlight near upper-left
            hlx = cx - r * 0.32
            hly = cy - r * 0.42
            hl = math.exp(-((x - hlx) ** 2 + (y - hly) ** 2) / (2 * (r * 0.34) ** 2))
            col = lerp(base, white, min(0.85, hl * 0.9))
            # subtle rim darkening for depth
            rim = max(0.0, (d / r) - 0.6) / 0.4
            col = lerp(col, (10, 60, 90), min(0.35, rim * 0.35))
            a = 255
            if d > r - 0.7:  # 1px edge antialias
                a = int(max(0.0, min(1.0, (r + 0.5 - d))) * 255)
            px[i + 0] = col[0]
            px[i + 1] = col[1]
            px[i + 2] = col[2]
            px[i + 3] = a
    return bytes(px)


def dib(s, rgba):
    """BITMAPINFOHEADER + bottom-up BGRA + AND mask."""
    hdr = struct.pack("<IiiHHIIiiII", 40, s, s * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    rows = []
    for y in range(s - 1, -1, -1):  # bottom-up
        row = bytearray()
        for x in range(s):
            i = (y * s + x) * 4
            r_, g_, b_, a_ = rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]
            row += bytes((b_, g_, r_, a_))
        rows.append(bytes(row))
    color = b"".join(rows)
    and_row = ((s + 31) // 32) * 4
    mask = b"\x00" * (and_row * s)
    return hdr + color + mask


def main():
    out = pathlib.Path(__file__).resolve().parent / "icon.ico"
    images = [(s, dib(s, render(s))) for s in SIZES]
    n = len(images)
    header = struct.pack("<HHH", 0, 1, n)
    entries = b""
    offset = 6 + 16 * n
    for s, data in images:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    blob = header + entries + b"".join(d for _, d in images)
    out.write_bytes(blob)
    print(f"wrote {out} ({len(blob)} bytes, sizes {SIZES})")


if __name__ == "__main__":
    main()
