/**
 * Panel „WHY": każda statystyka obok surowej liczby, z której powstała.
 *
 * Czysta arytmetyka i szablony tekstu — bez modelu językowego, bez sieci, bez
 * env. Zdanie pod tabelą jest składane z liczb, które policzyła symulacja
 * i mapowanie statystyk; nie jest komentarzem i nie przechodzi przez model
 * (CLAUDE.md § Zasada nadrzędna, § Czego nie robić).
 *
 * Nie ocenia tokena i niczego nie prognozuje. Mówi, jakie liczby stały za
 * statystykami i którą z nich wynik walki najbardziej faworyzował.
 */
import type { TokenFightData } from './codex'
import type { FightResult, Side } from './fight'
import type { SecurityChecks } from './security'
import type { FightStats } from './stats'
import type { TrackedWallets } from './tracked'

/** Wejście: podzbiór odpowiedzi `/api/fight`, tyle ile panel czyta. */
export interface WhyInput {
  tokenA: TokenFightData
  tokenB: TokenFightData
  fight: FightResult
  tracked?: TrackedWallets | null
}

/** Jedna komórka: statystyka (jeśli jest) i liczba, z której wyszła. */
export interface WhyCell {
  /** Wynik 0–100. `null` w wierszach, które nie są statystyką bojową. */
  score: number | null
  /** Surowa liczba albo krótki opis: „$2,130,412", „46,755", „3 of 40". */
  raw: string
  /** Ostrzeżenie do podświetlenia — wykryta flaga skanu. Nie ma wpływu na walkę. */
  warn?: boolean
}

export interface WhyRow {
  id: 'stamina' | 'power' | 'guard' | 'speed' | 'vulnerability' | 'watched' | 'scan'
  /** „Stamina ← liquidity" — statystyka i źródło w jednej etykiecie. */
  label: string
  a: WhyCell
  b: WhyCell
}

export interface Why {
  symbols: Record<Side, string>
  rows: WhyRow[]
  /** Jedno zdanie, liczone z liczb. */
  sentence: string
  /** Skąd dane, kiedy zdjęto snapshot, czemu wynik jest powtarzalny. */
  source: string
}

/** To samo czyszczenie co `tick()` na froncie: symbol wpisuje deployer. */
const safeSymbol = (symbol: string) => symbol.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16) || 'UNNAMED'

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const dollars = (n: number) => (Number.isFinite(n) && n > 0 ? `$${int(n)}` : '$0')

/** Wiek pary w dniach: ułamek tylko tam, gdzie pełne dni ukryłyby różnicę. */
function days(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  return n < 10 ? `${n.toFixed(1)} d` : `${int(n)} d`
}

/**
 * Kapitalizacja / płynność jako krotność. Zerowa płynność przy dodatniej
 * kapitalizacji daje sufit podatności (CLAUDE.md), więc pokazujemy to wprost,
 * zamiast dzielić przez zero.
 */
function multiple(marketCapUsd: number, liquidityUsd: number): string {
  if (!(liquidityUsd > 0)) return marketCapUsd > 0 ? 'no liquidity' : '—'
  const m = marketCapUsd / liquidityUsd
  return `${m >= 100 ? int(m) : m.toFixed(1)}×`
}

/**
 * Rotacja płynności (velocity): obrót 24h ÷ płynność. Sformatowane jako "X.Xx"
 * z suffixem turnover, np. "0.5× turnover" albo "33× turnover".
 */
function turnover(velocity: number): string {
  return velocity >= 100 ? `${int(velocity)}× turnover` : `${velocity.toFixed(1)}× turnover`
}

