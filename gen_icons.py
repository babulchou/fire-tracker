import struct, zlib

def create_png(w, h, px):
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(px[y][x])
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

def make_icon(size):
    pixels = []
    cx, cy = size/2, size/2
    radius = size * 0.45
    for y in range(size):
        row = []
        for x in range(size):
            dist = ((x-cx)**2 + (y-cy)**2)**0.5
            if dist < radius:
                t = dist / radius
                r = int(100 + 60*t)
                g = int(70 + 50*t)
                b = int(220 - 20*t)
                # flame
                fd = ((x-cx)**2 + (y-cy-size*0.02)**2)**0.5
                fr = size * 0.16
                if fd < fr:
                    ft = fd / fr
                    r = int(251*(1-ft) + 200*ft)
                    g = int(191*(1-ft) + 130*ft)
                    b = int(36*(1-ft) + 180*ft)
            else:
                r, g, b = 11, 14, 20
            row.append((min(255,max(0,r)), min(255,max(0,g)), min(255,max(0,b))))
        pixels.append(row)
    return pixels

for s in [192, 512]:
    data = create_png(s, s, make_icon(s))
    with open(f'icons/icon-{s}.png', 'wb') as f:
        f.write(data)
    print(f'icon-{s}.png OK')
