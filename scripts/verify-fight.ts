/**
 * Kontrola symulacji walki — czysta arytmetyka, bez sieci.
 * Uruchomienie: npm run verify:fight
 */
import {
  ROUNDS,
  combatProfile,
  seedKey,
  seededRandom,
  simulateFight,
  type FighterInput,
} from '../src/lib/fight.ts'
import type { ChartModifiers, FightStats } from '../src/lib/stats.ts'

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

const mods = (over: Partial<ChartModifiers> = {}): ChartModifiers => ({
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
  ...over,
})

const fighter = (
  address: string,
  symbol: string,
  stats: FightStats,
  over: Partial<ChartModifiers> = {},
): FighterInput => ({ address, symbol, stats, modifiers: mods(over) })

// Realne statystyki z żywego API: AI i WETH na parach referencyjnych.
const AI = fighter('0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', 'AI', {
  wytrzymalosc: 71,
  sila: 63,
  garda: 73,
  szybkosc: 37,
}, { volatility: 2.7792, drawdownFromPeakClose: 0.0817, priceChange24h: -0.083 })

const WETH = fighter('0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH', {
  wytrzymalosc: 84,
  sila: 28,
  garda: 95,
  szybkosc: 34,
}, { volatility: 0.5325, drawdownFromPeakClose: 0.0429, priceChange24h: -0.0167 })

console.log('\n== Ziarno ==')
check('klucz sortuje adresy', seedKey('0xbbb', '0xaaa'), '0xaaa|0xbbb')
check('klucz nieczuły na kolejność', seedKey('0xaaa', '0xbbb'), seedKey('0xbbb', '0xaaa'))
check('klucz nieczuły na wielkość liter', seedKey('0xAAA', '0xBBB'), seedKey('0xaaa', '0xbbb'))
check('ziarno powtarzalne', seededRandom('x').seed, seededRandom('x').seed)
check('inny klucz, inne ziarno', seededRandom('x').seed !== seededRandom('y').seed, true)
check('ziarno to 32 znaki hex', /^[0-9a-f]{32}$/.test(seededRandom('x').seed), true)

// Generator musi dawać ten sam strumień i mieścić się w [0,1).
const streamA = Array.from({ length: 500 }, () => seededRandom('seed').next())
const rngB = seededRandom('seed')
const streamB = Array.from({ length: 500 }, () => rngB.next())
check('pierwsza liczba zawsze ta sama', streamA[0], streamB[0])
check('strumień w [0,1)', streamB.every((n) => n >= 0 && n < 1), true)
check('strumień się nie zapętla od razu', new Set(streamB).size, 500)

console.log('\n== Determinizm walki ==')
const one = simulateFight(AI, WETH)
const two = simulateFight(AI, WETH)
check('dwa wywołania bit w bit identyczne', JSON.stringify(one), JSON.stringify(two))
check('trzy rundy zaplanowane', ROUNDS, 3)
check('ziarno w wyniku', one.seed === two.seed, true)

// Odwrócona kolejność adresów to ta sama walka, tylko opisana z drugiej
// strony. Inaczej dałoby się przelosować wynik zamianą pól wejściowych.
const swapped = simulateFight(WETH, AI)
check('zamiana stron: to samo ziarno', swapped.seed, one.seed)
check('zamiana stron: ten sam zwycięzca', swapped.winner === 'a' ? 'WETH' : swapped.winner === 'b' ? 'AI' : null, one.winner === 'a' ? 'AI' : one.winner === 'b' ? 'WETH' : null)
check('zamiana stron: ten sam sposób', swapped.method, one.method)
check('zamiana stron: ta sama liczba rund', swapped.rounds.length, one.rounds.length)
check(
  'zamiana stron: karta punktowa przelustrowana',
  [swapped.scorecard.b, swapped.scorecard.a],
  [one.scorecard.a, one.scorecard.b],
)

