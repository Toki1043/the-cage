/**
 * Czysta arytmetyka: liczby z Codexu → statystyki bokserskie, kategoria wagowa,
 * modyfikatory z wykresu. Bez sieci, bez env, bez modelu językowego.
 *
 * Wszystko tutaj jest deterministyczne — te same wejścia dają zawsze te same
 * wyjścia. Patrz CLAUDE.md § Zasada nadrzędna i § Determinizm.
 */

/** Wejście do mapowania — surowe liczby ze snapshotu. */
export interface RawTokenNumbers {
  liquidityUsd: number
  marketCapUsd: number
  /** Obrót z ostatnich 24h na parze referencyjnej, w dolarach. */
  volume24hUsd: number
  holders: number
  /** Wiek pary w dniach; może być ułamkowy. */
  ageDays: number
}

export interface FightStats {
  wytrzymalosc: number
  sila: number
  garda: number
  szybkosc: number
}

/**
 * Sztywne progi, nigdy względem przeciwnika — ten sam token ma te same
 * statystyki w każdej walce. Skala logarytmiczna, bo te wielkości chodzą
 * w rzędach wielkości. Patrz CLAUDE.md § Mapowanie danych na statystyki.
 */
export const STAT_SCALE = {
  /** $1k → 0, $100M → 100 */
  wytrzymalosc: { minLog: 3, decades: 5 },
  /** Obrót 24h — te same progi co wytrzymałość: $1k → 0, $100M → 100 */
  sila: { minLog: 3, decades: 5 },
  /** Kapitalizacja / płynność: 1x → 0, 1000x → 100. To podatność, nie siła. */
  vulnerability: { decades: 3 },
  /** 10 holderów → 0, 1M → 100 */
  garda: { minLog: 1, decades: 5 },
  /**
   * Rotacja płynności (velocity): 0,1x → 0, 10x → 100, skala logarytmiczna,
   * powyżej 10x sufit. Wtedy 0,5x daje 35 punktów, 1x daje 50, a 2,6x daje 71.
   *
   * Obrót 24h / płynność pokazuje, ile razy dziennie płynność "obraca się".
   * Wysoka rotacja = aktywny token = wysokie tempo w ringu. Rotacja chodzi
   * w rzędach wielkości, jak płynność i obrót, więc skala też jest
   * logarytmiczna. Liniowa (dawne 1x → 0, 15x → 100) dawała 3 punkty przy 0,5x
   * i 17 przy 2,6x: prawie cała populacja lądowała przy zerze, a szybkość
   * prawie nie różnicowała zawodników. Dwie dekady na całą skalę (50 punktów na
   * dekadę) są szersze niż u pozostałych statystyk (20 na dekadę), bo rotacja
   * ma znacznie węższy zakres niż płynność: prawie każdy token mieści się
   * między 0,1x a 10x. Sufit przy 10x: token z 33x nie dostaje więcej niż z 10x.
   */
  szybkosc: { minVelocity: 0.1, decades: 2 },
  /**
   * Tłumienie szybkości przy cienkiej płynności: poniżej $200k wysoka rotacja
   * jest podejrzana, nie imponująca. Kilka transakcji na małej puli robi
   * rotację 10x bez żadnej realnej aktywności, więc taki token nie dostaje
   * pełnej premii.
   *
   * Mnożnik ciągły, nie próg: $200k i więcej → 1, $1k i mniej → `minDamping`,
   * pomiędzy liniowo po logarytmie płynności. Skok na progu dawałby token
   * z $199k i $201k na dwóch końcach skali. Sam mnożnik nie zeruje szybkości:
   * cienka płynność to zniżka, nie dyskwalifikacja.
   */
  thinLiquidity: { thresholdUsd: 200_000, floorUsd: 1_000, minDamping: 0.25 },
  /**
   * Survival bonus: wiek pary → bonus do puli życia.
   *
   * 0–7 dni: brak bonusu (świeżość nie jest premią)
   * 7–30 dni: bonus rośnie liniowo od 0% do +10%
   * 30+ dni: bonus +10% (sufit)
   *
   * Przetrwanie miesiąca to sygnał jakości. Większość tokenów umiera w pierwszych
   * tygodniach, więc wiek ma wartość — szybkość nie.
   */
  survival: { thresholdDays: 7, ceilingDays: 30, maxBonus: 0.1 },
} as const

