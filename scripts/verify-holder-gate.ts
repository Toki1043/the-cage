/**
 * Kontrola bramki na liczbie holderów i podatności — czysta arytmetyka, bez sieci.
 * Uruchomienie: npm run verify:holders
 *
 * Bramka działa na darmowym planie Codexu, więc każdy test poniżej stoi na
 * koncentracji „niedostępnej" (`unavailable`), tak jak dziś odpowiada API bez
 * planu Growth. Gdyby bramka wymagała sald portfeli, żaden z tych testów by
 * jej nie zobaczył.
 */
import { simulateFight, type FighterInput, type FightEvent } from '../src/lib/fight.ts'
import { concentrationUnavailable, concentrationVerdict } from '../src/lib/concentration.ts'
import { MIN_HOLDERS, holderGate } from '../src/lib/holder-gate.ts'
import { computeStats, computeVulnerability, type ChartModifiers } from '../src/lib/stats.ts'

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

const modifiers: ChartModifiers = {
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

interface Raw {
  liquidityUsd: number
  marketCapUsd: number
  volume24hUsd: number
  holders: number
  ageDays: number
}

/** Zawodnik policzony tak jak w API: z surowych liczb, nie z wpisanych statystyk. */
function token(address: string, symbol: string, raw: Raw): FighterInput {
  return {
    address,
    symbol,
    stats: computeStats(raw),
    modifiers,
    vulnerability: computeVulnerability(raw),
    holderGate: holderGate(raw.holders),
    // Brak sald: pasmo `clear`, `enforced: false` — dzisiejsza odpowiedź na darmowym planie.
    concentration: concentrationVerdict(concentrationUnavailable(null, 'test')),
  }
}

const HEALTHY: Raw = {
  liquidityUsd: 2_000_000,
  marketCapUsd: 20_000_000,
  volume24hUsd: 500_000,
  holders: 8_572,
  ageDays: 30,
}

console.log('\n== Próg ==')
check('próg to 200', MIN_HOLDERS, 200)
check('199 holderów nie przechodzi', holderGate(199).passed, false)
check('200 holderów przechodzi (granica po stronie zaliczonej)', holderGate(200).passed, true)
check('51 holderów nie przechodzi', holderGate(51).passed, false)
check('0 holderów nie przechodzi', holderGate(0).passed, false)
check('brak liczby (NaN) nie przechodzi po cichu', holderGate(Number.NaN).passed, false)
check('bramka niesie liczbę i próg', holderGate(51), { holders: 51, minHolders: 200, passed: false })

console.log('\n== Walkower: 51 holderów kontra 8572 ==')
// Para z zadania: 0x9da1…5a3e (51 holderów) kontra 0x91a2…0ba3 (8572).
const JUNK_ADDR = '0x9da155f128a7f9319a66d2bc35a5255ca46bfa3e'
const REAL_ADDR = '0x91a2dae9699f0b82540b5886b0d8759c22820ba3'
// Junk ma najlepsze możliwe statystyki: bramka nie może zależeć od siły.
const junk = token(JUNK_ADDR, 'JUNK', {
  liquidityUsd: 90_000_000,
  marketCapUsd: 90_000_000,
  volume24hUsd: 90_000_000,
  holders: 51,
  ageDays: 0,
})
const real = token(REAL_ADDR, 'REAL', HEALTHY)

const w = simulateFight(junk, real)
check('sposób to walkower', w.method, 'walkover')
check('wygrywa ten z 8572 holderami (b)', w.winner, 'b')
check('nie ma rund', w.rounds.length, 0)
check('karta pusta', [w.scorecard.a, w.scorecard.b], [0, 0])
check('zero obrażeń', [w.damageDealt.a, w.damageDealt.b], [0, 0])
check('pierwsze zdarzenie: oblane badania z powodem holders', w.events[0], {
  type: 'medicalsFailed',
  fighter: 'a',
  reason: 'holders',
  holders: 51,
  minHolders: 200,
})
check('ostatnie zdarzenie: walkower', w.events.at(-1), { type: 'walkover', winner: 'b', loser: 'a' })
check('bramka widoczna w wyniku', [w.holderGates.a.passed, w.holderGates.b.passed], [false, true])
check('koncentracja nie miała z tym nic wspólnego', w.medicals.a.enforced, false)

const flipped = simulateFight(real, junk)
check('odwrócona kolejność: wygrywa nadal REAL', flipped.winner, 'a')
check('odwrócona kolejność: to samo ziarno', flipped.seed, w.seed)
check('odwrócona kolejność: walkower', flipped.method, 'walkover')

console.log('\n== Oboje oblewają, jeden oblewa, granica ==')
const junk2 = token('0x1111111111111111111111111111111111111111', 'JUNK2', { ...HEALTHY, holders: 3 })
const cancelled = simulateFight(junk, junk2)
check('dwa oblane badania → walka odwołana', cancelled.method, 'cancelled')
check('bez zwycięzcy', cancelled.winner, null)
const cancelEvent = cancelled.events.at(-1) as Extract<FightEvent, { type: 'fightCancelled' }>
check('zdarzenie odwołania', cancelEvent.type, 'fightCancelled')
// Pola osobno: kolejność kluczy w `Record<Side, …>` idzie za kolejnością kanoniczną adresów.
check('powody obu stron w zdarzeniu', [cancelEvent.reasons.a, cancelEvent.reasons.b], ['holders', 'holders'])

const edge199 = token('0x2222222222222222222222222222222222222222', 'E199', { ...HEALTHY, holders: 199 })
const edge200 = token('0x3333333333333333333333333333333333333333', 'E200', { ...HEALTHY, holders: 200 })
check('199 przeciw zdrowemu → walkower', simulateFight(edge199, real).method, 'walkover')
const atEdge = simulateFight(edge200, real)
check('200 przeciw zdrowemu → prawdziwa walka', ['KO', 'TKO', 'decision', 'draw'].includes(atEdge.method), true)
check('200 przeciw zdrowemu → są rundy', atEdge.rounds.length > 0, true)

console.log('\n== Bramka i koncentracja razem ==')
// Zawodnik, który oblewa oba badania, dostaje jeden powód: holderów.
const failedConcentration = {
  band: 'failed' as const,
  label: 'Failed the medical',
  percent: 80,
  staminaPenalty: 0,
  enforced: true,
}
const both = simulateFight({ ...junk, concentration: failedConcentration }, real)
check('jeden powód na osobę', both.events.filter((e: FightEvent) => e.type === 'medicalsFailed').length, 1)
check('powód to holderzy', (both.events[0] as { reason?: string }).reason, 'holders')

// Sama koncentracja nadal działa i ma swój powód.
const concFight = simulateFight(
  { ...real, concentration: failedConcentration },
  token('0x4444444444444444444444444444444444444444', 'OK', HEALTHY),
)
check('koncentracja 80% nadal walkower', concFight.method, 'walkover')
check('powód to koncentracja', (concFight.events[0] as { reason?: string }).reason, 'concentration')

console.log('\n== Regresja: token bez płynności nie wygrywa ze zdrowym ==')
// Siła jako kapitalizacja / płynność dawała maksimum tokenowi, któremu płynności
// brakowało, i wygrywał nim ze zdrowym. Teraz siła idzie z obrotu, a brak
// płynności to podatność. 200+ holderów, żeby bramka go nie zatrzymała.
const HOLLOW: Raw = {
  liquidityUsd: 5_000,
  marketCapUsd: 50_000_000,
  volume24hUsd: 2_000,
  holders: 400,
  ageDays: 5,
}
check('pusty token: siła niska (z obrotu)', computeStats(HOLLOW).sila < 20, true)
check('pusty token: podatność na suficie', computeVulnerability(HOLLOW), 100)

let healthyWins = 0
let decided = 0
const N = 400
for (let i = 0; i < N; i++) {
  const addr = (tag: number) => `0x${(i * 2 + tag).toString(16).padStart(40, '0')}`
  const r = simulateFight(token(addr(1), 'HOLLOW', HOLLOW), token(addr(2), 'SOLID', HEALTHY))
  if (r.winner === null) continue
  decided++
  // HOLLOW jest stroną `a`, SOLID stroną `b`.
  if (r.winner === 'b') healthyWins++
}
const healthyRate = (healthyWins / decided) * 100
console.log(`     zdrowy wygrywa ${healthyRate.toFixed(0)}% z ${decided} rozstrzygniętych walk`)
check('zdrowy wygrywa zdecydowaną większość', healthyRate > 90, true)

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
