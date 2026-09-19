/**
 * Kontrola koncentracji podaży — czysta arytmetyka, bez sieci.
 * Uruchomienie: npm run verify:concentration
 *
 * Sprawdzane jest to, na czym stoją progi: że adresy niebędące holderami
 * naprawdę wypadają z licznika **i** z mianownika, że pasma stykają się bez
 * dziur, i — najważniejsze — że bez odsiewu nikt nie dostaje kary.
 */
import {
  BURN_ADDRESSES,
  CONCENTRATION_BANDS,
  computeConcentration,
  concentrationBand,
  concentrationUnavailable,
  concentrationVerdict,
  nonHolderAddresses,
  type Concentration,
  type HolderBalance,
} from '../src/lib/concentration.ts'
import { combatProfile, simulateFight, type FighterInput } from '../src/lib/fight.ts'
import { recordFight } from '../src/lib/leaderboard.ts'
import type { TokenFightData } from '../src/lib/codex.ts'
import { holderGate } from '../src/lib/holder-gate.ts'
import { honeypotGate, securityUnavailable } from '../src/lib/security.ts'
import { computeStats, computeVulnerability, weightClass, type ChartModifiers } from '../src/lib/stats.ts'

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

const TOKEN = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18'
const PAIR_A = '0xaaaa000000000000000000000000000000000001'
const PAIR_B = '0xaaaa000000000000000000000000000000000002'

/** N portfeli po `balance`, adresy numerowane — nic losowego. */
function holders(count: number, balance: number, offset = 0): HolderBalance[] {
  return Array.from({ length: count }, (_, i) => ({
    address: '0xbbbb' + String(i + offset + 1).padStart(36, '0'),
    balance,
  }))
}

console.log('\n== Odsiew adresów niebędących holderami ==')
const excludeMap = nonHolderAddresses({
  tokenAddress: TOKEN,
  pairAddresses: [PAIR_A, PAIR_B],
  networkId: 4663,
})
check('kontrakt tokena odsiany', excludeMap.get(TOKEN), 'token')
check('para płynności odsiana', excludeMap.get(PAIR_A), 'pair')
check('druga para też', excludeMap.get(PAIR_B), 'pair')
check('adres zerowy odsiany', excludeMap.get(BURN_ADDRESSES[0]), 'burn')
check('adres 0x…dead odsiany', excludeMap.get(BURN_ADDRESSES[1]), 'burn')
check('zwykły portfel zostaje', excludeMap.has(holders(1, 1)[0].address), false)

// Mapa trzyma adresy małymi literami, więc odsiew musi normalizować adres
// przed sprawdzeniem — robi to `computeConcentration`, nie sama mapa.
const mixedCase = computeConcentration({
  balances: [{ address: TOKEN.toUpperCase().replace('0X', '0x'), balance: 500 }, ...holders(10, 50)],
  totalSupply: 1000,
  tokenAddress: TOKEN,
  pairAddresses: [],
  networkId: 4663,
  rawTop10Percent: null,
})
check('kontrakt tokena zapisany WIELKIMI odsiany', mixedCase.excluded.length, 1)

console.log('\n== Licznik i mianownik ==')
// Podaż 1000: para 200, spalone 50, kontrakt tokena 50 → odsiane 300.
// Zostaje 700 w rękach holderów, z czego dziesięć największych trzyma 500.
const balances: HolderBalance[] = [
  { address: PAIR_A, balance: 200 },
  { address: BURN_ADDRESSES[0], balance: 50 },
  { address: TOKEN, balance: 50 },
  ...holders(10, 50),
  ...holders(10, 20, 10),
]
const c = computeConcentration({
  balances,
  totalSupply: 1000,
  tokenAddress: TOKEN,
  pairAddresses: [PAIR_A, PAIR_B],
  networkId: 4663,
  rawTop10Percent: 62.5,
})
check('status ok', c.status, 'ok')
check('odsiano trzy adresy', c.excluded.length, 3)
check('odsiana część podaży', c.excludedShare, 0.3)
check('mianownik to podaż holderów', c.holderSupply, 700)
check('koncentracja 500/700', c.top10Percent, 71.43)
check('surowa liczba zachowana obok', c.rawTop10Percent, 62.5)
check('holderów po odsiewie', c.holdersConsidered, 20)
check('sald przed odsiewem', c.balancesFetched, 23)

