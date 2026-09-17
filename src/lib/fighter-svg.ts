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
  const parts: string[] = []

  // nogi
  parts.push(
    `<path d="M${x - bodyW * 0.32} 126 L${x - bodyW * 0.55} 168 L${x - bodyW * 0.05} 168 L${
      x - 2
    } 126 Z" fill="${kit}" opacity=".85"/>`,
  )
  parts.push(
    `<path d="M${x + bodyW * 0.05} 126 L${x + bodyW * 0.18} 168 L${x + bodyW * 0.62} 168 L${
      x + bodyW * 0.42
    } 126 Z" fill="${kit}" opacity=".85"/>`,
  )
  // buty
  parts.push(
    `<rect x="${x - bodyW * 0.62}" y="163" width="${bodyW * 0.62}" height="7" rx="2" fill="var(--ink)"/>`,
  )
  parts.push(
    `<rect x="${x + bodyW * 0.12}" y="163" width="${bodyW * 0.58}" height="7" rx="2" fill="var(--ink)"/>`,
  )
  // spodenki
  parts.push(
    `<path d="M${x - bodyW * 0.5} 108 L${x + bodyW * 0.5} 108 L${x + bodyW * 0.56} 132 L${
      x + bodyW * 0.06
    } 128 L${x - bodyW * 0.5} 132 Z" fill="var(--ink)"/>`,
  )
  parts.push(`<rect x="${x - bodyW * 0.5}" y="106" width="${bodyW}" height="5" fill="${kit}"/>`)
  // tors
  const torsoTop = lean ? 64 : 60
  parts.push(
    `<path d="M${x - bodyW * 0.44} ${torsoTop} Q${x} ${torsoTop - 6} ${x + bodyW * 0.44} ${torsoTop} L${
      x + bodyW * 0.52
    } 110 L${x - bodyW * 0.52} 110 Z" fill="${kit}"/>`,
  )
  // tylna ręka i rękawica (schowana)
  parts.push(
    `<g class="arm-rear"><rect x="${x - 6}" y="${shoulderY - 6}" width="22" height="11" rx="5" fill="${kit}" opacity=".75"/>` +
      `<circle cx="${x + 22}" cy="${shoulderY - 2}" r="${gloveR * 0.85}" fill="var(--gold)"/></g>`,
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
  // przednia ręka i rękawica
  parts.push(
    `<g class="arm-lead"><rect x="${x + 2}" y="${shoulderY - 12}" width="26" height="12" rx="6" fill="${kit}"/>` +
      `<circle cx="${x + 32}" cy="${shoulderY - 6}" r="${gloveR}" fill="var(--gold)"/>` +
      `<circle cx="${x + 32}" cy="${shoulderY - 6}" r="${gloveR * 0.45}" fill="var(--ink)" opacity=".18"/></g>`,
  )

  return `<svg viewBox="0 0 120 176" role="img" aria-label="${escapeAttr(f.symbol)}"><g class="fig">${parts.join('')}</g></svg>`
}

/**
 * Symbol tokena idzie do atrybutu SVG, a pochodzi z łańcucha — deployer wpisuje
 * go sam. Bez ucieczki wystarczyłby ticker z cudzysłowem, żeby wyjść z atrybutu.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
