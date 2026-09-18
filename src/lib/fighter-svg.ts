/**
 * Zawodnik rysowany proceduralnie jako SVG, z liczb z łańcucha.
 *
 * Przeniesione z prototypu bez zmian w geometrii — sylwetka ma wyglądać
 * dokładnie tak samo. Zmieniło się tylko źródło liczb: wcześniej wpisywane
 * ręcznie, teraz statystyki policzone z Codexu.
 *
 * Proceduralnie, nie jako wygenerowany obrazek: obrazek jest statyczny
 * i nie umie się ruszać (CLAUDE.md § Sędzia).
 *
 * Czysta funkcja, bez DOM i bez sieci — działa i po stronie serwera.
 *
 * Sylwetka jest pocięta na grupy, bo każdy ruch potrzebuje własnego
 * `transform`. Dwa ruchy na jednej grupie znaczą, że drugi wymazuje pierwszy:
 * `transform` jest jedną własnością, nie listą, więc chwianie na tej samej
 * grupie co wykrok zniosłoby wykrok. Zagnieżdżenie je składa.
 *
 *   .fig      przewrót na deski i szarpnięcie po ciosie (było wcześniej)
 *   .sway     chwianie przy niskim pasku życia
 *   .stance   wykrok przy ciosie, cofnięcie po nim, odskok przy uniku
 *   .leg-rear / .leg-lead   krok: tylna stopa zostaje, przednia wychodzi
 *   .torso    obrót tułowia w cios
 *   .head     odskok głowy przy trafieniu (było wcześniej)
 *   .arm-lead / .arm-rear   ciosy obiema rękami i opuszczanie gardy
 *
 * Geometria się nie zmieniła — te same kształty w tych samych miejscach,
 * tylko opakowane. Kolejność rysowania butów i nóg przeszła z „obie nogi,
 * potem oba buty" na „noga z butem, noga z butem"; kształty nie zachodzą
 * na siebie w poziomie, więc na obrazie nie widać różnicy.
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

export function drawFighter(f: FighterLook, side: FighterSide): string {
  const kit = side === 'a' ? 'var(--red)' : 'var(--blue)'
  const bodyW = 26 + f.stamina * 0.24 // płynność = ile go jest
  const gloveR = 8.5 + f.power * 0.075 // cienka płynność = ciężkie ręce
  const young = f.ageDays < 45
  const old = f.ageDays > 200
  const lean = f.stamina < 35
  const x = 60 // linia środkowa
  const shoulderY = 84
  const wheels = side === 'a' // czerwony narożnik: koła rowerowe zamiast rękawic
  const parts: string[] = []

  // Nogi z butami, każda w swojej grupie. Przednia jest ta po stronie +x, bo
  // tam stoi przeciwnik: +x to zawsze „do przodu", a stronę B odbija lustrem
  // `transform:scaleX(-1)` na całym SVG. Dzięki temu wykrok nie potrzebuje
  // dwóch wersji dla dwóch narożników.
  parts.push(
    `<g class="leg-rear"><path d="M${x - bodyW * 0.32} 126 L${x - bodyW * 0.55} 168 L${
      x - bodyW * 0.05
    } 168 L${x - 2} 126 Z" fill="${kit}" opacity=".85"/>` +
      `<rect x="${x - bodyW * 0.62}" y="163" width="${bodyW * 0.62}" height="7" rx="2" fill="var(--ink)"/></g>`,
  )
  parts.push(
    `<g class="leg-lead"><path d="M${x + bodyW * 0.05} 126 L${x + bodyW * 0.18} 168 L${
      x + bodyW * 0.62
    } 168 L${x + bodyW * 0.42} 126 Z" fill="${kit}" opacity=".85"/>` +
      `<rect x="${x + bodyW * 0.12}" y="163" width="${bodyW * 0.58}" height="7" rx="2" fill="var(--ink)"/></g>`,
  )
  // spodenki
  parts.push(
    `<path d="M${x - bodyW * 0.5} 108 L${x + bodyW * 0.5} 108 L${x + bodyW * 0.56} 132 L${
      x + bodyW * 0.06
    } 128 L${x - bodyW * 0.5} 132 Z" fill="var(--ink)"/>`,
  )
  parts.push(`<rect x="${x - bodyW * 0.5}" y="106" width="${bodyW}" height="5" fill="${kit}"/>`)
  // Tors, a w nim głowa i obie ręce: obrót tułowia ma je ciągnąć za sobą,
  // tak jak w ciele. Grupa zamyka się na końcu, po przedniej rękawicy.
  const torsoTop = lean ? 64 : 60
  parts.push(
    `<g class="torso"><path d="M${x - bodyW * 0.44} ${torsoTop} Q${x} ${torsoTop - 6} ${
      x + bodyW * 0.44
    } ${torsoTop} L${x + bodyW * 0.52} 110 L${x - bodyW * 0.52} 110 Z" fill="${kit}"/>`,
  )
  // tylna ręka i rękawica (schowana) — u czerwonego koło roweru, ten sam środek i promień
  const rearFistCx = x + 22
  const rearFistCy = shoulderY - 2
  const rearFistR = gloveR * 0.85
  parts.push(
    `<g class="arm-rear"><rect x="${x - 6}" y="${shoulderY - 6}" width="22" height="11" rx="5" fill="${kit}" opacity=".75"/>` +
      (wheels
        ? drawWheel(rearFistCx, rearFistCy, rearFistR)
        : `<circle cx="${rearFistCx}" cy="${rearFistCy}" r="${rearFistR}" fill="var(--gold)"/>`) +
      `</g>`,
  )
  // głowa
  let headParts = `<circle cx="${x}" cy="52" r="19" fill="${kit}"/>`
  headParts += `<rect x="${x - 7}" y="66" width="14" height="8" fill="${kit}"/>` // szyja
  headParts += `<rect class="brow" x="${x + 3}" y="46" width="14" height="3.5" rx="1.7" fill="var(--ink)"/>` // brew
  headParts += `<circle cx="${x + 9}" cy="54" r="2.2" fill="var(--ink)"/>` // oko
  headParts += `<rect x="${x + 6}" y="61" width="9" height="2.4" rx="1.2" fill="var(--ink)" opacity=".8"/>` // usta
  if (young) {
    // opaska
    headParts += `<path d="M${x - 19} 44 Q${x} 36 ${x + 19} 44 L${x + 19} 39 Q${x} 31 ${x - 19} 39 Z" fill="var(--gold)"/>`
  }
  if (old) {
    // broda
    headParts += `<path d="M${x - 4} 62 Q${x + 8} 78 ${x + 17} 60 Q${x + 8} 70 ${x - 4} 62 Z" fill="var(--ink)" opacity=".55"/>`
  }
  parts.push(`<g class="head">${headParts}</g>`)
  // przednia ręka i rękawica — u czerwonego koło roweru, ten sam środek i promień
  const leadFistCx = x + 32
  const leadFistCy = shoulderY - 6
  parts.push(
    `<g class="arm-lead"><rect x="${x + 2}" y="${shoulderY - 12}" width="26" height="12" rx="6" fill="${kit}"/>` +
      (wheels
        ? drawWheel(leadFistCx, leadFistCy, gloveR)
        : `<circle cx="${leadFistCx}" cy="${leadFistCy}" r="${gloveR}" fill="var(--gold)"/>` +
          `<circle cx="${leadFistCx}" cy="${leadFistCy}" r="${gloveR * 0.45}" fill="var(--ink)" opacity=".18"/>`) +
      `</g>`,
  )
  parts.push('</g>') // koniec torsu

  return (
    `<svg viewBox="0 0 120 176" role="img" aria-label="${escapeAttr(f.symbol)}">` +
    `<g class="fig"><g class="sway"><g class="stance">${parts.join('')}</g></g></g></svg>`
  )
}

/**
 * Koło rowerowe w miejscu pięści: obręcz, kilka szprych, piasta — ten sam
 * środek i promień co usunięta rękawica, więc `.arm-lead`/`.arm-rear` obracają
 * je tak samo jak wcześniej okrągłą rękawicę.
 */
function drawWheel(cx: number, cy: number, r: number): string {
  const spokes = Array.from({ length: 5 }, (_, i) => {
    const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2
    const x2 = cx + r * 0.8 * Math.cos(angle)
    const y2 = cy + r * 0.8 * Math.sin(angle)
    return `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="var(--gold)" stroke-width="1.3"/>`
  }).join('')
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--ink)" stroke-width="${(r * 0.3).toFixed(2)}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.8).toFixed(2)}" fill="none" stroke="var(--gold)" stroke-width="1"/>` +
    spokes +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.16).toFixed(2)}" fill="var(--ink)"/>`
  )
}

/**
 * Symbol tokena idzie do atrybutu SVG, a pochodzi z łańcucha — deployer wpisuje
 * go sam. Bez ucieczki wystarczyłby ticker z cudzysłowem, żeby wyjść z atrybutu.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
