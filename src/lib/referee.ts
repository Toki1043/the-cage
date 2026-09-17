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
  if (fight.winner === null) return 'Nobody moved. The cards came back level.'
  const loser: Side = fight.winner === 'a' ? 'b' : 'a'
  const how = methodText(fight)
  if (fight.method === 'decision') {
    return `By ${how}, ${fight.scorecard[fight.winner]}–${fight.scorecard[loser]} on the cards.`
  }
  return `By ${how}.`
}