console.log('\n== Spójność wyniku ==')
check('zwycięzca to a, b albo null', ['a', 'b', null].includes(one.winner), true)
check('rund nie więcej niż trzy', one.rounds.length <= ROUNDS, true)
check('numery rund po kolei', one.rounds.map((r) => r.round), Array.from({ length: one.rounds.length }, (_, i) => i + 1))
check(
  'karta to suma rund',
  [one.scorecard.a, one.scorecard.b],
  [
    one.rounds.reduce((s, r) => s + r.score.a, 0),
    one.rounds.reduce((s, r) => s + r.score.b, 0),
  ],
)
check(
  'obrażenia to suma rund',
  [
    Math.round(one.rounds.reduce((s, r) => s + r.damage.a, 0)),
    Math.round(one.rounds.reduce((s, r) => s + r.damage.b, 0)),
  ],
  [Math.round(one.damageDealt.a), Math.round(one.damageDealt.b)],
)
check('remis tylko gdy brak zwycięzcy', one.method === 'draw' ? one.winner === null : one.winner !== null, true)
check('nokaut ma rundę, punkty nie mają', one.method === 'decision' || one.method === 'draw' ? one.endedInRound === null : typeof one.endedInRound === 'number', true)
check('instrukcje sędziego jako pierwsze', one.events[0].type, 'instructions')
check('każda runda ma swój start', one.events.filter((e) => e.type === 'roundStart').length, one.rounds.length)
check('życie nie schodzi pod zero', one.rounds.every((r) => r.hpAfter.a >= 0 && r.hpAfter.b >= 0), true)

console.log('\n== Sędzia ogłasza, nie decyduje ==')
// Odliczanie jest animacją: przy nokaucie zawsze dochodzi do dziesięciu,
// przy nokdaunie kończy się na ośmiu (CLAUDE.md § Sędzia).
const ko = one.events.find((e) => e.type === 'knockout')
const kd = one.events.find((e) => e.type === 'knockdown')
check('nokaut liczony do dziesięciu', ko === undefined || ko.countTo === 10, true)
check('nokdaun liczony do ośmiu', kd === undefined || kd.countTo === 8, true)
check(
  'walka na punkty kończy się werdyktem',
  one.method === 'KO' || one.method === 'TKO' || one.events.at(-1)?.type === 'decision',
  true,
)

console.log('\n== Statystyki wpływają na parametry ringowe ==')
const strong = combatProfile(fighter('0x1', 'S', { wytrzymalosc: 100, sila: 100, garda: 100, szybkosc: 100 }, { volatility: 0 }))
const weak = combatProfile(fighter('0x2', 'W', { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 0 }, { volatility: 0 }))
check('wyższa wytrzymałość = więcej życia', strong.hpStart > weak.hpStart, true)
check('wyższa siła = mocniejszy cios', strong.power > weak.power, true)
check('wyższa szybkość = wyższe tempo', strong.tempo > weak.tempo, true)
check('wyższa garda = mniej obrażeń przyjętych', strong.guardSoak < weak.guardSoak, true)

// Spadek od szczytu: token daleko od szczytu wchodzi poobijany.
const fresh = combatProfile(fighter('0x1', 'F', { wytrzymalosc: 80, sila: 50, garda: 50, szybkosc: 50 }, { drawdownFromPeakClose: 0 }))
const beaten = combatProfile(fighter('0x1', 'B', { wytrzymalosc: 80, sila: 50, garda: 50, szybkosc: 50 }, { drawdownFromPeakClose: 1 }))
check('spadek od szczytu obniża życie', beaten.hpStart < fresh.hpStart, true)
check('obniżka ograniczona do jednej czwartej', Math.round((1 - beaten.hpStart / fresh.hpStart) * 100), 25)