/**
 * Obcięcie do 0–100 i zaokrąglenie do liczby całkowitej.
 *
 * `Infinity` siada na 100, `-Infinity` na 0 (tak wychodzi z log10(0) przy
 * zerowej płynności). `NaN` nie przechodzi przez min/max, więc łapiemy go
 * osobno i traktujemy jak brak danych, czyli 0.
 */
export function clampStat(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)))
}

/**
 * Cztery statystyki bojowe, każda znormalizowana do 0–100.
 *
 * Kontrola poprawności (CLAUDE.md): token AI — płynność $2,13M, obrót 24h
 * $1M (liczba wzorcowa, nie pomiar), 46 755 holderów, 56 dni:
 *  - wytrzymałość: 67 (bez zmiany)
 *  - siła: 60 (bez zmiany)
 *  - garda: 73 (bez zmiany)
 *  - szybkość: 34 (rotacja 0,47x na skali logarytmicznej; płynność powyżej
 *    $200k, więc bez tłumienia)
 */
export function computeStats(raw: RawTokenNumbers): FightStats {
  const { liquidityUsd, volume24hUsd, holders } = raw

  // Wytrzymałość: głębokość płynności. Ile ring wytrzyma, zanim się ugnie.
  const wytrzymalosc =
    ((Math.log10(liquidityUsd) - STAT_SCALE.wytrzymalosc.minLog) /
      STAT_SCALE.wytrzymalosc.decades) *
    100

  // Siła: obrót 24h — ile pieniędzy faktycznie przechodzi przez ring w ciągu doby.
  // Kapitalizacja / płynność tu nie wchodzi: to miara ryzyka, nie siły. Token bez
  // płynności dostawał przez nią maksimum i wygrywał ze zdrowym. Liczy się jako
  // podatność, patrz `computeVulnerability`.
  const sila =
    ((Math.log10(volume24hUsd) - STAT_SCALE.sila.minLog) / STAT_SCALE.sila.decades) * 100

  // Garda: rozproszenie podaży mierzone liczbą holderów.
  const garda =
    ((Math.log10(holders) - STAT_SCALE.garda.minLog) / STAT_SCALE.garda.decades) * 100

  // Szybkość: rotacja płynności (velocity), na skali logarytmicznej, potem
  // stłumiona przy cienkiej płynności. Zerowa rotacja daje log10(0) = -Infinity,
  // które `clampStat` sprowadza do 0. Sufit 100 (rotacja 10x i więcej) działa
  // PRZED mnożnikiem: obcięcie po nim pozwalałoby rotacji 33x na $50k dojść
  // z powrotem do 100, czyli dawałoby cienkiej płynności pełną premię.
  const { minVelocity, decades } = STAT_SCALE.szybkosc
  const velocity = computeVelocity(volume24hUsd, liquidityUsd)
  const velocityScore = Math.min(
    100,
    ((Math.log10(velocity) - Math.log10(minVelocity)) / decades) * 100,
  )
  const szybkosc = velocityScore * liquidityDamping(liquidityUsd)

  return {
    wytrzymalosc: clampStat(wytrzymalosc),
    sila: clampStat(sila),
    garda: clampStat(garda),
    szybkosc: clampStat(szybkosc),
  }
}

/**
 * Bonus do puli życia za przetrwanie.
 *
 * Wiek pary mierzony w dniach → wartość 0–1 (0% do 10% bonusu HP).
 * Większość tokenów umiera w pierwszych tygodniach, więc przetrwanie miesiąca
 * to sygnał jakości. Świeżość nie jest premią — młody token nie dostaje nic,
 * bez kary i bez bonusu.
 */
export function computeSurvivalBonus(ageDays: number): number {
  const { thresholdDays, ceilingDays, maxBonus } = STAT_SCALE.survival
  if (ageDays < thresholdDays) return 0
  if (ageDays >= ceilingDays) return maxBonus
  // Liniowy wzrost od progu do sufitu
  return ((ageDays - thresholdDays) / (ceilingDays - thresholdDays)) * maxBonus
}

/**
 * Rotacja płynności (velocity): obrót 24h / płynność.
 *
 * Pokazuje, ile razy dziennie płynność "obraca się". Wysoka rotacja = aktywny
 * token. Ta sama liczba, z której liczy się szybkość — może wyjść poza sufit
 * 10x, ale do statystyki wchodzi już obcięta. Wracamy surową wartość do
 * UI i snapshotu, żeby widać było, ile to naprawdę wynosi.
 */
