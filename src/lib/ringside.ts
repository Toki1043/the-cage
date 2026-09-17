/**
 * Panel „Ringside read": te same liczby w dolarach, czysta arytmetyka.
 *
 * Bez udziału modelu — CLAUDE.md § Panel „Ringside read" i § Czego nie robić:
 * liczby, na których ktoś może stracić pieniądze, nie mogą być wyjściem
 * z modelu. Zdania opisowe są tu stałymi tekstami wybieranymi progiem, też
 * nie modelem.
 */

/** Skrót kwoty do nagłówka: $1,2M, $340K. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n / 1e6 >= 10 ? 0 : 1) + 'M'
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K'
  return '$' + Math.round(n)
}

export function count(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Ile sprzedasz, zanim cena spadnie o 10%.
 *
 * Pula o stałym iloczynie: ~2,7% płynności rusza cenę o dziesiątą część.
 * Przy płynności skoncentrowanej (Uniswap v3/v4) wynik bywa inny w obie
 * strony — dlatego wszędzie obok stoi „about" i zdanie o niepewności.
 */
export function exitWidth(liquidityUsd: number): number {
  return liquidityUsd * 0.027
}

export interface RingsideRead {
  /** Kwota wyjścia przed spadkiem o 10%, „około". */
  exitUsd: number
  /** Ile papieru na $1 wyjścia: kapitalizacja / płynność. */
  paperPerDollar: number
  say: string
}

export function ringsideRead(input: {
  liquidityUsd: number
  marketCapUsd: number
  ageDays: number
}): RingsideRead {
  const { liquidityUsd, marketCapUsd, ageDays } = input
  const paperPerDollar = liquidityUsd > 0 ? marketCapUsd / liquidityUsd : Infinity

  let say: string
  if (paperPerDollar > 40) {
    say =
      'Almost all of that market cap is paper. The door out is tiny compared with what the number claims.'
  } else if (paperPerDollar > 12) {
    say = 'Normal for a young token, but the exit is much smaller than the headline figure.'
  } else {
    say = 'Liquidity is deep relative to the market cap — you can get out of a real position.'
  }
  if (ageDays < 7) say += ' Under a week old, so there is no history to check.'

  return { exitUsd: exitWidth(liquidityUsd), paperPerDollar, say }
}
