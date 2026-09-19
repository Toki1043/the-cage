/**
 * Zawodnik: gotowa grafika (PNG) zamiast rysowanej wektorowo sylwetki —
 * byk w czerwonym narożniku, rowerowy stwór (`bikeT.png`) w niebieskim. Ten sam patent co przy
 * sędzim w `referee-svg.ts`: `<image>` osadzony w SVG, więc geometria
 * (viewBox 120×176, podłoga na y=168) i cała otoczka animacji zostają.
 *
 * Sylwetka trzyma się tych samych trzech zagnieżdżonych grup co wcześniej:
 *
 *   .fig      przewrót na deski i szarpnięcie po ciosie
 *   .sway     chwianie przy niskim pasku życia
 *   .stance   wykrok przy ciosie, cofnięcie po nim
 *
 * Rąk, nóg, głowy osobno już nie ma — to jeden płaski obrazek, nie kilka
 * ruchomych kształtów. Byk ma dwie pozy: cios przełącza wariant przez CSS
 * (`.fighter.punch` pokazuje `.pose-punch` i chowa `.pose-guard`), a nie przez
 * zamianę atrybutu `href`: front i tak tylko przełącza klasę na `.fighter`
 * w `throwPunch()`, więc obraz reaguje na dokładnie to samo zdarzenie,
 * które wcześniej wysuwało rękę.
 *
 * Niebieski ma jedną pozę i patrzy w lewo — w stronę czerwonego — więc nie jest
 * odbijany lustrzanie, jak był niedźwiedź (który patrzył w prawo). Zamiast
 * podmiany obrazka cios to ruch całej grupy `.stance`: wykrok w stronę
 * przeciwnika z lekkim pochyleniem i powrót. Kierunki tych ruchów są w CSS
 * podane wprost dla `.fighter.b`, bo odbicie, które je kiedyś odwracało
 * automatycznie, już nie istnieje.
 */

export interface FighterLook {
  symbol: string
  /** Wytrzymałość 0–100: płynność, czyli ile go w ogóle jest. */
  stamina: number
  /** Siła 0–100: cienka płynność to ciężkie ręce. */
  power: number
  /** Wiek pary w dniach: opaska dla młodych, broda dla starych. */
  ageDays: number
}

export type FighterSide = 'a' | 'b'

const FLOOR_Y = 168

/**
 * Wspólna wysokość widocznej postaci dla obu zwierząt i obu wariantów —
 * w proporcji do sędziego (92 jednostki w `referee-svg.ts`), ale dobrana
 * tak nisko, żeby wyciągnięta ręka z `*-punch.png` (najszersza klatka)
 * zmieściła się w szerokości viewBoxa i się nie ucinała. Wyżej i pięść
 * bul-a wychodziła poza 120 jednostek szerokości.
 */
const HEIGHT = 100
/*
 * Liczby w tym pliku są w jednostkach viewBoxa. Rozmiar na ekranie to te
 * jednostki razy `--fighter-scale` z CSS (`transform: scale()` na `<svg>`,
 * z punktem zaczepienia na podłodze y=168), więc powiększenie zawodników nie
 * zmienia ani układu areny, ani linii, na której stoją stopy.
 */