export function computeVelocity(volume24hUsd: number, liquidityUsd: number): number {
  return liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0
}

/**
 * Mnożnik szybkości przy cienkiej płynności, 0,25–1. Patrz `STAT_SCALE.thinLiquidity`.
 *
 * Płynność od $200k w górę nie jest tłumiona (1). Poniżej mnożnik spada
 * liniowo po logarytmie płynności do 0,25 przy $1k i mniej. Płynność zerowa,
 * ujemna albo brakująca (`NaN`) dostaje dolną granicę: nie ma pod czym
 * rotować, więc też nie ma czego premiować.
 */
export function liquidityDamping(liquidityUsd: number): number {
  const { thresholdUsd, floorUsd, minDamping } = STAT_SCALE.thinLiquidity
  if (liquidityUsd >= thresholdUsd) return 1
  if (!(liquidityUsd > floorUsd)) return minDamping
  const position =
    (Math.log10(liquidityUsd) - Math.log10(floorUsd)) /
    (Math.log10(thresholdUsd) - Math.log10(floorUsd))
  return minDamping + (1 - minDamping) * position
}

/**
 * Podatność (szklana szczęka): ile papieru stoi za każdym dolarem wyjścia,
 * skala 0–100 — 1x → 0, 1000x → 100.
 *
 * To dawna „siła", odwrócona co do znaku: wysoki stosunek kapitalizacji do
 * płynności oznacza, że niewielki ruch po stronie sprzedaży przesuwa cenę
 * mocno. W symulacji zmniejsza pulę życia i zwiększa obrażenia przyjmowane,
 * a nie podnosi żadnej statystyki. Nie jest piątą statystyką bojową — tak samo
 * jak spadek od szczytu jest modyfikatorem, a kapitalizacja kategorią.
 *
 * Sztywne progi, bez odniesienia do przeciwnika. Zerowa płynność przy dodatniej
 * kapitalizacji daje `Infinity`, czyli sufit 100; brak obu liczb daje `NaN`,
 * które `clampStat` sprowadza do 0.
 */
export function computeVulnerability(
  raw: Pick<RawTokenNumbers, 'liquidityUsd' | 'marketCapUsd'>,
): number {
  return clampStat(
    (Math.log10(raw.marketCapUsd / raw.liquidityUsd) / STAT_SCALE.vulnerability.decades) * 100,
  )
}

/* ------------------------------------------------------------------ */
/* Kategorie wagowe                                                    */
/* ------------------------------------------------------------------ */

export type WeightClassId = 'musza' | 'lekka' | 'srednia' | 'polciezka' | 'ciezka'

export interface WeightClass {
  id: WeightClassId
  label: string
  /** Górna granica, wyłączna. Ostatnia kategoria nie ma sufitu. */
  maxUsd: number
  /** Pozycja na półce, 0 = najlżejsza. Do porównywania kategorii. */
  index: number
}

/**
 * Kapitalizacja nie jest statystyką bojową — wyznacza kategorię wagową.
 * Po to, żeby nie twierdzić, że token za $500 mln jest "lepszy" od tego
 * za $2 mln. To inne półki. Patrz CLAUDE.md § Kategorie wagowe.
 *
 * Progi stykają się bez dziur: granica należy do kategorii wyższej, więc
 * dokładnie $3 mln to już waga lekka.
 */
export const WEIGHT_CLASSES: readonly WeightClass[] = [
  { id: 'musza', label: 'Waga musza', maxUsd: 3_000_000, index: 0 },
  { id: 'lekka', label: 'Waga lekka', maxUsd: 20_000_000, index: 1 },
  { id: 'srednia', label: 'Waga średnia', maxUsd: 100_000_000, index: 2 },
  { id: 'polciezka', label: 'Waga półciężka', maxUsd: 500_000_000, index: 3 },
  { id: 'ciezka', label: 'Waga ciężka', maxUsd: Infinity, index: 4 },
]

/** Każda kapitalizacja wpada dokładnie w jedną kategorię. */
export function weightClass(marketCapUsd: number): WeightClass {
  const mcap = Number.isFinite(marketCapUsd) ? marketCapUsd : 0
  return WEIGHT_CLASSES.find((c) => mcap < c.maxUsd) ?? WEIGHT_CLASSES[WEIGHT_CLASSES.length - 1]
}

