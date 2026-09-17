"""
Odzyskanie przezroczystości po spłaszczeniu na biel.

`sips` przy skalowaniu zrzuca kanał alfa i wypełnia tło bielą. Zamiast
generować obrazek ponownie (to kosztuje), wycinamy tło wypełnieniem od
czterech krawędzi: postać ma grube czarne obrysy, więc wypełnienie nie
przedostaje się do środka i białka oczu zostają białe.

Krawędź wygładzamy: piksele sąsiadujące z wyciętym tłem dostają alfę
proporcjonalną do tego, jak bardzo są białe — bez tego na ciemnym tle areny
zostaje jasna obwódka.
"""
import sys
from collections import deque
from PIL import Image

path, tol = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 80
img = Image.open(path).convert('RGBA')
w, h = img.size
px = img.load()

MODE = sys.argv[3] if len(sys.argv) > 3 else 'light'

def is_background(p, t):
    """
    Tło: piksel już przezroczysty, albo pasujący do trybu.

    `light` — biel i jasna szarość. Dwa źródła: prawdziwa alfa spłaszczona
    przez `sips` na biel, oraz wmalowana szachownica przezroczystości
    (szarości 190 i 230), którą model rysuje jako treść obrazka.

    `dark`  — ciemne tło z poświatą, jakie modele dokładają postaciom
    w stylu maskotki. Działa tylko wtedy, gdy postać ma jasny kontur:
    wypełnienie idzie od krawędzi i zatrzymuje się na nim, więc ciemne
    partie samej postaci zostają, bo są zamknięte w środku.
    """
    r, g, b, a = p
    if a == 0:
        return True
    if MODE == 'dark':
        return max(r, g, b) <= t
    return max(r, g, b) - min(r, g, b) <= 12 and min(r, g, b) >= 255 - t

outside = bytearray(w * h)
queue = deque()
for x in range(w):
    for y in (0, h - 1):
        if is_background(px[x, y], tol):
            queue.append((x, y)); outside[y * w + x] = 1
for y in range(h):
    for x in (0, w - 1):
        if is_background(px[x, y], tol):
            queue.append((x, y)); outside[y * w + x] = 1

while queue:
    x, y = queue.popleft()
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and not outside[ny * w + nx] and is_background(px[nx, ny], tol):
            outside[ny * w + nx] = 1
            queue.append((nx, ny))

# Wycięcie i zmiękczenie krawędzi.
soft = 0
for y in range(h):
    for x in range(w):
        i = y * w + x
        if outside[i]:
            px[x, y] = (0, 0, 0, 0)
            continue
        touches = any(
            0 <= x + dx < w and 0 <= y + dy < h and outside[(y + dy) * w + x + dx]
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        )
        if touches:
            r, g, b, a = px[x, y]
            if MODE == 'dark':
                level = max(r, g, b) / 255
                if level < 0.55:
                    px[x, y] = (r, g, b, int(a * min(1.0, level / 0.55)))
                    soft += 1
            else:
                whiteness = min(r, g, b) / 255
                if whiteness > 0.62:
                    px[x, y] = (r, g, b, int(a * max(0.0, (1 - whiteness) / 0.38)))
                    soft += 1

img.save(path)
cut = sum(outside)
print(f'{path}: wyciete {cut} px ({cut / (w * h):.0%}), zmiekczonych {soft}')
