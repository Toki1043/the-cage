/**
 * Chorągwie pod sufitem hali, po jednej z każdej strony.
 *
 * Czysta scenografia: leżą na warstwie pod całą treścią (z-index niżej niż
 * scena, karty i pasek), nie łapią kliknięć i nie mają znaczenia dla czytników
 * ekranu. Wynik walki, dane i komentarz ich nie dotyczą.
 *
 * Tkanina jest rysowana w siatce komórek (jedna komórka = jeden „piksel"
 * sztuki, wielkość z `--cell` w CSS), a nie jednym obrazkiem — dzięki temu
 * skaluje się ostro w całości liczbami całkowitymi i nie ma pliku więcej do
 * utrzymania. Wyjątek to logo: `public/arena/orbio-logo.png`, wkładane jako
 * `<image>` w to samo płótno. To wycięcie z oryginału (`public/orbio logo.jpg`,
 * jasne tło z siatką): sama kula i pierścień na przezroczystym tle, żeby nie
 * wisiał na chorągwi jasny prostokąt. Kształtu ani kolorów logo nie ruszamy;
 * wpisuje je w ciemną tkaninę tylko przygaszenie (`opacity`) i dwa stopnie
 * ciemnej tarczy pod spodem, rysowane w tej samej siatce komórek co reszta.
 * Bez pliku przeglądarka pokaże w tym miejscu ikonę uszkodzonego obrazka.
 *
 * Położenie i rozmiar liczy CSS (`globals.css`, sekcja „chorągwie”): chorągwie
 * wiszą w wolnym pasie między kolumną kart a paskiem adresów, więc niczego nie
 * zasłaniają, a tam, gdzie takiego pasa nie ma (ekran węższy niż 92rem),
 * nie ma ich wcale.
 *
 * Lewa chorągiew ma pasek w kolorze czerwonego narożnika, prawa — niebieskiego.
 * Reszta (kształt, złote obszycie, gwiazdki) jest wspólna, więc układ jest
 * symetryczny.
 */

