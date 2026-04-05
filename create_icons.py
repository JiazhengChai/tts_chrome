#!/usr/bin/env python3
"""Generate polished PNG icons for the Chrome extension."""
import math
import os
import struct
import zlib


def clamp(value, low=0, high=255):
    return max(low, min(high, int(round(value))))


def lerp(a, b, t):
    return a + (b - a) * t


def blend(dst, src):
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    sa /= 255.0
    da /= 255.0
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0:
        return (0, 0, 0, 0)
    out_r = (sr * sa + dr * da * (1.0 - sa)) / out_a
    out_g = (sg * sa + dg * da * (1.0 - sa)) / out_a
    out_b = (sb * sa + db * da * (1.0 - sa)) / out_a
    return (clamp(out_r), clamp(out_g), clamp(out_b), clamp(out_a * 255))


def rounded_rect_alpha(x, y, x0, y0, x1, y1, radius):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return 0.0

    inner_x = min(max(x, x0 + radius), x1 - radius)
    inner_y = min(max(y, y0 + radius), y1 - radius)
    dx = x - inner_x
    dy = y - inner_y
    dist = math.hypot(dx, dy)

    if dist <= radius - 0.8:
        return 1.0
    if dist >= radius + 0.8:
        return 0.0
    return max(0.0, min(1.0, radius + 0.8 - dist))


def draw_pixel(canvas, width, x, y, color):
    if 0 <= x < width and 0 <= y < width:
        index = y * width + x
        canvas[index] = blend(canvas[index], color)


def fill_rounded_rect(canvas, width, x0, y0, x1, y1, radius, color_fn):
    for y in range(width):
        for x in range(width):
            alpha = rounded_rect_alpha(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)
            if alpha <= 0:
                continue
            color = color_fn(x, y)
            draw_pixel(canvas, width, x, y, (color[0], color[1], color[2], clamp(color[3] * alpha)))


def fill_circle(canvas, width, cx, cy, radius, color):
    for y in range(width):
        for x in range(width):
            dist = math.hypot((x + 0.5) - cx, (y + 0.5) - cy)
            if dist <= radius - 0.7:
                alpha = 1.0
            elif dist >= radius + 0.7:
                continue
            else:
                alpha = radius + 0.7 - dist
            draw_pixel(canvas, width, x, y, (color[0], color[1], color[2], clamp(color[3] * alpha)))


def fill_arc(canvas, width, cx, cy, radius, thickness, start_angle, end_angle, color):
    inner = max(0.0, radius - thickness)
    for y in range(width):
        for x in range(width):
            px = (x + 0.5) - cx
            py = (y + 0.5) - cy
            dist = math.hypot(px, py)
            if dist < inner - 0.7 or dist > radius + 0.7:
                continue
            angle = math.atan2(py, px)
            if not (start_angle <= angle <= end_angle):
                continue

            outer_alpha = 1.0 if dist <= radius - 0.7 else radius + 0.7 - dist
            inner_alpha = 1.0 if dist >= inner + 0.7 else dist - inner + 0.7
            alpha = max(0.0, min(outer_alpha, inner_alpha, 1.0))
            if alpha > 0:
                draw_pixel(canvas, width, x, y, (color[0], color[1], color[2], clamp(color[3] * alpha)))


