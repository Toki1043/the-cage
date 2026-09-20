/**
 * Kontrola poprawności mapowania — czysta arytmetyka, bez sieci.
 * Uruchomienie: npm run verify:stats
 */
import {
  WEIGHT_CLASSES,
  computeChartModifiers,
  computeStats,
  computeVulnerability,
  latestClose,
  liquidityDamping,
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

// Stałe wejście dla punktów kotwiczących: zmieniamy jedną wielkość naraz.
const base = { liquidityUsd: 1_000, marketCapUsd: 1_000, volume24hUsd: 1_000, holders: 10, ageDays: 0 }
const stats = (over: Partial<typeof base>) => computeStats({ ...base, ...over })

console.log('\n== Kontrola z CLAUDE.md: token AI (Artificial Inu) ==')
// płynność $2,13M, obrót 24h $1M, kapitalizacja $273,4M, 46 755 holderów, 56 dni
//
// Obrót $1M to liczba wzorcowa, nie pomiar: CLAUDE.md nie podaje obrotu AI,
// a obrót 24h zmienia się z godziny na godzinę, więc żywe API i tak da co innego.
// Kontrola sprawdza implementację wzorów przy podanych wejściach. Wcześniej
// siła wychodziła tu 70 — tyle wynosi teraz podatność, ten sam wzór o innej roli.
//
// Szybkość była 39 przy formule z wieku (56 dni), potem 3 przy liniowej skali
// rotacji (0.47 / 15 * 100). Teraz skala jest logarytmiczna, 0,1x → 0 i 10x → 100:
// 1M / 2.13M = 0.47x → (log10(0.47) + 1) / 2 * 100 = 34. Płynność $2,13M jest
// powyżej $200k, więc bez tłumienia.
//
// Te wejścia opisują jedną konkretną parę AI: tę z WETH, utworzoną 22.07.2026.
// Od kiedy parę referencyjną wybieramy deterministycznie po największej
// płynności, dla AI wygrywa para z NVDA ($3,6M, 14.07.2026), więc żywe API daje
// inne liczby niż te. To nie jest sprzeczność. Wybór pary sprawdza
// `sortPairsByLiquidity` niżej i npm run verify:determinism na żywym API.
const aiRaw = {
  liquidityUsd: 2_130_000,
  marketCapUsd: 273_400_000,
  volume24hUsd: 1_000_000,
  holders: 46_755,
  ageDays: 56,
}
const ai = computeStats(aiRaw)
check('statystyki AI', ai, { wytrzymalosc: 67, sila: 60, garda: 73, szybkosc: 34 })
check('podatność AI (dawna „siła" 70)', computeVulnerability(aiRaw), 70)

console.log('\n== Punkty kotwiczące skali ==')
check('płynność $1k → wytrzymałość 0', stats({ liquidityUsd: 1_000 }).wytrzymalosc, 0)
check('płynność $100M → wytrzymałość 100', stats({ liquidityUsd: 100_000_000 }).wytrzymalosc, 100)
check('obrót 24h $1k → siła 0', stats({ volume24hUsd: 1_000 }).sila, 0)
check('obrót 24h $100M → siła 100', stats({ volume24hUsd: 100_000_000 }).sila, 100)
check('obrót 24h $1M → siła 60', stats({ volume24hUsd: 1_000_000 }).sila, 60)
check('10 holderów → garda 0', stats({ holders: 10 }).garda, 0)
check('1M holderów → garda 100', stats({ holders: 1_000_000 }).garda, 100)
// Szybkość z rotacji (volume/liquidity) na skali logarytmicznej: 0,1x → 0,
// 10x → 100. Kotwice liczone przy płynności $1M, czyli bez tłumienia; tłumienie
// przy cienkiej płynności ma własną sekcję niżej.
const speed = (velocity: number, liquidityUsd = 1_000_000) =>
  stats({ volume24hUsd: velocity * liquidityUsd, liquidityUsd }).szybkosc
check('rotacja 0,1x → szybkość 0', speed(0.1), 0)
check('rotacja 10x → szybkość 100', speed(10), 100)
check('rotacja 1x → szybkość 50', speed(1), 50)
check('rotacja 0,5x → szybkość 35', speed(0.5), 35)
check('rotacja 2,6x → szybkość 71', speed(2.6), 71)
check('rotacja 0x → szybkość 0', speed(0), 0)
check('rotacja 0,05x (pod skalą) → szybkość 0, nie ujemna', speed(0.05), 0)
check('rotacja 30x → szybkość 100 (sufit)', speed(30), 100)
// Regresja: skala liniowa (1x → 0, 15x → 100) dawała 3 punkty przy 0,5x i 17 przy
// 2,6x, więc prawie cała populacja siedziała przy zerze. Rotacja 0,5x ma dawać
// 30–40 punktów, a różnica między 0,5x i 2,6x ma być rzędu innych statystyk.
check('rotacja 0,5x mieści się w 30–40 punktach', speed(0.5) >= 30 && speed(0.5) <= 40, true)
check('0,5x → 2,6x to co najmniej 30 punktów różnicy', speed(2.6) - speed(0.5) >= 30, true)
// Skala logarytmiczna: ten sam stosunek to ta sama liczba punktów.
check('dekada 0,1x → 1x = dekada 1x → 10x', speed(1) - speed(0.1), speed(10) - speed(1))
check('szybkość rośnie z rotacją', speed(0.3) < speed(1) && speed(1) < speed(3), true)

console.log('\n== Siła nie zależy od kapitalizacji ani od płynności ==')
// Regresja: siła liczona jako kapitalizacja / płynność dawała maksimum tokenowi
// bez płynności i tym samym wygrywała nim ze zdrowym. To miara ryzyka.
const strengthOf = (over: Partial<typeof base>) => stats({ volume24hUsd: 1_000_000, ...over }).sila
check('kapitalizacja x1000 nie rusza siły', strengthOf({ marketCapUsd: 1_000_000_000 }), strengthOf({ marketCapUsd: 1_000_000 }))
check('zerowa płynność nie podbija siły', strengthOf({ liquidityUsd: 0, marketCapUsd: 1e9 }), 60)
check('brak obrotu → siła 0', stats({ volume24hUsd: 0, marketCapUsd: 1e9, liquidityUsd: 0 }).sila, 0)

console.log('\n== Podatność (kapitalizacja / płynność) ==')
const vuln = (liquidityUsd: number, marketCapUsd: number) => computeVulnerability({ liquidityUsd, marketCapUsd })
check('1x → 0', vuln(1_000_000, 1_000_000), 0)
check('1000x → 100', vuln(1_000_000, 1_000_000_000), 100)
check('mcap poniżej płynności nie schodzi pod 0', vuln(1_000_000, 1_000), 0)
check('powyżej 1000x nie przekracza 100', vuln(1_000, 1e12), 100)
check('zerowa płynność przy dodatniej mcap → sufit', vuln(0, 1e6), 100)
check('brak obu liczb → 0, nie NaN', vuln(0, 0), 0)
check('rośnie z kapitalizacją', vuln(1e6, 1e8) > vuln(1e6, 1e7), true)
check('maleje z płynnością', vuln(1e7, 1e8) < vuln(1e6, 1e8), true)

console.log('\n== Szybkość: tłumienie przy cienkiej płynności ==')
// Rotacja przy płynności poniżej $200k jest podejrzana, nie imponująca: kilka
// transakcji na małej puli robi 10x bez realnej aktywności.
check('płynność $200k → mnożnik 1', liquidityDamping(200_000), 1)
check('płynność $5M → mnożnik 1', liquidityDamping(5_000_000), 1)
check('płynność $1k → dolna granica 0,25', liquidityDamping(1_000), 0.25)
check('płynność poniżej $1k → dolna granica 0,25', liquidityDamping(100), 0.25)
check('zerowa płynność → dolna granica, nie NaN', liquidityDamping(0), 0.25)
check('ujemna płynność → dolna granica, nie NaN', liquidityDamping(-5), 0.25)
check('brak płynności (NaN) → dolna granica, nie NaN', liquidityDamping(Number.NaN), 0.25)
// Ciągłość: skok na progu dawałby token z $199k i $201k na dwóch końcach skali.
check('tuż pod progiem mnożnik prawie 1', liquidityDamping(199_999) > 0.9999, true)
check('$20k → mnożnik 0,67', Math.round(liquidityDamping(20_000) * 100) / 100, 0.67)
let monotone = true
let prev = 0
for (let liq = 500; liq <= 1_000_000; liq *= 1.15) {
  const m = liquidityDamping(liq)
  if (m < prev) monotone = false
  prev = m
}
check('mnożnik nie maleje wraz z płynnością', monotone, true)
check('mnożnik nigdy poniżej 0,25 ani powyżej 1', [500, 5_000, 50_000, 500_000].every((l) => liquidityDamping(l) >= 0.25 && liquidityDamping(l) <= 1), true)

check('rotacja 10x, płynność $200k → 100', speed(10, 200_000), 100)
check('rotacja 10x, płynność $100k → 90', speed(10, 100_000), 90)
check('rotacja 10x, płynność $20k → 67', speed(10, 20_000), 67)
check('rotacja 10x, płynność $1k → 25', speed(10, 1_000), 25)
// Sufit działa przed mnożnikiem. Obcięcie po nim pozwalałoby rotacji 33x na $50k
// wrócić do 100, czyli dawałoby cienkiej płynności pełną premię.
check('rotacja 33x na $50k nie wraca do 100', speed(33, 50_000), speed(10, 50_000))
check('rotacja 33x na $50k = 80', speed(33, 50_000), 80)
check('ta sama wysoka rotacja: cienki rynek poniżej zdrowego', speed(10, 30_000) < speed(10, 2_000_000), true)
check('cienka płynność to zniżka, nie zero', speed(10, 1_000) > 0, true)
check('zerowa rotacja na cienkim rynku dalej 0', speed(0, 5_000), 0)
check('zerowa płynność nie produkuje NaN', stats({ liquidityUsd: 0, volume24hUsd: 1e6 }).szybkosc, 0)
// Tłumienie dotyczy tylko szybkości: pozostałe statystyki liczą się jak dawniej.
const thin = stats({ liquidityUsd: 20_000, volume24hUsd: 200_000, holders: 500 })
const healthy = stats({ liquidityUsd: 20_000_000, volume24hUsd: 200_000, holders: 500 })
check('tłumienie nie rusza siły ani gardy', [thin.sila, thin.garda], [healthy.sila, healthy.garda])

console.log('\n== Obcięcie do 0–100 ==')
// Rotacja 1/1 = 1x → 50 punktów na skali, ale płynność $1 to skrajnie cienki rynek
// (mnożnik 0,25), więc 12,5 zaokrąglone do 13 — ageDays już nie wpływa.
const below = computeStats({ liquidityUsd: 1, marketCapUsd: 1, volume24hUsd: 1, holders: 1, ageDays: 5_000 })
check('poniżej skali nie schodzi pod 0', below, { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 13 })
// Rotacja 1e12 / 1e12 = 1x (nie ponad sufit 10x), płynność bez tłumienia: 50.
const above = computeStats({ liquidityUsd: 1e12, marketCapUsd: 1e18, volume24hUsd: 1e12, holders: 1e9, ageDays: 0 })
check('powyżej skali nie przekracza 100', above, { wytrzymalosc: 100, sila: 100, garda: 100, szybkosc: 50 })
// volume24h: 0, liquidity: 0 → rotacja 0 (dzielenie chronione), log10(0) = -Infinity, clampStat daje 0. Zerowa
// płynność daje też log10(0) = -Infinity na wytrzymałości i sile, a to tez
// clampuje do 0. Nic nie przecieka jako NaN.
const degenerate = computeStats({ liquidityUsd: 0, marketCapUsd: 0, volume24hUsd: 0, holders: 0, ageDays: 0 })
check('zera nie produkują NaN', degenerate, { wytrzymalosc: 0, sila: 0, garda: 0, szybkosc: 0 })
check('nic nie jest NaN', Object.values(degenerate).some(Number.isNaN), false)

console.log('\n== Statystyki nie zależą od przeciwnika ==')
// Ten sam token policzony dwa razy musi dać to samo — normalizacja jest
// na sztywnych progach, nigdy względem rywala.
const solo = computeStats(aiRaw)
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
