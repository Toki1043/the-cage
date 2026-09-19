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

/* ------------------------------------------------------------------ */
/* Zdanie porównawcze pod panelem                                      */
/* ------------------------------------------------------------------ */

/**
 * Co wchodzi do zdania: tylko liczby ze snapshotu tej walki i licznik portfeli
 * z odpowiedzi `/api/fight`. Symbole są już oczyszczone (`tick()` na froncie).
 */
export interface HeadlineToken {
  symbol: string
  liquidityUsd: number
  volume24hUsd: number
  /**
   * Udział dziesięciu największych holderów, 0–100, **po odsiewie** adresów
   * niebędących holderami. `null`, gdy koncentracji nie da się policzyć — dziś
   * tak jest zawsze, bo salda holderów wymagają planu Growth w Codexie
   * (`Not authorized: please upgrade your plan`). Surowe `top10HoldersPercent`
   * tu nie wchodzi: zawiera pule płynności i adres spalania (`concentration.ts`).
   */
  concentrationPercent: number | null
  /** Ile obserwowanych portfeli (GOAT WALLETS) trzyma tokena; `null` bez listy. */
  walletsHolding: number | null
}

export type HeadlineKind = 'concentration' | 'turnover' | 'wallets' | 'exit'

/**
 * Snapshot tokena → dane zdania. Koncentracja wchodzi wyłącznie ze statusu `ok`
 * i z liczby po odsiewie (`top10Percent`); `unavailable` (dziś: plan Growth) i
 * `insufficient` (mniej niż dziesięciu holderów po odsiewie) dają `null`, a
 * `rawTop10Percent` nigdy — to liczba do audytu, nie do zdań ani progów.
 */
export function headlineToken(
  symbol: string,
  snapshot: {
    liquidityUsd: number
    volume24hUsd: number
    concentration?: { status: string; top10Percent: number | null } | null
  },
  walletsHolding: number | null,
): HeadlineToken {
  const c = snapshot.concentration
  return {
    symbol,
    liquidityUsd: snapshot.liquidityUsd,
    volume24hUsd: snapshot.volume24hUsd,
    concentrationPercent: c?.status === 'ok' ? c.top10Percent : null,
    walletsHolding,
  }
}

/**
 * Progi „wyraźnej różnicy". Każda różnica jest dzielona przez swój próg, więc
 * trzy różne miary (punkty procentowe, krotność, liczba portfeli) dają wynik
 * w tej samej skali: 1 = dokładnie na progu, 2 = dwa razy ostrzej.
 *
 * - koncentracja: 10 punktów procentowych między tokenami;
 * - rotacja (obrót 24h / płynność): jedna dwa razy większa od drugiej, przy czym
 *   obie liczone od dołu do 1% dziennie, żeby 0,1% vs 0,4% nie liczyło się jako
 *   „4×", skoro oba tokeny stoją praktycznie w miejscu;
 * - portfele: różnica co najmniej 10% listy i co najmniej 3 portfele (na krótkiej
 *   liście jeden portfel to 10%, a to szum).
 */
export const HEADLINE_THRESHOLDS = {
  concentrationPoints: 10,
  turnoverRatio: 2,
  turnoverFloor: 0.01,
  walletShare: 0.1,
  walletMin: 3,
  /** Wyjście z pozycji: poniżej tej krotności to szum, nie różnica. */
  exitRatio: 1.2,
} as const

/** Kolejność rozstrzyga remis wyniku: tak, jak wymienione w specyfikacji zdania. */
const PRIORITY: HeadlineKind[] = ['concentration', 'turnover', 'wallets']

interface Candidate {
  kind: Exclude<HeadlineKind, 'exit'>
  /** Różnica podzielona przez próg; ≥ 1 znaczy „różnicuje wyraźnie". */
  score: number
  text: string
}

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n)

/** Rotacja płynności: obrót 24h / płynność. `null` bez płynności (dzielenie przez zero). */
export function turnover(volume24hUsd: number, liquidityUsd: number): number | null {
  return liquidityUsd > 0 && Number.isFinite(volume24hUsd) ? Math.max(0, volume24hUsd) / liquidityUsd : null
}

const percentOf = (share: number) => (share < 0.01 ? '<1%' : `${count(share * 100)}%`)
const points = (p: number) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`

function concentrationCandidate(a: HeadlineToken, b: HeadlineToken): Candidate | null {
  const pa = a.concentrationPercent
  const pb = b.concentrationPercent
  // Brak liczby po którejkolwiek stronie: wariantu po cichu nie ma.
  if (!finite(pa) || !finite(pb)) return null
  return {
    kind: 'concentration',
    score: Math.abs(pa - pb) / HEADLINE_THRESHOLDS.concentrationPoints,
    text:
      `The ten largest wallets hold about ${points(pa)} of $${a.symbol}'s holder-held supply ` +
      `and about ${points(pb)} of $${b.symbol}'s.`,
  }
}

