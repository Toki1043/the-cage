/**
 * Rozkład wyników walk — do oglądania po każdym strojeniu balansu.
 * Uruchomienie: npm run check:balance [-- liczbaPar]
 *
 * Pary są generowane z ziarna, nie z `Math.random()`, więc ten sam przebieg
 * daje zawsze ten sam raport i da się go porównać z poprzednim. Statystyki
 * są losowane po całym zakresie 0–100, co jest szerszym rozrzutem niż
 * u prawdziwych tokenów — tam wytrzymałość i garda trzymają się góry skali.
 */
import { ROUNDS, simulateFight, type FighterInput, type FightMethod } from '../src/lib/fight.ts'
import { concentrationUnavailable, concentrationVerdict } from '../src/lib/concentration.ts'
import { holderGate } from '../src/lib/holder-gate.ts'
import { honeypotGate, securityUnavailable } from '../src/lib/security.ts'
import type { ChartModifiers } from '../src/lib/stats.ts'

const COUNT = Number(process.argv[2] ?? 100)
const SEED = Number(process.env.SEED ?? 20260918)

/** Generator par: ta sama liczba w wejściu, ten sam raport na wyjściu. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

const rnd = seededRng(SEED)
const clear = concentrationVerdict(concentrationUnavailable(null, 'brak danych o saldach'))

const modifiers = (volatility: number): ChartModifiers => ({
  priceChange1h: 0,
  priceChange24h: 0,
  priceChange7d: 0,
  priceChange7dWindowDays: 7,
  peakCloseUsd: 1,
  peakAt: 0,
  drawdownFromPeakClose: 0,
  volatility,
  volatilityBasisDays: 30,
  barCount: 30,
  windowDays: 30,
})

function fighter(index: number, tag: 'a' | 'b'): FighterInput {
  return {
    address: `0x${tag}${index.toString(16).padStart(39, '0')}`,
    symbol: `${tag.toUpperCase()}${index}`,
    stats: {
      wytrzymalosc: Math.round(rnd() * 100),
      sila: Math.round(rnd() * 100),
      garda: Math.round(rnd() * 100),
      szybkosc: Math.round(rnd() * 100),
    },
    modifiers: modifiers(Math.round(rnd() * 300) / 100),
    // Podatność po całej skali, tak jak statystyki — ta sama zasada co
    // w `verify:fight`. Bramka przepuszcza: liczy się rozkład samych walk.
    vulnerability: Math.round(rnd() * 100),
    survivalBonus: 0,
    holderGate: holderGate(10_000),
    honeypotGate: honeypotGate(securityUnavailable(4663, 'test')),
    concentration: clear,
  }
}

const methods: Record<string, number> = {}
const knockdownHistogram = new Map<number, number>()
const stoppageRound = new Map<number, number>()
const tkoDetails: string[] = []
let knockdownsTotal = 0
let fightsWithKnockdown = 0
let punches = 0
let landed = 0

for (let i = 0; i < COUNT; i++) {
  const a = fighter(i, 'a')
  const b = fighter(i, 'b')
  const fight = simulateFight(a, b)

  methods[fight.method] = (methods[fight.method] ?? 0) + 1

  const knockdowns = fight.rounds.reduce(
    (n, round) => n + round.knockdowns.a + round.knockdowns.b,
    0,
  )
  knockdownsTotal += knockdowns
  if (knockdowns > 0) fightsWithKnockdown++
  knockdownHistogram.set(knockdowns, (knockdownHistogram.get(knockdowns) ?? 0) + 1)

  if (fight.endedInRound !== null) {
    stoppageRound.set(fight.endedInRound, (stoppageRound.get(fight.endedInRound) ?? 0) + 1)
  }
  if (fight.method === 'TKO') {
    const loser = fight.winner === 'a' ? 'b' : 'a'
    const down = fight.rounds.at(-1)?.knockdowns[loser] ?? 0
    tkoDetails.push(
      `para #${i}: $${fight.winner === 'a' ? a.symbol : b.symbol} przez TKO ` +
      `w rundzie ${fight.endedInRound}, ${down} nokdauny`,
    )
  }

  for (const event of fight.events) {
    if (event.type === 'punch') {
      punches++
      if (event.landed) landed++
    }
  }
}

const pct = (n: number) => `${((n / COUNT) * 100).toFixed(0)}%`
const bar = (n: number) => '#'.repeat(Math.round((n / COUNT) * 50))

console.log(`\n== Rozkład na ${COUNT} parach (ziarno par ${SEED}, ${ROUNDS} rundy) ==\n`)

console.log('Sposób rozstrzygnięcia:')
const order: FightMethod[] = ['decision', 'KO', 'TKO', 'draw', 'walkover', 'cancelled']
for (const method of order) {
  const n = methods[method] ?? 0
  if (n === 0 && (method === 'walkover' || method === 'cancelled' || method === 'draw')) continue
  console.log(`  ${method.padEnd(10)} ${String(n).padStart(3)}  ${pct(n).padStart(4)}  ${bar(n)}`)
}

console.log('\nNokdauny w walce:')
for (const count of [...knockdownHistogram.keys()].sort((x, y) => x - y)) {
  const n = knockdownHistogram.get(count)!
  console.log(`  ${count} × na deskach  ${String(n).padStart(3)}  ${pct(n).padStart(4)}  ${bar(n)}`)
}
console.log(
  `\n  walk z co najmniej jednym nokdaunem: ${fightsWithKnockdown} (${pct(fightsWithKnockdown)})`,
)
console.log(`  nokdaunów łącznie: ${knockdownsTotal}, czyli ${(knockdownsTotal / COUNT).toFixed(2)} na walkę`)

if (stoppageRound.size > 0) {
  console.log('\nRunda, w której padł nokaut:')
  for (const round of [...stoppageRound.keys()].sort((x, y) => x - y)) {
    const n = stoppageRound.get(round)!
    console.log(`  runda ${round}  ${String(n).padStart(3)}  ${pct(n).padStart(4)}  ${bar(n)}`)
  }
}

if (tkoDetails.length > 0) {
  console.log('\nTKO — trzy nokdauny w jednej rundzie:')
  for (const line of tkoDetails) console.log(`  ${line}`)
} else {
  console.log('\nTKO: żadnego w tej próbce (przy ~1,8% na walkę to normalne na stu parach).')
}

console.log(
  `\nCiosy: ${(punches / COUNT).toFixed(1)} na walkę, trafionych ${(landed / COUNT).toFixed(1)} ` +
  `(${((landed / punches) * 100).toFixed(0)}%). Ciężkich, czyli z górnej ćwiartki, jest co czwarty ` +
  `trafiony — nokdaunem kończy się tylko ten, który trafia w już poobijanego.\n`,
)