// Mianownik ma znaczenie: ta sama dziesiątka liczona od całej podaży
// wyszłaby na 50%, czyli o całe pasmo niżej.
check('liczone od całej podaży byłoby o pasmo niżej', concentrationBand(50).id, 'glassJaw')
check('a od podaży holderów jest wyżej', concentrationBand(c.top10Percent!).id, 'failed')

console.log('\n== Powtarzalność ==')
const shuffled = [...balances].reverse()
check(
  'kolejność sald nie zmienia wyniku',
  computeConcentration({
    balances: shuffled,
    totalSupply: 1000,
    tokenAddress: TOKEN,
    pairAddresses: [PAIR_A, PAIR_B],
    networkId: 4663,
    rawTop10Percent: 62.5,
  }).top10Percent,
  c.top10Percent,
)
// Równe salda: dogrywka po adresie, inaczej kolejność zostaje w rękach API.
const tied = computeConcentration({
  balances: holders(20, 35),
  totalSupply: 1000,
  tokenAddress: TOKEN,
  pairAddresses: [],
  networkId: 4663,
  rawTop10Percent: null,
})
check('dwadzieścia równych sald po 35 z 1000', tied.top10Percent, 35)
check('równe salda dają ten sam wynik przy odwróconej kolejności',
  computeConcentration({
    balances: [...holders(20, 35)].reverse(),
    totalSupply: 1000,
    tokenAddress: TOKEN,
    pairAddresses: [],
    networkId: 4663,
    rawTop10Percent: null,
  }).top10Percent,
  tied.top10Percent,
)

console.log('\n== Pasma stykają się bez dziur ==')
check('70% to już niezaliczone badania', concentrationBand(70).id, 'failed')
check('69,99% to szklana szczęka', concentrationBand(69.99).id, 'glassJaw')
check('50% to szklana szczęka', concentrationBand(50).id, 'glassJaw')
check('49,99% to kara do wytrzymałości', concentrationBand(49.99).id, 'stamina')
check('30% to kara do wytrzymałości', concentrationBand(30).id, 'stamina')
check('29,99% bez kary', concentrationBand(29.99).id, 'clear')
check('0% bez kary', concentrationBand(0).id, 'clear')
check('100% to niezaliczone badania', concentrationBand(100).id, 'failed')
// Każda wartość z siatki wpada dokładnie w jedno pasmo.
const bandsHit = new Set<string>()
let gaps = 0
for (let p = 0; p <= 100; p = Math.round((p + 0.25) * 100) / 100) {
  const matching = CONCENTRATION_BANDS.filter((b) => p >= b.minPercent)
  if (matching.length === 0) gaps++
  bandsHit.add(concentrationBand(p).id)
}
check('żadna wartość 0–100 nie wypada poza pasma', gaps, 0)
check('wszystkie cztery pasma osiągalne', bandsHit.size, 4)

console.log('\n== Kara do wytrzymałości rośnie w pasmie ==')
const verdictAt = (percent: number) =>
  concentrationVerdict({
    ...concentrationUnavailable(null, 'x'),
    status: 'ok',
    top10Percent: percent,
    holdersConsidered: 10,
  })
check('30% → kara zerowa', verdictAt(30).staminaPenalty, 0)
check('40% → połowa kary', verdictAt(40).staminaPenalty, 0.5)
// 0,99 a nie 1,00: (49,9-30)/20 = 0,995 i zaokrąglenie dwójkowe schodzi w dół.
check('49,9% → prawie pełna kara', verdictAt(49.9).staminaPenalty, 0.99)
check('poza pasmem kary nie ma', verdictAt(60).staminaPenalty, 0)
check('20% → pasmo clear', verdictAt(20).band, 'clear')
check('20% mimo to jest wymierzone', verdictAt(20).enforced, true)