export interface Matchup {
  /** Czy zawodnicy są z różnych kategorii. */
  crossClass: boolean
  /** Ile półek różnicy. 0 dla walki w jednej kategorii. */
  classGap: number
  /**
   * Który zawodnik bije powyżej swojej wagi — 'a' | 'b' | null.
   * Walka między kategoriami dostaje widoczne oznaczenie (CLAUDE.md).
   */
  punchingUp: 'a' | 'b' | null
}

export function matchup(a: WeightClass, b: WeightClass): Matchup {
  const classGap = Math.abs(a.index - b.index)
  return {
    crossClass: classGap > 0,
    classGap,
    punchingUp: classGap === 0 ? null : a.index < b.index ? 'a' : 'b',
  }
}

/* ------------------------------------------------------------------ */
/* Modyfikatory z wykresu                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Wybór pary referencyjnej                                            */
/* ------------------------------------------------------------------ */

/**
 * Wszystkie pary tokena w kolejności deterministycznej: malejąco po
 * płynności, a przy równej płynności rosnąco po adresie.
 *
 * Token handluje się w kilkunastu parach i każda ma inną płynność, inny wiek
 * i inny wykres. Bez ustalonej reguły wyboru ta sama para adresów daje za
 * każdym razem inne statystyki — dla tokena AI raz parę z 22.07 i płynnością
 * $2,2M, raz tę z 03.09 i płynnością $704k. Wtedy ranking traci sens.
 *
 * Dogrywka po adresie nie jest ozdobą: bez niej dwie pary o identycznej
 * płynności zostawiają kolejność w rękach API i wybór znów nie jest
 * powtarzalny. Patrz CLAUDE.md § Determinizm.
 */
export function sortPairsByLiquidity<T extends { address: string; liquidityUsd: number }>(
  pairs: readonly T[],
): T[] {
  return [...pairs].sort(
    (x, y) => y.liquidityUsd - x.liquidityUsd || x.address.localeCompare(y.address),
  )
}

/**
 * Świece z Codexu (`getBars`). Tablice równoległe, mogą mieć dziury.
 *
 * Celowo bez maksimów (`h`). Świeca z dnia startu pary ma maksimum liczone
 * przy puli pustej z jednej strony, więc wychodzą z tego liczby bez sensu —
 * dla tokena AI `h` pierwszego dnia to 6,6e+41 przy otwarciu 0,0118. Taki
 * szczyt dawałby spadek 100% każdemu świeżo wystartowanemu tokenowi.
 * Zamknięcie świecy to cena, w którą ktoś faktycznie mógł wyjść.
 */
export interface Bars {
  /** Zamknięcia. */
  c: (number | null)[]
  /** Znaczniki czasu w sekundach. */
  t: number[]
}

/** Świeca po odsianiu dziur. */
interface SeriesPoint {
  t: number
  c: number
}

/**
 * Dziury w świecach są normalne dla cienkich par — liczymy tylko na tym, co
 * faktycznie przyszło. Zamknięcia niedodatnie odpadają: log(0) i dzielenie
 * przez nie nie mają sensu, a i tak nie są ceną.
 */
function toPoints(bars: Bars | null): SeriesPoint[] {
  if (!bars?.t?.length) return []
  const points: SeriesPoint[] = []
  for (let i = 0; i < bars.t.length; i++) {
    const c = bars.c[i]
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      points.push({ t: bars.t[i], c })
    }
  }
  return points
}

/**
 * Zmiana ceny względem świecy najbliższej `seconds` wstecz.
 *
 * Kotwica szukana po znaczniku czasu, nie po indeksie — przy dziurach
 * w świecach indeks kłamie. Dla pary młodszej niż okno bierzemy najstarszą
 * świecę jaką mamy i zwracamy, ile dni to faktycznie objęło; bez tego
 * „zmiana 7d" dla trzydniowej pary udawałaby tydzień.
 */
function changeOver(
  points: SeriesPoint[],
  seconds: number,
): { change: number; windowDays: number } | null {
  if (points.length < 2) return null
  const last = points[points.length - 1]
  const cutoff = last.t - seconds

  let anchor: SeriesPoint | null = null
  for (const p of points) {
    if (p.t <= cutoff && (anchor === null || p.t > anchor.t)) anchor = p
  }
  // Brak świecy starszej niż okno: najstarsza jaka jest.
  if (anchor === null) anchor = points[0]
  if (anchor.t === last.t || anchor.c <= 0) return null

  return {
    change: round4((last.c - anchor.c) / anchor.c),
    windowDays: round4((last.t - anchor.t) / 86_400),
  }
}

