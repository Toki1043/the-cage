/**
 * Sędzia i werdykt — szablon tekstu z policzonego wyniku.
 *
 * Wszystko tutaj jest czystą funkcją wyniku symulacji. Żadne zdanie z tego
 * pliku nie pochodzi od modelu i model nie zna wyniku, na którym te zdania
 * stoją. Sędzia ogłasza to, co policzyła symulacja — nie decyduje
 * (CLAUDE.md § Sędzia).
 *
 * Dlatego werdykt nie jest częścią odpowiedzi `/api/commentary`: w prototypie
 * jedno zdanie o zwycięzcy pisał model, a to znaczyłoby, że model widzi wynik.
 */
import type { FightMethod, FightResult, Side } from './fight'

/** Instrukcje przed pierwszą rundą. */
export const INSTRUCTIONS =
  'Referee: touch gloves, keep it clean, protect yourselves at all times.'

/**
 * Badania przed walką. Sędzia ogłasza wynik, którego nie ustalił — pasmo
 * wyszło z koncentracji podaży policzonej po odsianiu adresów niebędących
 * holderami (CLAUDE.md § Sędzia: sędzia nie decyduje o wyniku).
 *
 * Bez ostrzeżeń o inwestowaniu i bez ocen tokena: zdanie mówi, ile podaży
 * leży w dziesięciu portfelach, i nic więcej.
 */
export function medicalsFailedCall(symbol: string, percent: number): string {
  return (
    `$${symbol} does not pass the pre-fight check: about ${percent.toFixed(1)}% of the ` +
    'holder-held supply sits in ten wallets. Withdrawn from the card.'
  )
}

/** Obaj oblali badania — nie ma z kim walczyć. */
export function fightCancelledCall(a: string, b: string): string {
  return `Both $${a} and $${b} fail the pre-fight check. No contest, the card is off.`
}

export function walkoverCall(winner: string, loser: string): string {
  return `$${winner} takes the walkover. $${loser} never made it to the ring.`
}

/** Szklana szczęka: pierwszy ciężki cios w pierwszej rundzie i koniec. */
export function glassJawCall(symbol: string, percent: number): string {
  return (
    `$${symbol} folds on the first heavy shot — about ${percent.toFixed(1)}% of the ` +
    'holder-held supply in ten wallets, and a jaw to match.'
  )
}

export function knockdownCall(symbol: string): string {
  return `Down goes $${symbol}. The referee picks up the count.`
}

export function standUpCall(symbol: string): string {
  return `$${symbol} is up at eight. We box on.`
}

/** Odliczanie do dziesięciu. To animacja, nie losowanie — wynik już padł. */
export function knockoutCall(symbol: string): string {
  return `$${symbol} is down and not moving. The referee counts to ten.`
}

export function technicalCall(symbol: string, knockdowns: number): string {
  return `${knockdowns} counts in the round. The referee waves it off — $${symbol} has seen enough.`
}

export function judgesCall(): string {
  return 'Referee: to the judges. Collecting the cards.'
}

/** Jak zapadł wynik, po angielsku, z rundą jeśli walka nie doszła do końca. */
export function methodText(fight: Pick<FightResult, 'method' | 'endedInRound' | 'rounds'>): string {
  const method: FightMethod = fight.method
  if (method === 'walkover') return 'walkover, opponent failed the pre-fight check'
  if (method === 'cancelled') return 'no contest — both failed the pre-fight check'
  if (method === 'KO') return `KO in round ${fight.endedInRound}`
  if (method === 'TKO') return `TKO in round ${fight.endedInRound}`
  if (method === 'draw') return 'a draw on the cards'
  return fight.rounds.length === 3
    ? 'decision after three rounds'
    : `decision after ${fight.rounds.length} rounds`
}

/**
 * Zdanie pod nagłówkiem werdyktu. Przy wyniku na punkty dokładamy kartę,
 * bo to ona rozstrzygnęła i da się ją sprawdzić.
 */
export function verdictLine(
  fight: Pick<FightResult, 'method' | 'endedInRound' | 'rounds' | 'scorecard' | 'winner'>,
): string {
  if (fight.method === 'cancelled') {
    return 'Neither fighter passed the pre-fight check. There is no result.'
  }
  if (fight.method === 'walkover') return 'By walkover. There were no rounds to score.'
  if (fight.winner === null) return 'Nobody moved. The cards came back level.'
  const loser: Side = fight.winner === 'a' ? 'b' : 'a'
  const how = methodText(fight)
  if (fight.method === 'decision') {
    return `By ${how}, ${fight.scorecard[fight.winner]}–${fight.scorecard[loser]} on the cards.`
  }
  return `By ${how}.`
}
