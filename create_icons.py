#!/usr/bin/env python3
"""Generate simple PNG icons for the Chrome extension."""
import struct, zlib, os

def create_png(size, bg_r, bg_g, bg_b):
    """Create a simple rounded-rectangle PNG icon."""
    width = height = size
    radius = size // 4  # corner radius

    def in_rounded_rect(x, y):
        """Check if (x, y) is inside a rounded rectangle."""
        # Inset by 1px border
        margin = max(1, size // 16)
        x0, y0 = margin, margin
        x1, y1 = width - margin - 1, height - margin - 1
        rx = ry = radius

        if x < x0 or x > x1 or y < y0 or y > y1:
            return False

        # Check corners
        corners = [
            (x0 + rx, y0 + ry),  # top-left
            (x1 - rx, y0 + ry),  # top-right
            (x0 + rx, y1 - ry),  # bottom-left
            (x1 - rx, y1 - ry),  # bottom-right
        ]
        for cx, cy in corners:
            dx = abs(x - cx) - 0
            dy = abs(y - cy) - 0
            if (x < cx if cx == corners[0][0] or cx == corners[2][0] else x > cx) and \
               (y < cy if cy == corners[0][1] or cy == corners[1][1] else y > cy):
                if dx * dx + dy * dy > rx * ry:
                    return False
        return True

    # Build RGBA pixel data
    rows = []
    for y in range(height):
        row = b'\x00'  # PNG filter: None
        for x in range(width):
            if in_rounded_rect(x, y):
                row += bytes([bg_r, bg_g, bg_b, 255])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(row)

    raw = b''.join(rows)
    compressed = zlib.compress(raw)

    # Build PNG file
    def chunk(ctype, data):
        c = ctype + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack('>I', len(data)) + c + crc

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', compressed) +
        chunk(b'IEND', b'')
    )

os.makedirs('icons', exist_ok=True)

# Google-blue background: #4285F4  →  (66, 133, 244)
for sz in (16, 48, 128):
    path = f'icons/icon{sz}.png'
    with open(path, 'wb') as f:
        f.write(create_png(sz, 66, 133, 244))
    print(f'  ✓ {path}  ({sz}×{sz})')

print('Done.')