interface ImagePlacement {
  file: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Położenia policzone z pomiarów obu obrazków na zwierzę, nie na oko — tak
 * samo jak `BODY`/`CLUB` w `referee-svg.ts`. Treść obu plików styka się
 * z każdą krawędzią kanwy (róg do rogu, kopyta do dołu), więc cała kanwa
 * liczy się jako "figura" przy skalowaniu do `HEIGHT`. Poziomo obrazek jest
 * wyśrodkowany na środku ciężkości stóp (dolne ~12% wysokości) w x=60 —
 * dzięki temu tors nie przeskakuje w bok przy zmianie z gardy na cios,
 * mimo że wyciągnięta ręka przesuwa środek całego obrazka.
 */
const BULL_GUARD: ImagePlacement = { file: 'bull-guard.png', x: 30.01, y: FLOOR_Y - HEIGHT, width: 59.29, height: HEIGHT }
const BULL_PUNCH: ImagePlacement = { file: 'bull-punch.png', x: 23.31, y: FLOOR_Y - HEIGHT, width: 85.16, height: HEIGHT }
/**
 * Niebieski: `bikeT.png`, 400×400 z przezroczystym tłem, jedna poza.
 *
 * Plik jest przeskalowany z oryginału 1000×1000 (zostaje obok jako
 * `bikeT-original.png`, ignorowany przez git): 790 KB na obrazek to
 * marnowanie transferu. Płótno jest rysowane w ~197 px (154 px × skala
 * zawodników z CSS, `--fighter-scale`), czyli ~394 px na ekranie retina, więc
 * 400 px daje tam skalowanie około 1:1. Pomiary poniżej są z TEGO pliku — po
 * zmianie rozmiaru trzeba je zmierzyć od nowa, bo stałe są w pikselach.
 *
 * W przeciwieństwie do obrazków byka i niedźwiedzia treść NIE styka się
 * z krawędziami kanwy — wokół jest przezroczysty margines. Pomiar z kanału
 * alfa (piksele o alfa > 16): treść zajmuje x 26–394 i y 14–393, koła stoją
 * na dole (y 393). Dlatego skala liczy się od wysokości *treści*, a obrazek
 * jest przesunięty tak, żeby dolna krawędź kół leżała na podłodze (y=168),
 * a środek ciężkości kół (x≈216 px z 400, czyli 54% szerokości, nie środek
 * bboxa 210) — w x=60.
 *
 * Wysokość 84 jednostek to dobór na oko do byka (100) i sędziego (92):
 * postać jest niska i długa jak zwierzę czworonożne, więc ta sama wysokość co
 * u byka dawałaby stwora szerokiego na 97 z 120 jednostek, a głowa jest u niej
 * duża (~30% wysokości). Przy 84 głowa dorównuje bykowi, a całość mieści się
 * w viewBoxie z zapasem na wykrok (svg przycina to, co wychodzi poza 120×176).
 */
const BIKE_CANVAS = 400
const BIKE_CONTENT_TOP = 14
const BIKE_CONTENT_BOTTOM = 393
const BIKE_FEET_X = 216
const BIKE_HEIGHT = 84

const BIKE_SCALE = BIKE_HEIGHT / (BIKE_CONTENT_BOTTOM - BIKE_CONTENT_TOP)
const round2 = (n: number) => Math.round(n * 100) / 100
const BIKE: ImagePlacement = {
  file: 'bikeT.png',
  x: round2(60 - BIKE_FEET_X * BIKE_SCALE),
  y: round2(FLOOR_Y - BIKE_CONTENT_BOTTOM * BIKE_SCALE),
  width: round2(BIKE_CANVAS * BIKE_SCALE),
  height: round2(BIKE_CANVAS * BIKE_SCALE),
}

function drawPose(art: ImagePlacement, className: string): string {
  return (
    `<image class="${className}" href="/arena/${art.file}" x="${art.x}" y="${art.y}" ` +
    `width="${art.width}" height="${art.height}" preserveAspectRatio="xMidYMid meet"/>`
  )
}

export function drawFighter(f: FighterLook, side: FighterSide): string {
  // Czerwony narożnik: byk, dwie pozy. Niebieski: rowerowy stwór, jedna poza —
  // bez pary guard/punch i bez klas przełączających warianty.
  const body =
    side === 'a'
      ? drawPose(BULL_GUARD, 'pose-guard') + drawPose(BULL_PUNCH, 'pose-punch')
      : drawPose(BIKE, 'pose-single')

  return (
    `<svg viewBox="0 0 120 176" role="img" aria-label="${escapeAttr(f.symbol)}">` +
    `<g class="fig"><g class="sway"><g class="stance">${body}</g></g></g></svg>`
  )
}

/**
 * Symbol tokena idzie do atrybutu SVG, a pochodzi z łańcucha — deployer wpisuje
 * go sam. Bez ucieczki wystarczyłby ticker z cudzysłowem, żeby wyjść z atrybutu.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