/** Sekundy albo milisekundy — snapshot bywa zapisany i tak, i tak. */
function utc(stamp: number): string {
  const d = new Date(stamp > 1e12 ? stamp : stamp * 1000)
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/* ------------------------------------------------------------------ */
/* Wiersz skanu                                                        */
/* ------------------------------------------------------------------ */

const CHECK_LABELS: Record<keyof SecurityChecks, string> = {
  honeypot: 'honeypot',
  mintable: 'mintable',
  blacklist: 'blacklist',
  ownerCanChangeBalances: 'owner can change balances',
  transferPausable: 'transfers pausable',
}

/**
 * Wynik skanu w jednej komórce. Bez słowa „safe": „nothing detected" znaczy,
 * że skan niczego nie znalazł, a „no data" — że nie umiał powiedzieć.
 * Honeypot jest jedyną flagą, która zatrzymuje zawodnika; reszta to ostrzeżenia.
 */
export function scanSummary(checks: SecurityChecks | null): WhyCell {
  if (checks === null) return { score: null, raw: 'no data — the scan could not run' }

  const keys = Object.keys(CHECK_LABELS) as (keyof SecurityChecks)[]
  const warnings = keys.filter((k) => k !== 'honeypot' && checks[k] === 'detected')
  const unknown = keys.filter((k) => checks[k] === 'unknown')
  const flagged = checks.honeypot === 'detected' || warnings.length > 0

  const parts: string[] = []
  if (checks.honeypot === 'detected') parts.push('HONEYPOT detected')
  if (warnings.length > 0) parts.push(`warning: ${warnings.map((k) => CHECK_LABELS[k]).join(', ')}`)
  if (!flagged) parts.push('nothing detected')
  if (unknown.length > 0) parts.push(`no data: ${unknown.map((k) => CHECK_LABELS[k]).join(', ')}`)

  return { score: null, raw: parts.join('; '), warn: flagged }
}

/* ------------------------------------------------------------------ */
/* Zdanie                                                              */
/* ------------------------------------------------------------------ */

/** Cztery statystyki i podatność jako „przewagi": dodatnia znaczy na korzyść zwycięzcy. */
interface Edge {
  name: string
  winner: number
  loser: number
  /** Różnica na korzyść zwycięzcy. Przy podatności odwrócona: mniej znaczy lepiej. */
  gap: number
  rawWinner: string
  rawLoser: string
  unit: string
}

function edges(win: TokenFightData, lose: TokenFightData): Edge[] {
  const stat = (
    key: keyof FightStats,
    name: string,
    raw: (t: TokenFightData) => string,
    unit: string,
  ): Edge => ({
    name,
    winner: win.stats[key],
    loser: lose.stats[key],
    gap: win.stats[key] - lose.stats[key],
    rawWinner: raw(win),
    rawLoser: raw(lose),
    unit,
  })

  return [
    stat('wytrzymalosc', 'stamina', (t) => dollars(t.snapshot.liquidityUsd), 'of liquidity'),
    stat('sila', 'power', (t) => dollars(t.snapshot.volume24hUsd), 'of 24h volume'),
    stat('garda', 'guard', (t) => int(t.snapshot.holders), 'holders'),
    stat('szybkosc', 'speed', (t) => days(t.snapshot.pairAgeDays), ''),
    {
      name: 'vulnerability',
      winner: win.vulnerability,
      loser: lose.vulnerability,
      // Podatność jest odwrócona: niższa jest lepsza dla zawodnika.
      gap: lose.vulnerability - win.vulnerability,
      rawWinner: multiple(win.snapshot.marketCapUsd, win.snapshot.liquidityUsd),
      rawLoser: multiple(lose.snapshot.marketCapUsd, lose.snapshot.liquidityUsd),
      unit: 'market cap to liquidity',
    },
  ]
}

const describe = (e: Edge) =>
  `${e.name} ${e.winner} vs ${e.loser}${e.name === 'vulnerability' ? ', lower is better' : ''} ` +
  `(${e.rawWinner} vs ${e.rawLoser}${e.unit ? ` ${e.unit}` : ''})`

/** Największa i najmniejsza przewaga; przy remisie wygrywa kolejność na liście. */
function extremes(list: Edge[]): { best: Edge; worst: Edge } {
  let best = list[0]
  let worst = list[0]
  for (const e of list) {
    if (e.gap > best.gap) best = e
    if (e.gap < worst.gap) worst = e
  }
  return { best, worst }
}

/** Dlaczego zawodnik nie wszedł do ringu — z tego, co zapisało zdarzenie badań. */
function failureText(fight: FightResult, side: Side): string {
  const event = fight.events.find((e) => e.type === 'medicalsFailed' && e.fighter === side)
  if (!event || event.type !== 'medicalsFailed') return 'failed the pre-fight check'
  if (event.reason === 'holders') {
    return `has ${int(event.holders)} holders against a minimum of ${int(event.minHolders)}`
  }
  if (event.reason === 'honeypot') return 'was flagged as a honeypot by the GoPlus scan'
  return `holds ${event.concentrationPercent.toFixed(1)}% of holder-held supply in ten wallets, at or above the 70% limit`
}

export function whySentence(input: WhyInput): string {
  const { tokenA, tokenB, fight } = input
  const sym = { a: `$${safeSymbol(tokenA.symbol)}`, b: `$${safeSymbol(tokenB.symbol)}` }

  if (fight.method === 'cancelled') {
    return (
      `No contest: ${sym.a} ${failureText(fight, 'a')} and ${sym.b} ${failureText(fight, 'b')}, ` +
      'so neither was allowed into the ring and no rounds were fought.'
    )
  }

  if (fight.method === 'walkover' && fight.winner) {
    const loser: Side = fight.winner === 'a' ? 'b' : 'a'
    return (
      `${sym[loser]} ${failureText(fight, loser)}, so it failed the pre-fight check and ${sym[fight.winner]} ` +
      'took the walkover — no rounds were fought, so the stat rows above did not decide anything.'
    )
  }

  const tokens = { a: tokenA, b: tokenB }

  if (fight.winner === null) {
    // Tu „winner" i „loser" w `Edge` znaczą po prostu A i B — nikt nie wygrał.
    const { best } = extremes(edges(tokenA, tokenB).map((e) => ({ ...e, gap: Math.abs(e.gap) })))
    return (
      `Draw: the cards came back level, and the widest gap on the table (${best.name}, ` +
      `${sym.a} ${best.winner} vs ${sym.b} ${best.loser}) was not enough to separate them.`
    )
  }

  const winner = fight.winner
  const loser: Side = winner === 'a' ? 'b' : 'a'
  const list = edges(tokens[winner], tokens[loser])
  const { best, worst } = extremes(list)

  const how =
    fight.method === 'decision'
      ? `by decision, ${fight.scorecard[winner]}–${fight.scorecard[loser]} on the cards`
      : `by ${fight.method} in round ${fight.endedInRound}`

  const lead = best.gap > 0 ? `its widest edge was ${describe(best)}` : 'it had no edge on any stat'
  const trail = worst.gap < 0 ? `its widest deficit was ${describe(worst)}` : 'it trailed on none'

  return (
    `${sym[winner]} won ${how}; ${lead} and ${trail}, ` +
    'and the punches themselves come from the seed, so these gaps tilt a fight without settling it.'
  )
}

/* ------------------------------------------------------------------ */
/* Tabela i źródło                                                     */
/* ------------------------------------------------------------------ */

export function explainFight(input: WhyInput): Why {
  const { tokenA, tokenB, fight } = input
  const tracked = input.tracked ?? null

  const both = (make: (t: TokenFightData) => WhyCell): { a: WhyCell; b: WhyCell } => ({
    a: make(tokenA),
    b: make(tokenB),
  })

  const watched = (side: Side): WhyCell => {
    if (!tracked || !tracked.configured) return { score: null, raw: 'not configured' }
    const held = side === 'a' ? tracked.a : tracked.b
    // Kreska, nie zero: nieudane sprawdzenie nie jest brakiem trafień.
    return { score: null, raw: held === null ? '—' : `${int(held)} of ${int(tracked.watched)}` }
  }

  const rows: WhyRow[] = [
    {
      id: 'stamina',
      label: 'Stamina ← liquidity',
      ...both((t) => ({ score: t.stats.wytrzymalosc, raw: dollars(t.snapshot.liquidityUsd) })),
    },
    {
      id: 'power',
      label: 'Power ← 24h volume',
      ...both((t) => ({ score: t.stats.sila, raw: dollars(t.snapshot.volume24hUsd) })),
    },
    {
      id: 'guard',
      label: 'Guard ← holders',
      ...both((t) => ({ score: t.stats.garda, raw: int(t.snapshot.holders) })),
    },
    {
      id: 'speed',
      label: 'Speed ← turnover',
      ...both((t) => ({ score: t.stats.szybkosc, raw: turnover(t.velocity) })),
    },
    {
      id: 'vulnerability',
      label: 'Vulnerability ← market cap ÷ liquidity',
      ...both((t) => ({
        score: t.vulnerability,
        raw: multiple(t.snapshot.marketCapUsd, t.snapshot.liquidityUsd),
      })),
    },
    { id: 'watched', label: 'GOAT WALLETS holding it', a: watched('a'), b: watched('b') },
    {
      id: 'scan',
      label: 'Contract scan (GoPlus)',
      ...both((t) => scanSummary(t.snapshot.security?.checks ?? null)),
    },
  ]

  const stamps = [tokenA.snapshot.fetchedAt, tokenB.snapshot.fetchedAt]
  const first = Math.min(...stamps)
  const last = Math.max(...stamps)

  const source =
    'Source: Codex (graph.codex.io) for liquidity, 24h volume, holders, pair age and market cap; ' +
    'GoPlus for the contract scan' +
    (tracked?.configured ? '; a private server-side list for GOAT WALLETS' : '') +
    `. Snapshot taken ${first === last ? utc(first) : `${utc(first)} to ${utc(last)}`}. ` +
    `Deterministic: seed ${fight.seed} is hashed from both contract addresses, so the same pair on the ` +
    'same snapshot always replays the same fight. Live data moves, so a later snapshot can change the numbers.'

  return {
    symbols: { a: safeSymbol(tokenA.symbol), b: safeSymbol(tokenB.symbol) },
    rows,
    sentence: whySentence(input),
    source,
  }
}
