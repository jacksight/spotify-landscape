"""Generate the PWA icons with no dependencies (pure-Python PNG writer)."""
import struct, zlib, os

BG = (18, 18, 18)
GREEN = (29, 185, 84)
WHITE = (255, 255, 255)

def png(size, pixel):
    rows = []
    for y in range(size):
        row = bytearray(b'\x00')
        for x in range(size):
            row += bytes(pixel(x, y))
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

def make(size, path):
    cx = cy = size / 2
    r = size * 0.40
    tri = ((cx - r * 0.36, cy - r * 0.52), (cx - r * 0.36, cy + r * 0.52), (cx + r * 0.6, cy))
    def sample(x, y):
        if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
            return BG
        return WHITE if in_triangle(x, y, *tri) else GREEN
    def pixel(x, y):  # 2x2 supersampling for soft edges
        s = [sample(x + dx, y + dy) for dx in (0.25, 0.75) for dy in (0.25, 0.75)]
        return tuple(sum(c[i] for c in s) // 4 for i in range(3))
    with open(path, 'wb') as f:
        f.write(png(size, pixel))

here = os.path.dirname(os.path.abspath(__file__))
for size, name in ((192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')):
    make(size, os.path.join(here, name))
    print('wrote', name)