const W = 19 // szerokość tkaniny w komórkach; nieparzysta, żeby gwiazdka wypadła w osi
const BODY_H = 48 // wysokość tkaniny z ogonem
const TAIL_AT = 36 // od tego wiersza tkanina zwęża się do czubka
const TAIL_STEP = 9 // o ile komórek zwęża się z każdej strony do ostatniego wiersza
const ROD_H = 3 // drążek na górze, szerszy od tkaniny o komórkę z każdej strony

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`

// Logo: 11x11 komórek w osi tkaniny, wewnątrz lampasa (komórki 3..15). Środek w komórkach.
const LOGO = { x: 4, y: 8, size: 11 }
const LOGO_C = { x: LOGO.x + LOGO.size / 2, y: LOGO.y + LOGO.size / 2 }

/** Tarcza o promieniu `R` z całych komórek (piksel sztuki), wiersz po wierszu. */
function disc(R: number): string {
  const rows: string[] = []
  for (let y = Math.floor(LOGO_C.y - R); y < Math.ceil(LOGO_C.y + R); y++) {
    const dy = y + 0.5 - LOGO_C.y
    const half = Math.sqrt(R * R - dy * dy)
    if (Number.isNaN(half)) continue
    const x0 = Math.ceil(LOGO_C.x - half - 0.5)
    const x1 = Math.floor(LOGO_C.x + half - 0.5)
    if (x1 >= x0) rows.push(rect(x0, y, x1 - x0 + 1, 1))
  }
  return rows.join('')
}

/** Lewa i prawa krawędź tkaniny w wierszu `y` (prawa wyłączna). */
function span(y: number): [number, number] {
  const inset =
    y < TAIL_AT ? 0 : Math.min(TAIL_STEP - 1, Math.floor(((y - TAIL_AT) * TAIL_STEP) / (BODY_H - TAIL_AT)))
  return [inset, W - inset]
}

/**
 * Ścieżki SVG pogrupowane kolorami, w kolejności rysowania. Jedna ścieżka na
 * kolor zamiast kilkuset `<rect>`.
 */
function buildCloth() {
  const cloth: string[] = []
  const lit: string[] = []
  const fold: string[] = []
  const trim: string[] = []
  const outline: string[] = []
  const band: string[] = []
  const star: string[] = []

  for (let y = 0; y < BODY_H; y++) {
    const [l, r] = span(y)
    cloth.push(rect(l, y, r - l, 1))

    // Obrys: w ogonie wiersz jest szerszy o skok do następnego wiersza, żeby
    // ukośna krawędź była ciągła, a nie łańcuszkiem pikseli stykających się rogami.
    const jump = y < BODY_H - 1 ? span(y + 1)[0] - l : 0
    const w = Math.max(1, jump + 1)
    if (y === 0) outline.push(rect(0, 0, W, 1))
    else if (r - l > 2 * w) {
      outline.push(rect(l, y, w, 1))
      outline.push(rect(r - w, y, w, 1))
    } else outline.push(rect(l, y, r - l, 1))

    // Wewnętrzny, ciemniejszy lampas w odstępie dwóch komórek od obrysu.
    if (y === 2) trim.push(rect(2, y, W - 4, 1))
    else if (y > 2 && r - l > 10) {
      trim.push(rect(l + 2, y, w, 1))
      trim.push(rect(r - 2 - w, y, w, 1))
    }

    // Fałdy: dwie pionowe kreski, tylko tam, gdzie mieszczą się w tkaninie.
    if (y >= 4 && y < BODY_H - 6) {
      for (const x of [6, 12]) if (x > l + 3 && x < r - 4) fold.push(rect(x, y, 1, 1))
    }
  }

  // Jaśniejszy pas u góry: tkanina najbliżej reflektorów.
  lit.push(rect(3, 3, W - 6, 2))

  band.push(rect(3, 23, W - 6, 2)) // pas w kolorze narożnika
  star.push(rect(3, 27, W - 6, 1)) // cienka złota linia pod nim
  for (const cx of [5, 9, 13]) {
    star.push(rect(cx - 1, 31, 3, 1), rect(cx, 30, 1, 3))
  }

  return {
    glowOuter: disc(6.4),
    glowInner: disc(4.7),
    cloth: cloth.join(''),
    lit: lit.join(''),
    fold: fold.join(''),
    trim: trim.join(''),
    outline: outline.join(''),
    band: band.join(''),
    star: star.join(''),
  }
}

const CLOTH = buildCloth()

function Banner({ side }: { side: 'left' | 'right' }) {
  return (
    <div className={`banner ${side}`}>
      <div className="banner-sway">
        <i className="banner-cable" style={{ left: 'calc(var(--cell) * 4)' }} />
        <i className="banner-cable" style={{ left: 'calc(var(--cell) * (var(--banner-w) - 2.5))' }} />
        <svg
          className="banner-svg"
          viewBox={`-1 0 ${W + 2} ${ROD_H + BODY_H}`}
          shapeRendering="crispEdges"
          focusable="false"
        >
          {/* drążek */}
          <path className="bn-rod" d={rect(-1, 0, W + 2, 2)} />
          <path className="bn-rod-under" d={rect(-1, 2, W + 2, 1)} />
          <g transform={`translate(0 ${ROD_H})`}>
            <path className="bn-cloth" d={CLOTH.cloth} />
            <path className="bn-lit" d={CLOTH.lit} />
            <path className="bn-fold" d={CLOTH.fold} />
            <path className="bn-trim" d={CLOTH.trim} />
            <path className="bn-band" d={CLOTH.band} />
            <path className="bn-gold" d={CLOTH.star} />
            <path className="bn-glow-outer" d={CLOTH.glowOuter} />
            <path className="bn-glow-inner" d={CLOTH.glowInner} />
            <image
              href="/arena/orbio-logo.png"
              x={LOGO.x}
              y={LOGO.y}
              width={LOGO.size}
              height={LOGO.size}
              opacity={0.86}
              preserveAspectRatio="xMidYMid meet"
            />
            <path className="bn-gold" d={CLOTH.outline} />
          </g>
        </svg>
      </div>
    </div>
  )
}

export function HallBanners() {
  return (
    <div className="hall-banners" aria-hidden>
      <Banner side="left" />
      <Banner side="right" />
    </div>
  )
}