// Zmienność: mocniejsze, ale mniej celne ciosy.
const calm = combatProfile(fighter('0x1', 'C', { wytrzymalosc: 50, sila: 50, garda: 50, szybkosc: 50 }, { volatility: 0 }))
const wild = combatProfile(fighter('0x1', 'V', { wytrzymalosc: 50, sila: 50, garda: 50, szybkosc: 50 }, { volatility: 3 }))
check('zmienność rozszerza widełki obrażeń', wild.damageSpread > calm.damageSpread, true)
check('zmienność obniża celność', wild.accuracy < calm.accuracy, true)

console.log('\n== Drobny dryf modyfikatorów nie zmienia walki ==')
// Modyfikatory przychodzą ze świec jako floaty i drgają z każdą zmianą ceny.
// Symulacja musi je kwantować, inaczej ten sam wynik ma za każdym razem inny
// przebieg cios po ciosie — a to właśnie ten przebieg się animuje.
const drifted = (base: FighterInput, d: number): FighterInput => ({
  ...base,
  modifiers: {
    ...base.modifiers,
    volatility: (base.modifiers.volatility ?? 0) + d,
    drawdownFromPeakClose: (base.modifiers.drawdownFromPeakClose ?? 0) + d / 10,
    priceChange24h: (base.modifiers.priceChange24h ?? 0) + d / 10,
  },
})
check(
  'profil bojowy niewrażliwy na dryf w czwartym miejscu',
  JSON.stringify(combatProfile(drifted(AI, 0.0004))),
  JSON.stringify(combatProfile(AI)),
)
check(
  'cała walka identyczna co do ciosu po drobnym dryfie',
  JSON.stringify(simulateFight(drifted(AI, 0.0004), drifted(WETH, -0.0003)).events),
  JSON.stringify(simulateFight(AI, WETH).events),
)
// Zmiana, która faktycznie coś znaczy, nadal musi być widoczna.
check(
  'wyraźna zmiana zmienności zmienia profil',
  JSON.stringify(combatProfile(drifted(AI, 0.5))) !== JSON.stringify(combatProfile(AI)),
  true,
)

console.log('\n== Brak danych nie wywala symulacji ==')
const bare: FighterInput = {
  address: '0xdead',
  symbol: 'BARE',
  stats: { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 0 },
  modifiers: mods({ volatility: null, drawdownFromPeakClose: null, priceChange24h: null }),
}
const bareFight = simulateFight(bare, AI)
check('walka z brakiem modyfikatorów dochodzi do końca', ['KO', 'TKO', 'decision', 'draw'].includes(bareFight.method), true)
check('brak modyfikatorów nie daje NaN', Number.isFinite(bareFight.damageDealt.a) && Number.isFinite(bareFight.damageDealt.b), true)
check('zerowe statystyki dają dodatnie życie', combatProfile(bare).hpStart > 0, true)

console.log('\n== Różnorodność wyników ==')
// Ten sam token z różnymi przeciwnikami nie może dostać tego samego przebiegu.
const third = fighter('0x9999999999999999999999999999999999999999', 'THIRD', {
  wytrzymalosc: 50,
  sila: 50,
  garda: 50,
  szybkosc: 50,
})
check('inna para = inne ziarno', simulateFight(AI, third).seed !== one.seed, true)
check('inna para = inny przebieg', JSON.stringify(simulateFight(AI, third).rounds) !== JSON.stringify(one.rounds), true)

console.log('\n== Balans ==')
// Stałe balansu są strojone, nie wyprowadzone z danych, więc te progi
// pilnują, żeby kolejne strojenie nie zepsuło rozkładu po cichu. Pomiary są
// w pełni deterministyczne — generator statystyk niżej też ma ziarno.
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const randStats = (): FightStats => ({
  wytrzymalosc: Math.round(rnd() * 100),
  sila: Math.round(rnd() * 100),
  garda: Math.round(rnd() * 100),
  szybkosc: Math.round(rnd() * 100),
})
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const statSum = (s: FightStats) => s.wytrzymalosc + s.sila + s.garda + s.szybkosc

