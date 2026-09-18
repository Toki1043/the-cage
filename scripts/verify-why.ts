/**
 * Kontrola panelu WHY — czysta arytmetyka, bez sieci i bez modelu.
 * Uruchomienie: npm run verify:why
 *
 * Panel ma jedną obietnicę: każda liczba w nim jest tą, z której powstała
 * statystyka, i nic w nim nie pochodzi z modelu. Test stoi więc na tym samym
 * mapowaniu co API (`computeStats`) i na liczbach kontrolnych z CLAUDE.md:
 * AI → wytrzymałość 67, siła 60, garda 73, szybkość 39, podatność 70.
 */
import { simulateFight } from '../src/lib/fight.ts'
import type { TokenFightData } from '../src/lib/codex.ts'
import { concentrationUnavailable, concentrationVerdict } from '../src/lib/concentration.ts'
import { holderGate } from '../src/lib/holder-gate.ts'
import { honeypotGate, type ContractSecurity, type SecurityChecks } from '../src/lib/security.ts'
import { computeStats, computeVulnerability, weightClass } from '../src/lib/stats.ts'
import type { TrackedWallets } from '../src/lib/tracked.ts'
import { explainFight, scanSummary, whySentence, type WhyInput } from '../src/lib/why.ts'

let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? ` = ${a.length > 70 ? `${a.slice(0, 67)}...` : a}` : `\n       oczekiwano ${e}\n       otrzymano  ${a}`}`,
  )
}

interface Raw {
  liquidityUsd: number
  marketCapUsd: number
  volume24hUsd: number
  holders: number
  ageDays: number
}

const clean = (over: Partial<SecurityChecks> = {}): ContractSecurity => ({
  source: 'goplus',
  chainId: 4663,
  checks: {
    honeypot: 'not_detected',
    mintable: 'not_detected',
    blacklist: 'not_detected',
    ownerCanChangeBalances: 'not_detected',
    transferPausable: 'not_detected',
    ...over,
  },
  note: null,
})

/** Zawodnik liczony tą samą arytmetyką co API — statystyki nie są wpisane ręcznie. */
function token(
  address: string,
  symbol: string,
  raw: Raw,
  security: ContractSecurity = clean(),
  fetchedAt = 1_700_000_000,
): TokenFightData {
  const concentration = concentrationUnavailable(null, 'test')
  return {
    address,
    name: `${symbol} token`,
    symbol,
    networkId: 4663,
    stats: computeStats(raw),
    vulnerability: computeVulnerability(raw),
    holderGate: holderGate(raw.holders),
    honeypotGate: honeypotGate(security),
    weightClass: weightClass(raw.marketCapUsd),
    concentration: concentrationVerdict(concentration),
    snapshot: {
      totalSupply: raw.marketCapUsd,
      concentration,
      security,
      pairAddress: `0xpair${symbol.toLowerCase()}`,
      pairBackingSymbol: 'WETH',
      pairExchange: 'test',
      pairQuoteToken: 'token0',
      pairsConsidered: 1,
      runnerUpLiquidityUsd: null,
      tokenFirstPairAt: 0,
      liquidityUsd: raw.liquidityUsd,
      volume24hUsd: raw.volume24hUsd,
      marketCapUsd: raw.marketCapUsd,
      holders: raw.holders,
      priceUsd: 1,
      circulatingSupply: raw.marketCapUsd,
      reportedMarketCapUsd: raw.marketCapUsd,
      marketCapDivergesFromReported: false,
      pairCreatedAt: 0,
      pairAgeDays: raw.ageDays,
      fetchedAt,
    },
    modifiers: {
      priceChange1h: 0,
      priceChange24h: 0,
      priceChange7d: 0,
      priceChange7dWindowDays: 7,
      peakCloseUsd: 1,
      peakAt: 0,
      drawdownFromPeakClose: 0,
      volatility: 1,
      volatilityBasisDays: 30,
      barCount: 30,
      windowDays: 30,
    },
  }
}

const input = (a: TokenFightData, b: TokenFightData, tracked: TrackedWallets | null = null): WhyInput => ({
  tokenA: a,
  tokenB: b,
  fight: simulateFight(a, b),
  tracked,
})

// Liczba wzorcowa z CLAUDE.md: token AI, obrót 24h $1 mln.
const AI_RAW: Raw = { liquidityUsd: 2_130_000, marketCapUsd: 273_400_000, volume24hUsd: 1_000_000, holders: 46_755, ageDays: 56 }
const SOLID_RAW: Raw = { liquidityUsd: 900_000, marketCapUsd: 9_000_000, volume24hUsd: 120_000, holders: 3_100, ageDays: 200 }

const AI = token('0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', 'AI', AI_RAW)
const SOLID = token('0x91a2dae9699f0b82540b5886b0d8759c22820ba3', 'SOLID', SOLID_RAW)

console.log('\n== Tabela: statystyka obok liczby, z której powstała ==')
const why = explainFight(input(AI, SOLID))
const row = (id: string) => why.rows.find((r) => r.id === id)!

check('siedem wierszy w tej kolejności', why.rows.map((r) => r.id), ['stamina', 'power', 'guard', 'speed', 'vulnerability', 'watched', 'scan'])
check('wytrzymałość ← płynność: AI 67 z $2,130,000', [row('stamina').a.score, row('stamina').a.raw], [67, '$2,130,000'])
check('siła ← obrót 24h: AI 60 z $1,000,000', [row('power').a.score, row('power').a.raw], [60, '$1,000,000'])
check('garda ← holderzy: AI 73 z 46,755', [row('guard').a.score, row('guard').a.raw], [73, '46,755'])
check('szybkość ← wiek pary: AI 39 z 56 d', [row('speed').a.score, row('speed').a.raw], [39, '56 d'])
check('podatność ← kapitalizacja ÷ płynność: AI 70 z 128×', [row('vulnerability').a.score, row('vulnerability').a.raw], [70, '128×'])
check('etykiety niosą źródło', why.rows.slice(0, 5).map((r) => r.label), [
  'Stamina ← liquidity',
  'Power ← 24h volume',
  'Guard ← holders',
  'Speed ← pair age',
  'Vulnerability ← market cap ÷ liquidity',
])

// Ta sama kolumna dla drugiego zawodnika: wynik i liczba idą parami.
check('drugi zawodnik: garda 3,100 holderów', [row('guard').b.score, row('guard').b.raw], [SOLID.stats.garda, '3,100'])
check('drugi zawodnik: podatność 10× z 9M/0,9M', row('vulnerability').b.raw, '10.0×')

// Każdy wynik w tabeli jest tym samym, który poszedł do symulacji.
check(
  'wyniki w tabeli = wyniki zawodników',
  why.rows.slice(0, 4).flatMap((r) => [r.a.score, r.b.score]),
  [AI.stats.wytrzymalosc, SOLID.stats.wytrzymalosc, AI.stats.sila, SOLID.stats.sila, AI.stats.garda, SOLID.stats.garda, AI.stats.szybkosc, SOLID.stats.szybkosc],
)

console.log('\n== Formaty surowych liczb ==')
const young = token('0x3333333333333333333333333333333333333333', 'YNG', { ...SOLID_RAW, ageDays: 2.46 })
check('wiek poniżej 10 dni z ułamkiem', explainFight(input(young, SOLID)).rows[3].a.raw, '2.5 d')
const dry = token('0x4444444444444444444444444444444444444444', 'DRY', { ...SOLID_RAW, liquidityUsd: 0 })
check('zerowa płynność: krotność mówi wprost, bez dzielenia przez zero', explainFight(input(dry, SOLID)).rows[4].a.raw, 'no liquidity')
check('symbol z HTML-a jest czyszczony', explainFight(input(token('0x5555555555555555555555555555555555555555', '<img onerror=x>', SOLID_RAW), SOLID)).symbols.a, 'imgonerrorx')

console.log('\n== Obserwowane portfele ==')
const trackedOk: TrackedWallets = { configured: true, watched: 40, a: 3, b: null, note: null }
const wOk = explainFight(input(AI, SOLID, trackedOk)).rows.find((r) => r.id === 'watched')!
check('etykieta wiersza to GOAT WALLETS', wOk.label, 'GOAT WALLETS holding it')
check('3 z 40 dla A', wOk.a.raw, '3 of 40')
check('nieudane sprawdzenie to kreska, nie zero', wOk.b.raw, '—')
check('bez listy: „not configured", nie zero', explainFight(input(AI, SOLID, null)).rows.find((r) => r.id === 'watched')!.a.raw, 'not configured')
check('zero trafień to prawdziwe 0 z 40', explainFight(input(AI, SOLID, { ...trackedOk, a: 0 })).rows.find((r) => r.id === 'watched')!.a.raw, '0 of 40')

console.log('\n== Wynik skanu ==')
check('pusty skan → nothing detected, bez „safe"', scanSummary(clean().checks), { score: null, raw: 'nothing detected', warn: false })
check('null → no data', scanSummary(null).raw, 'no data — the scan could not run')
const paused = scanSummary(clean({ transferPausable: 'detected' }).checks)
check('transfer_pausable to ostrzeżenie', [paused.raw, paused.warn], ['warning: transfers pausable', true])
check('honeypot wykryty jest wielkimi literami', scanSummary(clean({ honeypot: 'detected' }).checks).raw, 'HONEYPOT detected')
check('brakujące pola wymienione z nazwy', scanSummary(clean({ mintable: 'unknown', honeypot: 'unknown' }).checks).raw, 'nothing detected; no data: honeypot, mintable')
check('tabela niesie skan obu stron', [row('scan').a.raw, row('scan').b.raw], ['nothing detected', 'nothing detected'])

console.log('\n== Zdanie: walka rozegrana ==')
const s1 = whySentence(input(AI, SOLID))
const f1 = simulateFight(AI, SOLID)
const winner = f1.winner!
const wTok = winner === 'a' ? AI : SOLID
const lTok = winner === 'a' ? SOLID : AI
console.log(`     ${s1}`)
check('zdanie zaczyna od zwycięzcy z symulacji', s1.startsWith(`$${wTok.symbol} won`), true)
check('podaje metodę i kartę albo rundę', /by decision, \d+–\d+ on the cards|by (KO|TKO) in round \d/.test(s1), true)

// Największa przewaga policzona tu, niezależnie od modułu.
const gaps: [string, number][] = [
  ['stamina', wTok.stats.wytrzymalosc - lTok.stats.wytrzymalosc],
  ['power', wTok.stats.sila - lTok.stats.sila],
  ['guard', wTok.stats.garda - lTok.stats.garda],
  ['speed', wTok.stats.szybkosc - lTok.stats.szybkosc],
  ['vulnerability', lTok.vulnerability - wTok.vulnerability],
]
const bestGap = gaps.reduce((m, g) => (g[1] > m[1] ? g : m))
const worstGap = gaps.reduce((m, g) => (g[1] < m[1] ? g : m))
check('największa przewaga to ta, którą wyliczył test', bestGap[1] > 0 ? s1.includes(`widest edge was ${bestGap[0]} `) : s1.includes('no edge on any stat'), true)
check('największy deficyt to ten, który wyliczył test', worstGap[1] < 0 ? s1.includes(`widest deficit was ${worstGap[0]} `) : s1.includes('trailed on none'), true)
check('zdanie przyznaje, że ciosy idą z ziarna', s1.includes('the punches themselves come from the seed'), true)
check('to jedno zdanie', (s1.match(/\. /g) ?? []).length, 0)
check('powtórzenie daje ten sam tekst', whySentence(input(AI, SOLID)), s1)
check('kolejność adresów nie zmienia zwycięzcy w zdaniu', whySentence(input(SOLID, AI)).startsWith(`$${wTok.symbol} won`), true)

console.log('\n== Zdanie: walkower i odwołanie ==')
const fewHolders = token('0x6666666666666666666666666666666666666666', 'FEW', { ...SOLID_RAW, holders: 51 })
const s2 = whySentence(input(fewHolders, AI))
console.log(`     ${s2}`)
check('walkower za holderów podaje liczbę i próg', s2.includes('has 51 holders against a minimum of 200'), true)
check('walkower wskazuje, kto go wziął', s2.includes('$AI took the walkover'), true)
check('walkower przyznaje, że statystyki nic nie rozstrzygały', s2.includes('did not decide anything'), true)

const honey = token('0x7777777777777777777777777777777777777777', 'HONEY', SOLID_RAW, clean({ honeypot: 'detected' }))
check('walkower za honeypota przypisuje wynik skanowi GoPlus', whySentence(input(honey, AI)).includes('flagged as a honeypot by the GoPlus scan'), true)

const s3 = whySentence(input(fewHolders, token('0x8888888888888888888888888888888888888888', 'FEW2', { ...SOLID_RAW, holders: 3 })))
console.log(`     ${s3}`)
check('odwołana walka wymienia oba powody', s3.startsWith('No contest: $FEW has 51 holders') && s3.includes('$FEW2 has 3 holders'), true)

console.log('\n== Źródło i determinizm ==')
const src = explainFight(input(AI, SOLID)).source
console.log(`     ${src}`)
check('wymienia Codex i GoPlus', src.includes('Codex') && src.includes('GoPlus'), true)
check('znacznik czasu snapshotu w UTC', src.includes('2023-11-14 22:13:20 UTC'), true)
check('pełne ziarno z wyniku walki', src.includes(f1.seed), true)
check('mówi, że wynik jest deterministyczny z adresów obu kontraktów', src.includes('Deterministic') && src.includes('both contract addresses'), true)
check('nie obiecuje, że dane stoją w miejscu', src.includes('a later snapshot can change the numbers'), true)
check('bez listy obserwowanych nie wymienia jej w źródle', src.includes('GOAT WALLETS'), false)
check('z listą wymienia ją w źródle', explainFight(input(AI, SOLID, trackedOk)).source.includes('private server-side list for GOAT WALLETS'), true)

const later = token('0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', 'AI', AI_RAW, clean(), 1_700_000_042)
check('dwa różne znaczniki → przedział', explainFight(input(later, SOLID)).source.includes('2023-11-14 22:13:20 UTC to 2023-11-14 22:14:02 UTC'), true)

console.log('\n== Czego panel nie mówi ==')
const everything = [
  JSON.stringify(explainFight(input(AI, SOLID, trackedOk))),
  JSON.stringify(explainFight(input(fewHolders, AI))),
  JSON.stringify(explainFight(input(AI, token('0x9999999999999999999999999999999999999999', 'TP', SOLID_RAW, clean({ transferPausable: 'detected' }))))),
].join(' ')
for (const word of [/\bsafe\b/i, /smart money/i, /\bbuy\b/i, /\bsell\b/i, /bullish|bearish/i, /potential|upside|chance of/i]) {
  check(`brak wyrażenia ${word}`, word.test(everything), false)
}

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