console.log('\n== Bez odsiewu nie ma kary ==')
// Sedno: surowy `top10HoldersPercent` bywa wysoki, bo zawiera pule płynności
// i podaż poza obiegiem. Walkower za taką liczbę byłby walkowerem za to, że
// token ma parę na giełdzie.
const unfiltered = concentrationUnavailable(95, 'plan Growth wymagany')
const unfilteredVerdict = concentrationVerdict(unfiltered)
check('surowe 95% zachowane do audytu', unfiltered.rawTop10Percent, 95)
check('ale pasmo to clear', unfilteredVerdict.band, 'clear')
check('i nic nie jest wymierzone', unfilteredVerdict.enforced, false)
check('i kara jest zerowa', unfilteredVerdict.staminaPenalty, 0)
check('procent pasma pusty', unfilteredVerdict.percent, null)
// `insufficient` tak samo: liczba jest, ale policzona z za krótkiej listy.
const short = computeConcentration({
  balances: holders(4, 100),
  totalSupply: 1000,
  tokenAddress: TOKEN,
  pairAddresses: [],
  networkId: 4663,
  rawTop10Percent: null,
})
check('mniej niż dziesięć holderów → insufficient', short.status, 'insufficient')
check('insufficient też nie jest wymierzane', concentrationVerdict(short).enforced, false)

console.log('\n== Skutki w ringu ==')
const mods: ChartModifiers = {
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
}

const at = (percent: number | null): Concentration =>
  percent === null
    ? concentrationUnavailable(null, 'brak planu')
    : { ...concentrationUnavailable(null, 'x'), status: 'ok', top10Percent: percent, holdersConsidered: 10 }

function fighter(address: string, symbol: string, percent: number | null): FighterInput {
  return {
    address,
    symbol,
    stats: { wytrzymalosc: 70, sila: 60, garda: 60, szybkosc: 50 },
    modifiers: mods,
    // Zero podatności i tyle holderów, żeby bramka przepuszczała: ten skrypt
    // sprawdza koncentrację, a nie te dwie mechaniki.
    vulnerability: 0,
    survivalBonus: 0,
    holderGate: holderGate(10_000),
    honeypotGate: honeypotGate(securityUnavailable(4663, 'test')),
    concentration: concentrationVerdict(at(percent)),
  }
}

const clean = fighter('0x1111111111111111111111111111111111111111', 'CLEAN', 10)
const penalised = fighter('0x2222222222222222222222222222222222222222', 'PEN', 40)
const glass = fighter('0x3333333333333333333333333333333333333333', 'GLASS', 60)
const rejected = fighter('0x4444444444444444444444444444444444444444', 'FAIL', 80)
const alsoRejected = fighter('0x5555555555555555555555555555555555555555', 'FAIL2', 99)

console.log('   -- poniżej 30%: bez kary')
// Wytrzymałość 70 + `hpBase` 180 = 250; podatność 0, więc nic więcej nie odejmuje.
check('pula życia jak bez koncentracji', combatProfile(clean).hpStart, 250)

console.log('   -- 30–50%: kara do wytrzymałości')
check('kara obniża pulę życia', combatProfile(penalised).hpStart < combatProfile(clean).hpStart, true)
check('kara to połowa maksimum, czyli 10%', combatProfile(penalised).hpStart, 225)
check('próg poobijania spada razem z pulą', combatProfile(penalised).hurtThreshold < combatProfile(clean).hurtThreshold, true)

console.log('   -- 50–70%: szklana szczęka')
const glassFight = simulateFight(glass, clean)
const glassEvent = glassFight.events.find((e) => e.type === 'glassJaw')
check('padła szklana szczęka', glassEvent !== undefined, true)
check('nokaut w pierwszej rundzie', glassFight.endedInRound, 1)
check('sposób to KO', glassFight.method, 'KO')
check('wygrał przeciwnik, nie szklana szczęka', glassFight.winner, 'b')
// Na wielu parach: szklana szczęka nigdy nie wygrywa nokautem po pierwszej
// rundzie i zawsze to ona leży, nie przeciwnik.
let glassFights = 0
let glassKos = 0
let wrongRound = 0
for (let i = 0; i < 200; i++) {
  const opponent = fighter('0x9' + String(i).padStart(39, '0'), 'OPP', 10)
  const fight = simulateFight(glass, opponent)
  const event = fight.events.find((e) => e.type === 'glassJaw')
  glassFights++
  if (event) {
    glassKos++
    if (fight.endedInRound !== 1 || fight.winner !== 'b') wrongRound++
  }
}
check('szklana szczęka pada w każdej walce z ciężkim ciosem', wrongRound, 0)
check('i pada w większości z 200 walk', glassKos > glassFights / 2, true)