const N = 1500
let early = 0
const seenMethods = new Set<string>()
const winners = new Set<string>()
for (let i = 0; i < N; i++) {
  const r = simulateFight(
    fighter(addr(i * 2), 'X', randStats(), { volatility: rnd() * 3 }),
    fighter(addr(i * 2 + 1), 'Y', randStats(), { volatility: rnd() * 3 }),
  )
  if (r.method === 'KO' || r.method === 'TKO') early++
  seenMethods.add(r.method)
  winners.add(String(r.winner))
}
const koRate = (early / N) * 100
console.log(`     na ${N} par: nokauty ${koRate.toFixed(1)}%, sposoby ${[...seenMethods].join('/')}`)
// Nokaut ma być wydarzeniem, nie normą: przy połowie walk kończonych przed
// czasem trzecia runda przestawała istnieć.
check('nokaut w 5-25% walk', koRate >= 5 && koRate <= 25, true)
check('większość walk idzie na punkty', koRate < 50, true)
check('obie strony potrafią wygrać', winners.has('a') && winners.has('b'), true)

// Żadna statystyka nie może decydować sama. Przy podwójnych dźwigniach
// szybkość wygrywała 98% pojedynków 80 vs 20, a wytrzymałość 53%.
const influence: Record<string, number> = {}
for (const key of ['wytrzymalosc', 'sila', 'garda', 'szybkosc'] as const) {
  let wins = 0
  let total = 0
  for (let i = 0; i < 600; i++) {
    const base = { wytrzymalosc: 50, sila: 50, garda: 50, szybkosc: 50 }
    const r = simulateFight(
      fighter(addr(i * 2 + 500_000), 'HI', { ...base, [key]: 80 }),
      fighter(addr(i * 2 + 500_001), 'LO', { ...base, [key]: 20 }),
    )
    if (r.winner !== null) {
      total++
      if (r.winner === 'a') wins++
    }
  }
  influence[key] = (wins / total) * 100
}
const infl = Object.values(influence)
console.log(`     wpływ 80 vs 20: ${Object.entries(influence).map(([k, v]) => `${k}=${v.toFixed(0)}%`).join(' ')}`)
check('każda statystyka daje realną przewagę', infl.every((v) => v > 60), true)
check('żadna statystyka nie decyduje sama', infl.every((v) => v < 95), true)
check('rozrzut wpływu poniżej 25 punktów', Math.max(...infl) - Math.min(...infl) < 25, true)

// Krzywa: równy pojedynek ma być niepewny, duża przewaga niemal pewna.
// Inaczej albo ranking jest szumem, albo animacja nie ma stawki.
function favouriteWinRate(lo: number, hi: number): number {
  let w = 0
  let t = 0
  for (let i = 0; i < 40_000 && t < 500; i++) {
    const sa = randStats()
    const sb = randStats()
    const edge = Math.abs(statSum(sa) - statSum(sb))
    if (edge < lo || edge >= hi) continue
    const r = simulateFight(
      fighter(addr(i * 2 + 7_000_000), 'A', sa),
      fighter(addr(i * 2 + 7_000_001), 'B', sb),
    )
    if (r.winner === null) continue
    t++
    if ((r.winner === 'a') === statSum(sa) > statSum(sb)) w++
  }
  return (w / t) * 100
}
const even = favouriteWinRate(0, 10)
const mid = favouriteWinRate(25, 50)
const wide = favouriteWinRate(80, 120)
console.log(`     faworyt: przewaga 0-10 → ${even.toFixed(0)}%, 25-50 → ${mid.toFixed(0)}%, 80-120 → ${wide.toFixed(0)}%`)
check('równy pojedynek jest niepewny', even > 45 && even < 62, true)
check('duża przewaga niemal pewna', wide > 85, true)
check('przewaga rośnie z różnicą statystyk', even < mid && mid < wide, true)

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
