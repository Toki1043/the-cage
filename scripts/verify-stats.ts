/**
 * Kontrola poprawności mapowania — czysta arytmetyka, bez sieci.
 * Uruchomienie: npm run verify:stats
 */
import {
  WEIGHT_CLASSES,
  computeChartModifiers,
  computeStats,
  latestClose,
  matchup,
  sortPairsByLiquidity,
  weightClass,
} from '../src/lib/stats.ts'

let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? ` = ${a}` : `\n       oczekiwano ${e}\n       otrzymano  ${a}`}`)
}

console.log('\n== Kontrola z CLAUDE.md: token AI (Artificial Inu) ==')
// płynność $2,13M, kapitalizacja $273,4M, 46 755 holderów, 56 dni
//
// Te wejścia opisują jedną konkretną parę AI: tę z WETH, utworzoną 22.07.2026.
// Od kiedy parę referencyjną wybieramy deterministycznie po największej
// płynności, dla AI wygrywa para z NVDA ($3,6M, 14.07.2026) i żywe API daje
// 71/63/73/37, nie 67/70/73/39.
//
// To nie jest sprzeczność: ta kontrola sprawdza implementację wzorów przy
// podanych wejściach i nadal musi dawać 67/70/73/39. Wybór pary sprawdza
// `sortPairsByLiquidity` niżej i npm run verify:determinism na żywym API.
const ai = computeStats({
  liquidityUsd: 2_130_000,
  marketCapUsd: 273_400_000,
  holders: 46_755,
  ageDays: 56,
})
check('statystyki AI', ai, { wytrzymalosc: 67, sila: 70, garda: 73, szybkosc: 39 })

console.log('\n== Punkty kotwiczące skali ==')
check('płynność $1k → wytrzymałość 0', computeStats({ liquidityUsd: 1_000, marketCapUsd: 1_000, holders: 10, ageDays: 0 }).wytrzymalosc, 0)
check('płynność $100M → wytrzymałość 100', computeStats({ liquidityUsd: 100_000_000, marketCapUsd: 100_000_000, holders: 10, ageDays: 0 }).wytrzymalosc, 100)
check('mcap/płynność 1x → siła 0', computeStats({ liquidityUsd: 1_000_000, marketCapUsd: 1_000_000, holders: 10, ageDays: 0 }).sila, 0)
check('mcap/płynność 1000x → siła 100', computeStats({ liquidityUsd: 1_000_000, marketCapUsd: 1_000_000_000, holders: 10, ageDays: 0 }).sila, 100)
check('10 holderów → garda 0', computeStats({ liquidityUsd: 1_000, marketCapUsd: 1_000, holders: 10, ageDays: 0 }).garda, 0)
check('1M holderów → garda 100', computeStats({ liquidityUsd: 1_000, marketCapUsd: 1_000, holders: 1_000_000, ageDays: 0 }).garda, 100)
check('0 dni → szybkość 100', computeStats({ liquidityUsd: 1_000, marketCapUsd: 1_000, holders: 10, ageDays: 0 }).szybkosc, 100)
check('730 dni → szybkość 0', computeStats({ liquidityUsd: 1_000, marketCapUsd: 1_000, holders: 10, ageDays: 730 }).szybkosc, 0)

console.log('\n== Obcięcie do 0–100 ==')
const below = computeStats({ liquidityUsd: 1, marketCapUsd: 1, holders: 1, ageDays: 5_000 })
check('poniżej skali nie schodzi pod 0', below, { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 0 })
const above = computeStats({ liquidityUsd: 1e12, marketCapUsd: 1e18, holders: 1e9, ageDays: 0 })
check('powyżej skali nie przekracza 100', above, { wytrzymalosc: 100, sila: 100, garda: 100, szybkosc: 100 })
// Zerowa płynność daje log10(0) = -Infinity, a 0/0 daje NaN. Jedno i drugie
// musi siadać na 0, nie przeciekać jako NaN. Szybkość 100 jest tu poprawna:
// wiek 0 dni to udokumentowana kotwica skali, nie artefakt.
const degenerate = computeStats({ liquidityUsd: 0, marketCapUsd: 0, holders: 0, ageDays: 0 })
check('zera nie produkują NaN', degenerate, { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 100 })
check('mcap bez płynności → siła na sufit', computeStats({ liquidityUsd: 0, marketCapUsd: 1e6, holders: 10, ageDays: 0 }).sila, 100)
check('nic nie jest NaN', Object.values(degenerate).some(Number.isNaN), false)

console.log('\n== Statystyki nie zależą od przeciwnika ==')
// Ten sam token policzony dwa razy musi dać to samo — normalizacja jest
// na sztywnych progach, nigdy względem rywala.
const solo = computeStats({ liquidityUsd: 2_130_000, marketCapUsd: 273_400_000, holders: 46_755, ageDays: 56 })
check('powtórzone wywołanie identyczne', solo, ai)

console.log('\n== Kategorie wagowe ==')
check('$1M', weightClass(1_000_000).id, 'musza')
check('$3M (granica)', weightClass(3_000_000).id, 'lekka')
check('$10M', weightClass(10_000_000).id, 'lekka')
check('$20M (granica)', weightClass(20_000_000).id, 'srednia')
check('$100M (granica)', weightClass(100_000_000).id, 'polciezka')
check('$273,4M (AI)', weightClass(273_400_000).id, 'polciezka')
check('$500M (granica)', weightClass(500_000_000).id, 'ciezka')
check('$50B', weightClass(50_000_000_000).id, 'ciezka')
check('$0', weightClass(0).id, 'musza')

// Progi muszą się stykać bez dziur — każda kapitalizacja wpada dokładnie
// w jedną kategorię. Sprawdzamy gęsto po obu stronach każdej granicy.
let gaps = 0
const edges = WEIGHT_CLASSES.filter((c) => Number.isFinite(c.maxUsd)).map((c) => c.maxUsd)
for (const edge of edges) {
  for (const mcap of [edge - 1, edge, edge + 1]) {
    const hits = WEIGHT_CLASSES.filter((c) => mcap < c.maxUsd)
    if (hits.length === 0 || hits[0].id !== weightClass(mcap).id) gaps++
  }
}
check('brak dziur na granicach', gaps, 0)
check('pięć kategorii', WEIGHT_CLASSES.length, 5)

console.log('\n== Zestawienie zawodników ==')
check('ta sama kategoria', matchup(weightClass(5e6), weightClass(10e6)), { crossClass: false, classGap: 0, punchingUp: null })
check('lżejszy A bije w górę', matchup(weightClass(1e6), weightClass(600e6)), { crossClass: true, classGap: 4, punchingUp: 'a' })
check('lżejszy B bije w górę', matchup(weightClass(600e6), weightClass(1e6)), { crossClass: true, classGap: 4, punchingUp: 'b' })

console.log('\n== Wybór pary referencyjnej ==')
// Zawsze para o największej płynności. Przy równej płynności decyduje adres,
// żeby kolejność nie zależała od tego, co API zwróci pierwsze.
const pairs = [
  { address: '0xbbb', liquidityUsd: 703_860, createdAt: 300, backingSymbol: 'USDG', exchange: 'Uniswap' },
  { address: '0xaaa', liquidityUsd: 3_575_257, createdAt: 100, backingSymbol: 'NVDA', exchange: 'Uniswap' },
  { address: '0xccc', liquidityUsd: 2_205_459, createdAt: 200, backingSymbol: 'WETH', exchange: 'Uniswap' },
]
check('bierze największą płynność', sortPairsByLiquidity(pairs)[0].address, '0xaaa')
check('kolejność malejąco po płynności', sortPairsByLiquidity(pairs).map((p) => p.address), ['0xaaa', '0xccc', '0xbbb'])
check('nie mutuje wejścia', pairs[0].address, '0xbbb')

const tied = [
  { address: '0xff', liquidityUsd: 1_000, createdAt: 1, backingSymbol: null, exchange: null },
  { address: '0x11', liquidityUsd: 1_000, createdAt: 2, backingSymbol: null, exchange: null },
]
check('równa płynność: rozstrzyga adres', sortPairsByLiquidity(tied)[0].address, '0x11')
check('równa płynność: odwrotne wejście, ten sam wynik', sortPairsByLiquidity([...tied].reverse())[0].address, '0x11')

console.log('\n== Modyfikatory z wykresu ==')
const day = 86_400
const hour = 3_600
const t0 = 1_700_000_000

// Osiem świec dziennych: 100 → 150 (szczyt) → 120.
const daily = {
  t: Array.from({ length: 8 }, (_, i) => t0 + i * day),
  c: [100, 110, 130, 150, 140, 135, 125, 120],
}
// Dwadzieścia sześć świec godzinowych, płaskie 100 poza dwiema ostatnimi.
const hourly = {
  t: Array.from({ length: 26 }, (_, i) => t0 + i * hour),
  c: [...Array.from({ length: 24 }, () => 100), 110, 121],
}
const mods = computeChartModifiers(daily, hourly)
check('zmiana 1h ze świec godzinowych (110 → 121)', mods.priceChange1h, 0.1)
check('zmiana 24h ze świec godzinowych (100 → 121)', mods.priceChange24h, 0.21)
check('zmiana 7d ze świec dziennych (100 → 120)', mods.priceChange7d, 0.2)
check('okno 7d to 7 dni', mods.priceChange7dWindowDays, 7)
check('szczyt to najwyższe zamknięcie', mods.peakCloseUsd, 150)
check('spadek od szczytu (150 → 120)', mods.drawdownFromPeakClose, 0.2)
check('liczba świec dziennych', mods.barCount, 8)
check('zmienność policzona', typeof mods.volatility === 'number' && mods.volatility > 0, true)
check('podstawa zmienności to 7 zwrotów', mods.volatilityBasisDays, 7)
check('cena to ostatnie zamknięcie godzinowe', latestClose(hourly), 121)

console.log('\n== Modyfikatory: przypadki brzegowe ==')
// Regresja: świeca startowa tokena AI miała maksimum 6,6e+41 przy otwarciu
// 0,0118 i dawała spadek 100% każdemu świeżo wystartowanemu tokenowi. Szczyt
// liczony z zamknięć tego nie łapie — zamknięcia były zdrowe.
const launch = computeChartModifiers(
  { t: [t0, t0 + day, t0 + 2 * day], c: [0.0127775, 0.00599556, 0.2775] },
  null,
)
check('szczyt ze zamknięć, nie z maksimum startowego', launch.peakCloseUsd, 0.2775)
check('spadek od szczytu zdrowy, nie 1', launch.drawdownFromPeakClose, 0)

// Para młodsza niż okno 7d: liczymy na tym co jest i mówimy ile to objęło.
const young = computeChartModifiers({ t: [t0, t0 + 2 * day], c: [100, 150] }, null)
check('młoda para: zmiana na krótszym oknie', young.priceChange7d, 0.5)
check('młoda para: okno raportowane jako 2 dni', young.priceChange7dWindowDays, 2)

// Dziury i brak świec nie mogą wywalać rachunku.
const holey = computeChartModifiers({ t: [t0, t0 + day, t0 + 2 * day], c: [100, null, 120] }, null)
check('dziury w świecach pomijane', holey.barCount, 2)
const none = computeChartModifiers(null, null)
check('brak świec: wszystko null', [none.priceChange1h, none.priceChange24h, none.priceChange7d, none.drawdownFromPeakClose, none.volatility], [null, null, null, null, null])
check('brak świec: cena null', latestClose(null), null)
check('jedna świeca: brak zmienności', computeChartModifiers({ t: [t0], c: [100] }, null).volatility, null)
check('zamknięcia niedodatnie odsiane', computeChartModifiers({ t: [t0, t0 + day, t0 + 2 * day], c: [0, -5, 120] }, null).barCount, 1)

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
