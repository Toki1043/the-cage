/**
 * Zawodnik: gotowa grafika (PNG) zamiast rysowanej wektorowo sylwetki —
 * byk w czerwonym narożniku, niedźwiedź w niebieskim. Ten sam patent co przy
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
 * ruchomych kształtów. Cios przełącza wariant przez CSS (`.fighter.punch`
 * pokazuje `.pose-punch` i chowa `.pose-guard`), a nie przez zamianę
 * atrybutu `href`: front i tak tylko przełącza klasę na `.fighter`
 * w `throwPunch()`, więc obraz reaguje na dokładnie to samo zdarzenie,
 * które wcześniej wysuwało rękę.
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
const BEAR_GUARD: ImagePlacement = { file: 'bear-guard.png', x: 26.72, y: FLOOR_Y - HEIGHT, width: 63.93, height: HEIGHT }
const BEAR_PUNCH: ImagePlacement = { file: 'bear-punch.png', x: 24.03, y: FLOOR_Y - HEIGHT, width: 94.36, height: HEIGHT }

function drawPose(art: ImagePlacement, className: string): string {
  return (
    `<image class="${className}" href="/arena/${art.file}" x="${art.x}" y="${art.y}" ` +
    `width="${art.width}" height="${art.height}" preserveAspectRatio="xMidYMid meet"/>`
  )
}

export function drawFighter(f: FighterLook, side: FighterSide): string {
  // Czerwony narożnik: byk. Niebieski: niedźwiedź.
  const [guard, punch] = side === 'a' ? [BULL_GUARD, BULL_PUNCH] : [BEAR_GUARD, BEAR_PUNCH]
  const body = drawPose(guard, 'pose-guard') + drawPose(punch, 'pose-punch')

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
