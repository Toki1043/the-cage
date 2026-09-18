/**
 * Kontrola rankingu — na magazynie w pamięci procesu, bez sieci i bez bazy.
 * Uruchomienie: npm run verify:leaderboard
 *
 * Sprawdzane jest to, na czym ranking stoi: że ta sama walka nie dopisuje się
 * dwa razy, że token zmieniający kategorię schodzi ze starej listy i że
 * kolejność jest powtarzalna.
 */
import { simulateFight } from '../src/lib/fight.ts'
import { readBoard, readLeaderboard, readRecord, recordFight } from '../src/lib/leaderboard.ts'
import type { TokenFightData } from '../src/lib/codex.ts'
import { concentrationUnavailable, concentrationVerdict } from '../src/lib/concentration.ts'
import { holderGate } from '../src/lib/holder-gate.ts'
import { honeypotGate, securityUnavailable } from '../src/lib/security.ts'
import { computeStats, computeVulnerability, weightClass } from '../src/lib/stats.ts'

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

/**
 * Zawodnik z czterech liczb wejściowych — statystyki i kategoria wagowa lecą
 * przez tę samą arytmetykę co w API, żeby test nie sprawdzał wymyślonych
 * statystyk.
 */
function token(
  address: string,
  symbol: string,
  raw: { liquidityUsd: number; marketCapUsd: number; volume24hUsd: number; holders: number; ageDays: number },
): TokenFightData {
  // Koncentracji nie ma — tak jak na darmowym planie Codexu. Pasmo `clear`,
  // zero wpływu na walkę; pasma sprawdza `verify:concentration`.
  const concentration = concentrationUnavailable(null, 'test')
  return {
    address,
    name: symbol + ' token',
    symbol,
    networkId: 4663,
    stats: computeStats(raw),
    vulnerability: computeVulnerability(raw),
    holderGate: holderGate(raw.holders),
    honeypotGate: honeypotGate(securityUnavailable(4663, 'test')),
    weightClass: weightClass(raw.marketCapUsd),
    concentration: concentrationVerdict(concentration),
    snapshot: {
      totalSupply: raw.marketCapUsd,
      concentration,
      security: securityUnavailable(4663, 'test'),
      pairAddress: '0xpair' + symbol.toLowerCase(),
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
      fetchedAt: 1_700_000_000,
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

const AI = token('0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', 'AI', {
  liquidityUsd: 2_130_000,
  marketCapUsd: 273_400_000,
  volume24hUsd: 800_000,
  holders: 46_755,
  ageDays: 56,
})

const WETH = token('0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH', {
  liquidityUsd: 9_400_000,
  marketCapUsd: 61_000_000,
  volume24hUsd: 2_000_000,
  holders: 310_000,
  ageDays: 120,
})

const SLOP = token('0x00000000000000000000000000000000000slop1', 'SLOP', {
  liquidityUsd: 41_000,
  marketCapUsd: 1_800_000,
  volume24hUsd: 9_000,
  // Powyżej progu bramki (200): ten fixture ma walczyć naprawdę, a nie oddawać
  // walkower — bramkę sprawdza `verify:holders`.
  holders: 400,
  ageDays: 3,
})

console.log('\n== Kategorie z kapitalizacji ==')
check('AI $273,4M → półciężka', AI.weightClass.id, 'polciezka')
check('WETH $61M → średnia', WETH.weightClass.id, 'srednia')
check('SLOP $1,8M → musza', SLOP.weightClass.id, 'musza')

console.log('\n== Zapis walki ==')
const fight = simulateFight(AI, WETH)
const first = await recordFight(AI, WETH, fight)
check('pierwszy zapis przechodzi', first.recorded, true)
check('bez bazy magazyn jest nietrwały', first.persistent, false)
check('zapisana walka ma wynik z symulacji', first.fight.winner, fight.winner)
check('zapisana walka trzyma snapshot wejść', first.fight.sides.a.inputs.liquidityUsd, 2_130_000)
check('snapshot trzyma obrót 24h, z którego liczy się siła', first.fight.sides.a.inputs.volume24hUsd, 800_000)
check('snapshot trzyma skan GoPlus, od którego zależy walkower za honeypota', first.fight.sides.a.inputs.security?.source, 'goplus')
check('zapisana walka trzyma statystyki', first.fight.sides.a.stats, AI.stats)

console.log('\n== Idempotencja ==')
const again = await recordFight(AI, WETH, simulateFight(AI, WETH))
check('ta sama para nie zapisuje się drugi raz', again.recorded, false)
const aiAfterTwo = await readRecord(AI.networkId, AI.address)
check('bilans po dwóch wywołaniach to jedna walka', aiAfterTwo?.fights, 1)
check('odświeżanie nie dopisuje zwycięstw', (aiAfterTwo?.wins ?? 0) + (aiAfterTwo?.losses ?? 0) + (aiAfterTwo?.draws ?? 0), 1)

console.log('\n== Osobna lista na kategorię ==')
const polciezka = await readBoard('polciezka')
const srednia = await readBoard('srednia')
check('AI stoi w półciężkiej', polciezka.entries.map((e) => e.record.symbol), ['AI'])
check('WETH stoi w średniej', srednia.entries.map((e) => e.record.symbol), ['WETH'])
check('AI nie stoi w średniej', srednia.entries.some((e) => e.record.symbol === 'AI'), false)

const board = await readLeaderboard()
check('zawsze pięć list', board.boards.length, 5)
check('listy w kolejności od najlżejszej', board.boards.map((b) => b.weightClass.id), ['musza', 'lekka', 'srednia', 'polciezka', 'ciezka'])
check('ranking wie, że stoi na pamięci', board.persistent, false)

console.log('\n== Zmiana kategorii wagowej ==')
// Ten sam kontrakt, kapitalizacja spadła z $61M do $8M: token schodzi
// z wagi średniej do lekkiej i musi zniknąć ze starej listy, nie stać na dwóch.
const WETH_LIGHTER = token(WETH.address, 'WETH', {
  liquidityUsd: 9_400_000,
  marketCapUsd: 8_000_000,
  volume24hUsd: 2_000_000,
  holders: 310_000,
  ageDays: 121,
})
check('spadek kapitalizacji zmienia kategorię', WETH_LIGHTER.weightClass.id, 'lekka')
await recordFight(SLOP, WETH_LIGHTER, simulateFight(SLOP, WETH_LIGHTER))
check('token zszedł ze starej listy', (await readBoard('srednia')).entries.length, 0)
check('token stoi na nowej liście', (await readBoard('lekka')).entries.map((e) => e.record.symbol), ['WETH'])
check('bilans przeniósł się z historią', (await readRecord(WETH.networkId, WETH.address))?.fights, 2)

console.log('\n== Kolejność ==')
const musza = await readBoard('musza')
check('SLOP ma jedną walkę w musze', musza.entries[0]?.record.fights, 1)

// Kto wygrał SLOP vs WETH, wie tylko symulacja — punktacja sprawdzana
// względem jej wyniku. SLOP ma dokładnie jedną walkę, więc jego punkty to
// całe zastosowanie reguły: trzy za wygraną, jeden za remis, zero za przegraną.
const slopWinner = simulateFight(SLOP, WETH_LIGHTER).winner
const slopRecord = await readRecord(SLOP.networkId, SLOP.address)
check('wynik walki trafił do bilansu', [slopRecord?.wins, slopRecord?.draws, slopRecord?.losses], slopWinner === 'a' ? [1, 0, 0] : slopWinner === null ? [0, 1, 0] : [0, 0, 1])
check('punkty z reguły 3/1/0', musza.entries[0]?.points, slopWinner === 'a' ? 3 : slopWinner === null ? 1 : 0)
check('przegrana nie zdejmuje z listy', musza.total, 1)

const twice = await Promise.all([readBoard('lekka'), readBoard('lekka')])
check('ta sama lista przy dwóch odczytach', JSON.stringify(twice[0]), JSON.stringify(twice[1]))

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