def generate_icon(size):
    canvas = [(0, 0, 0, 0) for _ in range(size * size)]

    card_margin = size * 0.09
    card_radius = size * 0.22

    def bg_color(x, y):
        tx = x / max(1, size - 1)
        ty = y / max(1, size - 1)
        top = (255, 155, 63)
        bottom = (231, 82, 53)
        base = tuple(clamp(lerp(top[i], bottom[i], ty * 0.85 + tx * 0.15)) for i in range(3))
        glow = max(0.0, 1.0 - math.hypot(tx - 0.24, ty - 0.2) * 1.6)
        return (
            clamp(base[0] + glow * 30),
            clamp(base[1] + glow * 20),
            clamp(base[2] + glow * 8),
            255,
        )

    fill_rounded_rect(
        canvas,
        size,
        card_margin,
        card_margin,
        size - card_margin,
        size - card_margin,
        card_radius,
        bg_color,
    )

    shadow_offset = size * 0.025
    doc_x0 = size * 0.17
    doc_y0 = size * 0.15
    doc_x1 = size * 0.69
    doc_y1 = size * 0.86
    doc_radius = size * 0.08

    fill_rounded_rect(
        canvas,
        size,
        doc_x0 + shadow_offset,
        doc_y0 + shadow_offset,
        doc_x1 + shadow_offset,
        doc_y1 + shadow_offset,
        doc_radius,
        lambda _x, _y: (82, 22, 16, 72),
    )

    fill_rounded_rect(
        canvas,
        size,
        doc_x0,
        doc_y0,
        doc_x1,
        doc_y1,
        doc_radius,
        lambda _x, y: (
            clamp(255 - ((y - doc_y0) / max(1, doc_y1 - doc_y0)) * 10),
            clamp(250 - ((y - doc_y0) / max(1, doc_y1 - doc_y0)) * 12),
            clamp(244 - ((y - doc_y0) / max(1, doc_y1 - doc_y0)) * 14),
            255,
        ),
    )

    fold = [
        (doc_x1 - size * 0.15, doc_y0),
        (doc_x1, doc_y0),
        (doc_x1, doc_y0 + size * 0.15),
    ]
    min_x = int(fold[0][0])
    max_x = int(fold[1][0] + 1)
    min_y = int(fold[0][1])
    max_y = int(fold[2][1] + 1)
    for y in range(min_y, max_y):
        for x in range(min_x, max_x):
            px = x + 0.5
            py = y + 0.5
            area = ((fold[1][1] - fold[2][1]) * (fold[0][0] - fold[2][0]) +
                    (fold[2][0] - fold[1][0]) * (fold[0][1] - fold[2][1]))
            a = ((fold[1][1] - fold[2][1]) * (px - fold[2][0]) + (fold[2][0] - fold[1][0]) * (py - fold[2][1])) / area
            b = ((fold[2][1] - fold[0][1]) * (px - fold[2][0]) + (fold[0][0] - fold[2][0]) * (py - fold[2][1])) / area
            c = 1 - a - b
            if a >= 0 and b >= 0 and c >= 0:
                draw_pixel(canvas, size, x, y, (255, 231, 214, 240))

    line_left = int(size * 0.24)
    line_right = int(size * 0.57)
    for idx, y in enumerate((0.29, 0.41, 0.53)):
        y_px = int(size * y)
        thickness = max(1, size // 32)
        tone = 188 - idx * 12
        for yy in range(y_px - thickness, y_px + thickness + 1):
            for xx in range(line_left, line_right):
                draw_pixel(canvas, size, xx, yy, (tone, tone - 8, tone - 18, 180))

    speaker = [
        (size * 0.47, size * 0.57),
        (size * 0.56, size * 0.48),
        (size * 0.56, size * 0.78),
    ]
    neck_x0 = int(size * 0.38)
    neck_x1 = int(size * 0.48)
    neck_y0 = int(size * 0.59)
    neck_y1 = int(size * 0.68)
    for y in range(neck_y0, neck_y1):
        for x in range(neck_x0, neck_x1):
            draw_pixel(canvas, size, x, y, (255, 249, 243, 255))

    min_x = int(min(p[0] for p in speaker))
    max_x = int(max(p[0] for p in speaker) + 1)
    min_y = int(min(p[1] for p in speaker))
    max_y = int(max(p[1] for p in speaker) + 1)
    area = ((speaker[1][1] - speaker[2][1]) * (speaker[0][0] - speaker[2][0]) +
            (speaker[2][0] - speaker[1][0]) * (speaker[0][1] - speaker[2][1]))
    for y in range(min_y, max_y):
        for x in range(min_x, max_x):
            px = x + 0.5
            py = y + 0.5
            a = ((speaker[1][1] - speaker[2][1]) * (px - speaker[2][0]) + (speaker[2][0] - speaker[1][0]) * (py - speaker[2][1])) / area
            b = ((speaker[2][1] - speaker[0][1]) * (px - speaker[2][0]) + (speaker[0][0] - speaker[2][0]) * (py - speaker[2][1])) / area
            c = 1 - a - b
            if a >= 0 and b >= 0 and c >= 0:
                draw_pixel(canvas, size, x, y, (255, 249, 243, 255))

    fill_circle(canvas, size, size * 0.59, size * 0.63, size * 0.025, (255, 249, 243, 255))
    wave_color = (255, 245, 237, 235)
    fill_arc(canvas, size, size * 0.58, size * 0.63, size * 0.15, size * 0.028, -0.92, 0.92, wave_color)
    fill_arc(canvas, size, size * 0.58, size * 0.63, size * 0.225, size * 0.03, -0.92, 0.92, wave_color)

    return canvas_to_png(canvas, size)


def canvas_to_png(canvas, size):
    rows = []
    for y in range(size):
        row = bytearray(b'\x00')
        for x in range(size):
            row.extend(canvas[y * size + x])
        rows.append(bytes(row))
    raw = b''.join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(ctype, data):
        payload = ctype + data
        crc = struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)
        return struct.pack('>I', len(data)) + payload + crc

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', compressed) +
        chunk(b'IEND', b'')
    )


os.makedirs('icons', exist_ok=True)

for sz in (16, 48, 128):
    path = f'icons/icon{sz}.png'
    with open(path, 'wb') as f:
        f.write(generate_icon(sz))
    print(f'  ✓ {path}  ({sz}x{sz})')

print('Done.')