function turnoverCandidate(a: HeadlineToken, b: HeadlineToken): Candidate | null {
  const va = turnover(a.volume24hUsd, a.liquidityUsd)
  const vb = turnover(b.volume24hUsd, b.liquidityUsd)
  if (va === null || vb === null) return null
  const floor = HEADLINE_THRESHOLDS.turnoverFloor
  const ratio = Math.max(va, vb, floor) / Math.max(Math.min(va, vb), floor)
  return {
    kind: 'turnover',
    score: Math.log(ratio) / Math.log(HEADLINE_THRESHOLDS.turnoverRatio),
    text:
      `$${a.symbol} turned over about ${percentOf(va)} of its liquidity in the last 24 hours; ` +
      `$${b.symbol} about ${percentOf(vb)}.`,
  }
}

function walletsCandidate(a: HeadlineToken, b: HeadlineToken, watched: number | null): Candidate | null {
  const wa = a.walletsHolding
  const wb = b.walletsHolding
  if (!finite(wa) || !finite(wb) || !finite(watched) || watched <= 0) return null
  const needed = Math.max(HEADLINE_THRESHOLDS.walletMin, HEADLINE_THRESHOLDS.walletShare * watched)
  // Sama liczba, bez oceny i bez „więcej znaczy lepiej": lista jest własną
  // listą właściciela, a nie sygnałem (CLAUDE.md § GOAT WALLETS).
  return {
    kind: 'wallets',
    score: Math.abs(wa - wb) / needed,
    text: `${count(wa)} of ${count(watched)} GOAT WALLETS hold $${a.symbol}, ${count(wb)} hold $${b.symbol}.`,
  }
}

/**
 * Wyjście z pozycji — dotychczasowe zdanie, teraz jako wariant zapasowy, gdy
 * żadna z trzech różnic nie jest wyraźna. Ta sama arytmetyka co w panelu
 * „Ringside read": ile da się sprzedać przed spadkiem ceny o 10%.
 */
function exitSentence(a: HeadlineToken, b: HeadlineToken): string {
  const exitA = exitWidth(a.liquidityUsd)
  const exitB = exitWidth(b.liquidityUsd)
  const thinner = exitA < exitB ? a : b
  const wider = thinner === a ? b : a
  const wide = Math.max(exitA, exitB)
  const thin = Math.min(exitA, exitB)
  const ratio = wide / Math.max(1, thin)

  // Poniżej progu to szum, nie różnica — „1× różnicy" czytałoby się jak twierdzenie,
  // że jedna strona jest gorsza, gdy wyjście kosztuje tyle samo.
  return ratio < HEADLINE_THRESHOLDS.exitRatio
    ? `Exiting either token costs about the same before the price drops 10%: roughly ${usd(wide)} ` +
        `out of $${wider.symbol} and ${usd(thin)} out of $${thinner.symbol}.`
    : `You can move about ${usd(wide)} out of $${wider.symbol} before the price drops 10%, ` +
        `and only about ${usd(thin)} out of $${thinner.symbol} — ` +
        `roughly a ${count(ratio)}× difference in how easily you get your money back.`
}

export interface Headline {
  kind: HeadlineKind
  text: string
  /** Wyniki wszystkich dostępnych wariantów, do audytu i testów. */
  scores: Partial<Record<Exclude<HeadlineKind, 'exit'>, number>>
}

/**
 * Zdanie porównawcze pod panelem: najostrzejsza różnica z trzech — koncentracja
 * podaży (o ile dostępna), rotacja przy płynności, liczba GOAT WALLETS — a gdy
 * żadna nie różnicuje wyraźnie, wyjście z pozycji.
 *
 * Czysta arytmetyka i progi (`HEADLINE_THRESHOLDS`), bez modelu. Zdania podają
 * liczby, nie oceny: żadnego „więcej znaczy lepiej", żadnych sugestii, w co
 * inwestować, żadnej prognozy.
 */
export function comparisonHeadline(
  a: HeadlineToken,
  b: HeadlineToken,
  watchedTotal: number | null,
): Headline {
  const candidates = [
    concentrationCandidate(a, b),
    turnoverCandidate(a, b),
    walletsCandidate(a, b, watchedTotal),
  ].filter((c): c is Candidate => c !== null)

  const scores: Headline['scores'] = {}
  for (const c of candidates) scores[c.kind] = c.score

  const best = candidates
    .filter((c) => c.score >= 1)
    .sort((x, y) => y.score - x.score || PRIORITY.indexOf(x.kind) - PRIORITY.indexOf(y.kind))[0]

  return best
    ? { kind: best.kind, text: best.text, scores }
    : { kind: 'exit', text: exitSentence(a, b), scores }
}