console.log('   -- powyżej 70%: walkower i odwołanie')
const walkover = simulateFight(rejected, clean)
check('sposób to walkower', walkover.method, 'walkover')
check('wygrywa ten, który przeszedł badania', walkover.winner, 'b')
check('nie ma rund', walkover.rounds.length, 0)
check('karta pusta', [walkover.scorecard.a, walkover.scorecard.b], [0, 0])
check('zero obrażeń', [walkover.damageDealt.a, walkover.damageDealt.b], [0, 0])
check('zdarzenie o niezaliczonych badaniach', walkover.events[0].type, 'medicalsFailed')
check('i zdarzenie walkoweru', walkover.events.at(-1)?.type, 'walkover')
check('pasmo widoczne w wyniku', walkover.medicals.a.band, 'failed')

const walkoverFlipped = simulateFight(clean, rejected)
check('odwrócona kolejność: wygrywa nadal ten czysty', walkoverFlipped.winner, 'a')
check('to samo ziarno', walkoverFlipped.seed, walkover.seed)

const cancelled = simulateFight(rejected, alsoRejected)
check('obaj oblali → odwołana', cancelled.method, 'cancelled')
check('nie ma zwycięzcy', cancelled.winner, null)
check('nie ma rund', cancelled.rounds.length, 0)
check('dwa razy niezaliczone badania', cancelled.events.filter((e) => e.type === 'medicalsFailed').length, 2)
check('i odwołanie na końcu', cancelled.events.at(-1)?.type, 'fightCancelled')

console.log('   -- bez odsiewu walka idzie normalnie')
const rawHigh = fighter('0x6666666666666666666666666666666666666666', 'RAW', null)
const rawFight = simulateFight(rawHigh, clean)
check('surowa liczba nie odwołuje walki', ['KO', 'TKO', 'decision', 'draw'].includes(rawFight.method), true)
check('i nie daje walkoweru', rawFight.method === 'walkover', false)
check('pula życia nietknięta', combatProfile(rawHigh).hpStart, 250)

console.log('\n== Odwołana walka nie wchodzi do rankingu ==')
function tokenData(f: FighterInput, percent: number | null): TokenFightData {
  const raw = { liquidityUsd: 2_130_000, marketCapUsd: 273_400_000, volume24hUsd: 800_000, holders: 46_755, ageDays: 56 }
  const concentration = at(percent)
  return {
    address: f.address,
    name: f.symbol,
    symbol: f.symbol,
    networkId: 4663,
    stats: computeStats(raw),
    vulnerability: computeVulnerability(raw),
    survivalBonus: 0,
    holderGate: holderGate(raw.holders),
    honeypotGate: honeypotGate(securityUnavailable(4663, 'test')),
    weightClass: weightClass(raw.marketCapUsd),
    concentration: concentrationVerdict(concentration),
    modifiers: mods,
    snapshot: {
      security: securityUnavailable(4663, 'test'),
      pairAddress: PAIR_A,
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
      totalSupply: raw.marketCapUsd,
      concentration,
      reportedMarketCapUsd: raw.marketCapUsd,
      marketCapDivergesFromReported: false,
      pairCreatedAt: 0,
      pairAgeDays: raw.ageDays,
      fetchedAt: 1_700_000_000,
    },
  }
}

const cancelledRecord = await recordFight(
  tokenData(rejected, 80),
  tokenData(alsoRejected, 99),
  cancelled,
)
check('odwołana walka nie zapisana', cancelledRecord.recorded, false)
check('z powodem', cancelledRecord.reason, 'cancelled')

const walkoverRecord = await recordFight(tokenData(rejected, 80), tokenData(clean, 10), walkover)
check('walkower zapisany jako wynik', walkoverRecord.recorded, true)
check('bez powodu odrzucenia', walkoverRecord.reason, null)
check('koncentracja w snapshocie rekordu', walkoverRecord.fight.sides.a.inputs.top10Percent, 80)
check('i informacja, że była wymierzona', walkoverRecord.fight.sides.a.inputs.concentrationEnforced, true)

console.log(failed === 0 ? '\nWszystko przeszło.' : `\n${failed} kontrol nie przeszło.`)
if (failed > 0) process.exit(1)