export interface ChartModifiers {
  /** Zmiana ceny jako część całości: -0,0221 to -2,21%. */
  priceChange1h: number | null
  priceChange24h: number | null
  priceChange7d: number | null
  /** Ile dni faktycznie objęło okno 7d — krótsze dla młodej pary. */
  priceChange7dWindowDays: number | null
  /** Najwyższe zamknięcie dnia w oknie świec, czyli od powstania pary. */
  peakCloseUsd: number | null
  peakAt: number | null
  /** Spadek od szczytu zamknięć, 0–1. Token daleko od szczytu wchodzi poobijany. */
  drawdownFromPeakClose: number | null
  /** Odchylenie standardowe dziennych zwrotów logarytmicznych, w skali roku. */
  volatility: number | null
  /** Na ilu dziennych zwrotach policzono zmienność. */
  volatilityBasisDays: number
  /** Ile świec dziennych weszło do rachunku — bez tego nie da się tego sprawdzić. */
  barCount: number
  /** Ile dni objęło okno świec dziennych. */
  windowDays: number | null
}

/**
 * Modyfikatory liczone arytmetycznie ze świec wybranej pary.
 *
 * Model językowy nie analizuje wykresu — dostaje te liczby i je opisuje.
 * Nie ocenia trendu, nie prognozuje ceny. Patrz CLAUDE.md § Modyfikatory
 * z wykresu i § Czego nie robić.
 *
 * Zwracane są surowe wielkości, nie skala 0–100: sztywne progi CLAUDE.md
 * dotyczą czterech statystyk bojowych, nie modyfikatorów.
 *
 * Oba zestawy świec muszą pochodzić z tej samej pary co statystyki, inaczej
 * jedna odpowiedź opisuje dwie różne pary.
 */
export function computeChartModifiers(daily: Bars | null, hourly: Bars | null): ChartModifiers {
  const dailyPoints = toPoints(daily)
  const hourlyPoints = toPoints(hourly)

  // Okna 1h i 24h ze świec godzinowych: dzienne nie mają takiej rozdzielczości.
  const h1 = changeOver(hourlyPoints, 3_600)
  const h24 = changeOver(hourlyPoints, 24 * 3_600)
  const d7 = changeOver(dailyPoints, 7 * 86_400)

  const base: ChartModifiers = {
    priceChange1h: h1?.change ?? null,
    priceChange24h: h24?.change ?? null,
    priceChange7d: d7?.change ?? null,
    priceChange7dWindowDays: d7?.windowDays ?? null,
    peakCloseUsd: null,
    peakAt: null,
    drawdownFromPeakClose: null,
    volatility: null,
    volatilityBasisDays: 0,
    barCount: dailyPoints.length,
    windowDays: null,
  }
  if (dailyPoints.length === 0) return base

  const last = dailyPoints[dailyPoints.length - 1]

  // Szczyt od powstania pary i spadek od niego — na zamknięciach, nie na
  // maksimach; powód w komentarzu przy `Bars`.
  let peak = dailyPoints[0]
  for (const p of dailyPoints) if (p.c > peak.c) peak = p
  const drawdown = peak.c > 0 ? Math.max(0, (peak.c - last.c) / peak.c) : null

  // Zmienność: odchylenie standardowe dziennych zwrotów logarytmicznych,
  // przeskalowane do roku. Wysoka oznacza mocniejsze, ale mniej celne ciosy.
  const returns: number[] = []
  for (let i = 1; i < dailyPoints.length; i++) {
    returns.push(Math.log(dailyPoints[i].c / dailyPoints[i - 1].c))
  }
  let volatility: number | null = null
  if (returns.length >= 2) {
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
    // Wariancja próbkowa (n-1): mamy próbkę historii, nie całą populację.
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)
    volatility = round4(Math.sqrt(variance) * Math.sqrt(365))
  }

  return {
    ...base,
    peakCloseUsd: peak.c,
    peakAt: peak.t,
    drawdownFromPeakClose: drawdown === null ? null : round4(drawdown),
    volatility,
    volatilityBasisDays: returns.length,
    windowDays: round4((last.t - dailyPoints[0].t) / 86_400),
  }
}

/** Ostatnie zamknięcie świecy godzinowej wybranej pary — cena ze snapshotu. */
export function latestClose(hourly: Bars | null): number | null {
  const points = toPoints(hourly)
  return points.length ? points[points.length - 1].c : null
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
