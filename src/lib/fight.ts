/**
 * Symulacja walki: trzy rundy, deterministycznie.
 *
 * Wynik liczy wyłącznie ten plik, na podstawie statystyk i modyfikatorów
 * policzonych z danych on-chain. Model językowy nigdy nie widzi, kto wygrał,
 * i nigdy nie wpływa na wynik — dostaje gotowy rezultat i ubiera go w słowa.
 * Sędzia i komentatorzy ogłaszają to, co tu wyszło. Patrz CLAUDE.md
 * § Zasada nadrzędna i § Sędzia.
 *
 * Zero `Math.random()`. Cała losowość idzie z ziarna policzonego z dwóch
 * adresów, więc ta sama para adresów przy tym samym snapshocie daje
 * bit w bit ten sam przebieg.
 */
import type { ConcentrationVerdict } from './concentration'
import type { HolderGate } from './holder-gate'
import type { ChartModifiers, FightStats } from './stats'

/** Trzy rundy — patrz CLAUDE.md § Sędzia. */
export const ROUNDS = 3

/** Strona w kolejności, w jakiej przyszły adresy do API. */
export type Side = 'a' | 'b'

export interface FighterInput {
  address: string
  symbol: string
  stats: FightStats
  modifiers: ChartModifiers
  /**
   * Podatność 0–100: kapitalizacja / płynność (szklana szczęka). Zmniejsza
   * pulę życia i zwiększa obrażenia przyjmowane. Nie jest statystyką bojową.
   */
  vulnerability: number
  /**
   * Bramka na liczbie holderów. Nie przeszła — walkower, bez względu na
   * statystyki. Działa na darmowym planie Codexu.
   */
  holderGate: HolderGate
  /**
   * Pasmo koncentracji podaży, policzone po odsianiu adresów niebędących
   * holderami. `enforced: false` znaczy, że odsiewu nie dało się zrobić —
   * wtedy koncentracja nie wpływa na walkę (patrz `concentration.ts`).
   */
  concentration: ConcentrationVerdict
}

/* ------------------------------------------------------------------ */
/* Ziarno i generator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Klucz ziarna: oba adresy małymi literami, **posortowane**, sklejone.
 *
 * Sortowanie jest tu istotne. Bez niego „AI vs WETH" i „WETH vs AI" to dwie
 * różne walki o dwóch różnych wynikach, a skoro wynik idzie do rankingu, to
 * wystarczyłoby wpisać adresy w odwrotnej kolejności, żeby dostać drugie
 * losowanie i wybrać z nich korzystniejsze. Walka jest własnością **pary**
 * kontraktów, nie kolejności wpisania.
 */
export function seedKey(addressA: string, addressB: string): string {
  return [addressA.toLowerCase(), addressB.toLowerCase()].sort().join('|')
}

/**
 * xmur3 — rozbija łańcuch na 32-bitowe ziarna. Same operacje całkowite
 * (`Math.imul`, przesunięcia), więc wynik jest identyczny w każdym silniku.
 */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

/** sfc32 — strumień [0,1). Też wyłącznie arytmetyka całkowita. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

/** Generator z klucza ziarna, razem z ziarnem w hexie do wpisania w wynik. */
export function seededRandom(key: string): { next: () => number; seed: string } {
  const h = xmur3(key)
  const s = [h(), h(), h(), h()] as const
  return {
    next: sfc32(s[0], s[1], s[2], s[3]),
    seed: s.map((n) => n.toString(16).padStart(8, '0')).join(''),
  }
}

/* ------------------------------------------------------------------ */
/* Statystyki na parametry bojowe                                      */
/* ------------------------------------------------------------------ */

/**
 * Stałe balansu w jednym miejscu, bo to jedyna część symulacji, która jest
 * strojona, a nie wyprowadzona z danych.
 *
 * Dwie zasady, obie wyszły z pomiarów:
 *
 * 1. Każda statystyka ma **jedną** dźwignię. Gdy szybkość dawała i tempo,
 *    i celność, sama decydowała o 98% walk; garda liczona i jako unik,
 *    i jako pochłanianie obrażeń robiła to samo.
 * 2. Oczekiwane obrażenia z trzech rund muszą być **poniżej** typowej puli
 *    życia, inaczej połowa walk kończy się nokautem w drugiej rundzie
 *    i trzecia runda przestaje istnieć.
 *
 * Kontrola po zmianie: nokaut w ~1 na 6 walk, każda statystyka w przedziale
 * 60–75% skuteczności w pojedynku 80 vs 20, faworyt wygrywa ~70%. Sprawdza
 * to `npm run verify:fight`.
 */
const BALANCE = {
  /**
   * Pula życia: wytrzymałość 0 → 180, 100 → 280.
   *
   * Było 150. Podatność zabiera życie i podbija przyjmowane obrażenia, a token
   * z realnym stosunkiem kapitalizacji do płynności ma ją zwykle w środku skali,
   * więc średnio każdy zawodnik jest teraz słabszy o kilkanaście procent.
   * Przy 150 nokauty skakały z 14% do 35% walk, a nokdauny z 27% do 45%.
   * 180 przywraca rozkład sprzed podatności (nokaut 14,0%, nokdaun 28,3%,
   * TKO 1,5% na 1500 par z losową podatnością) i prawie nie rusza względnej
   * wagi wytrzymałości: 82% → 80% w pojedynku 80 vs 20.
   */
  hpBase: 180,
  /** Spadek od szczytu zabiera najwyżej czwartą część życia. */
  drawdownHpPenalty: 0.25,
  /** Ciosy na rundę: szybkość 0 → 8, 100 → 16. */
  tempoBase: 8,
  tempoFromSpeed: 8,
  /**
   * Celność jest wspólna i schodzi tylko od zmienności. Nie zależy od
   * szybkości — ta rządzi tempem — ani od gardy przeciwnika.
   */
  accuracyBase: 0.45,
  accuracyVolatilityPenalty: 0.15,
  /**
   * Obrażenia trafionego ciosu: siła 0 → 6, 100 → 12.
   *
   * Rozstrzał celowo wąski. Przy 4–14 siła miała 3,5× rozrzutu, najwięcej
   * ze wszystkich dźwigni, i sama decydowała o 98% walk.
   */
  powerBase: 6,
  powerFromStrength: 6,
  /** Garda pochłania do 30% obrażeń. */
  guardSoakMax: 0.3,
  /** Widełki obrażeń: zmienność rozszerza je w obie strony, nie podnosi średniej. */
  damageSpreadBase: 0.25,
  damageSpreadFromVolatility: 0.75,
  /** Zmiana 24h jako modyfikator obrażeń — najwyżej ±10%. */
  momentumFrom24h: 0.2,
  /**
   * Koncentracja w pasmie 30–50% zabiera do piątej części puli życia.
   *
   * Kara wchodzi tu, a nie do samej statystyki wytrzymałości, i to z dwóch
   * powodów. Wytrzymałość jest zdefiniowana w CLAUDE.md jako funkcja samej
   * płynności i musi taka zostać, inaczej kontrola poprawności (AI → 67)
   * przestaje cokolwiek sprawdzać. A pula życia to jedyna dźwignia
   * wytrzymałości, więc odjęcie od niej **jest** karą do wytrzymałości.
   * Obok stoi kara za spadek od szczytu, która działa dokładnie tak samo.
   */
  concentrationHpPenalty: 0.2,
  /**
   * Podatność (kapitalizacja / płynność) 100 zabiera 15% puli życia i dodaje
   * 15% do przyjmowanych obrażeń.
   *
   * Dwie dźwignie, a nie jedna, bo tak brzmi definicja: mało płynności pod
   * dużą kapitalizacją to i mniej miejsca na przyjęcie ciosów, i mocniejszy
   * skutek każdego z nich. Obie liczone od tej samej liczby, więc jedna
   * statystyka nadal ma jedno źródło — zmieniają się tylko dwa wyjścia.
   * Wartości dobrane pomiarem: w pojedynku podatność 20 vs 80 daje 70% dla
   * mniej podatnego, czyli tyle co garda (75%) i mniej niż siła (90%). To ma
   * być modyfikator, nie piąta dźwignia — patrz `npm run verify:fight`.
   */
  vulnerabilityHpPenalty: 0.15,
  vulnerabilityDamageTaken: 0.15,
  /**
   * Co znaczy „ciężki cios": górna połowa widełek atakującego, czyli górna
   * ćwiartka wszystkich jego trafień. Jedna definicja dla nokdaunu i dla
   * szklanej szczęki.
   *
   * Ciężar mierzymy tym, co atakujący wyprowadził, a nie udziałem w puli
   * życia obrońcy. Poprzedni próg — obrażenia ≥ 10% puli życia — był
   * nieosiągalny: zmierzone, najcięższy możliwy cios to 3,5–5,4% puli
   * obrońcy (12% dopiero przy sile 100 przeciw zerowej wytrzymałości
   * i zerowej gardzie). Nokdauny i TKO były przez to martwym kodem.
   *
   * Udział w puli życia jest złą miarą ciężaru jeszcze z jednego powodu:
   * zależy od obrońcy, więc ten sam cios byłby „ciężki" wobec jednego
   * przeciwnika i lekki wobec drugiego. Widełki są symetryczne, więc
   * `1 + spread/2` to górna ćwiartka trafień w każdym pojedynku.
   */
  heavyPunchSwing: 0.5,
  /**
   * Nokdaun wymaga dwóch rzeczy naraz: ciężkiego ciosu i przeciwnika, który
   * jest już poobijany — pula życia poniżej tego udziału wyjściowej.
   *
   * Sam ciężar ciosu nie wystarczy jako warunek. Trafień w walce jest 32,6,
   * więc górna ćwiartka to około ośmiu ciężkich ciosów na walkę i nokdaun
   * padałby praktycznie zawsze. Żeby padał w 20–30% walk z samego ciężaru,
   * „ciężki" musiałby znaczyć górne 0,9% trafień — a to już nie jest ciężki
   * cios, tylko loteria na czwartym miejscu po przecinku.
   *
   * Druga bramka jest też trafniejsza bokserski: na deski nie idzie się od
   * jednego dobrego ciosu w pełni sił, tylko od dobrego ciosu w kogoś, kto
   * już stoi na miękkich nogach.
   *
   * Wartość dobrana pomiarem na 1000 par, nie z wyczucia (tabela poniżej jest
   * sprzed podatności; po jej dodaniu 0,25 nadal daje 28,3% — patrz `hpBase`).
   * Próg przekłada się
   * na odsetek walk z nokdaunem monotonicznie i ostro:
   *
   *     0,10 →  8,6% walk (TKO 0,0%)     0,25 → 27,0% walk (TKO 1,8%)
   *     0,15 → 13,6% walk (TKO 0,2%)     0,30 → 35,7% walk (TKO 3,1%)
   *     0,20 → 20,0% walk (TKO 0,8%)     0,45 → 60,2% walk (TKO 8,7%)
   *
   * 0,25 trafia w środek przedziału 20–30% i zostawia TKO na 1,8%, czyli
   * około co 55. walka. Sprawdza to `npm run verify:fight`, a pełny rozkład
   * pokazuje `npm run check:balance`.
   */
  knockdownHurtShare: 0.25,
  /** 300% zmienności rocznej to sufit skali. */
  volatilityCeiling: 3,
} as const

/**
 * Krok kwantyzacji modyfikatorów wchodzących do symulacji.
 *
 * Cztery statystyki są zaokrąglane do liczb całkowitych 0–100 właśnie po to,
 * żeby drobny ruch płynności nie zmieniał wyniku. Modyfikatory wchodziły tu
 * jako surowe floaty ze świec i psuły to: dwa wywołania pod rząd dawały tego
 * samego zwycięzcę i tę samą kartę, ale **każdy cios miał inne obrażenia**,
 * bo zmienność ruszyła się na czwartym miejscu po przecinku. Animacja
 * wyglądała wtedy za każdym razem inaczej przy niezmienionym wyniku.
 *
 * Po zaokrągleniu do dwóch miejsc walka jest identyczna co do ciosu, dopóki
 * modyfikator nie zmieni się na tyle, żeby to naprawdę coś znaczyło.
 */
const MODIFIER_STEP = 100

const quantize = (n: number) => Math.round(n * MODIFIER_STEP) / MODIFIER_STEP

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const clamp01 = (n: number) => clamp(n, 0, 1)
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Cztery statystyki i modyfikatory przeliczone na parametry ringowe.
 *
 * Każdy próg jest sztywny i nie zależy od przeciwnika — tak samo jak same
 * statystyki. Jedna statystyka, jedna dźwignia:
 *
 * - wytrzymałość (płynność) → pula punktów życia
 * - siła (obrót 24h) → obrażenia trafionego ciosu
 * - garda (holderzy) → pochłanianie przyjmowanych obrażeń
 * - szybkość (świeżość pary) → tempo, czyli liczba ciosów w rundzie
 *
 * Podatność (kapitalizacja / płynność) nie jest statystyką, więc nie ma tu
 * „swojej" dźwigni: zabiera część puli życia i podbija przyjmowane obrażenia.
 *
 * Modyfikatory z wykresu:
 *
 * - spadek od szczytu → wchodzi do ringu poobijany, mniej punktów życia
 * - zmienność → mocniejsze, ale mniej celne ciosy (CLAUDE.md)
 * - zmiana 24h → drobny modyfikator obrażeń
 */
export interface CombatProfile {
  hpStart: number
  tempo: number
  accuracy: number
  power: number
  guardSoak: number
  /** Mnożnik przyjmowanych obrażeń z podatności: 1 przy zerowej, do 1,25. */
  damageTaken: number
  damageSpread: number
  momentum: number
  /**
   * Poniżej tej puli życia zawodnik jest poobijany i ciężki cios kładzie go
   * na deski. Własność obrońcy.
   */
  hurtThreshold: number
  /**
   * Od jakiego mnożnika widełek cios jest „ciężki" — do nokdaunu i do
   * szklanej szczęki. Własność atakującego, nie obrońcy.
   */
  heavySwing: number
}

export function combatProfile(fighter: FighterInput): CombatProfile {
  const { wytrzymalosc, sila, garda, szybkosc } = fighter.stats
  const { volatility, drawdownFromPeakClose, priceChange24h } = fighter.modifiers
  // Kara tylko z pasma wymierzonego na liczbie odsianej. Bez odsiewu
  // `staminaPenalty` jest zerem i pula życia zostaje nietknięta.
  const concentrationPenalty = fighter.concentration.enforced
    ? clamp01(fighter.concentration.staminaPenalty)
    : 0

  // Kwantyzacja przed jakimkolwiek rachunkiem — patrz `MODIFIER_STEP`.
  const volNorm = quantize(clamp01((volatility ?? 0) / BALANCE.volatilityCeiling))
  const drawdown = quantize(clamp01(drawdownFromPeakClose ?? 0))
  const change24h = quantize(clamp(priceChange24h ?? 0, -0.5, 0.5))

  // Podatność jest już liczbą całkowitą 0–100 (`clampStat`), więc drgania
  // płynności między zapytaniami przechodzą przez nią tak samo jak przez
  // statystyki — nie trzeba jej kwantyzować drugi raz.
  const vulnerability = clamp01(fighter.vulnerability / 100)

  const hpStart =
    (BALANCE.hpBase + wytrzymalosc) *
    (1 - BALANCE.drawdownHpPenalty * drawdown) *
    (1 - BALANCE.concentrationHpPenalty * concentrationPenalty) *
    (1 - BALANCE.vulnerabilityHpPenalty * vulnerability)

  return {
    hpStart,
    tempo: BALANCE.tempoBase + Math.round((szybkosc / 100) * BALANCE.tempoFromSpeed),
    accuracy: BALANCE.accuracyBase * (1 - BALANCE.accuracyVolatilityPenalty * volNorm),
    power: BALANCE.powerBase + (sila / 100) * BALANCE.powerFromStrength,
    guardSoak: 1 - (garda / 100) * BALANCE.guardSoakMax,
    damageTaken: 1 + vulnerability * BALANCE.vulnerabilityDamageTaken,
    damageSpread:
      BALANCE.damageSpreadBase + BALANCE.damageSpreadFromVolatility * volNorm,
    momentum: 1 + change24h * BALANCE.momentumFrom24h,
    hurtThreshold: BALANCE.knockdownHurtShare * hpStart,
    heavySwing:
      1 +
      (BALANCE.damageSpreadBase + BALANCE.damageSpreadFromVolatility * volNorm) *
        BALANCE.heavyPunchSwing,
  }
}

/* ------------------------------------------------------------------ */
/* Przebieg walki                                                      */
/* ------------------------------------------------------------------ */

/** Dlaczego zawodnik nie przeszedł badań. */
export type MedicalFailure = 'holders' | 'concentration'

export type FightEvent =
  /**
   * Badania przed walką: zawodnik nie wchodzi do ringu. Nie ma tu losowania —
   * wynik wyszedł z liczby. Dwa powody: mniej holderów niż próg (`holders`)
   * albo koncentracja podaży od 70% w górę (`concentration`).
   */
  | { type: 'medicalsFailed'; fighter: Side; reason: 'holders'; holders: number; minHolders: number }
  | { type: 'medicalsFailed'; fighter: Side; reason: 'concentration'; concentrationPercent: number }
  /** Obaj oblali badania — nie ma z kim walczyć, walka odwołana. */
  | { type: 'fightCancelled'; reasons: Record<Side, MedicalFailure> }
  /** Jeden oblał, drugi bierze walkower. */
  | { type: 'walkover'; winner: Side; loser: Side }
  /** Sędzia daje instrukcje przed pierwszą rundą. */
  | { type: 'instructions' }
  | { type: 'roundStart'; round: number }
  | {
      type: 'punch'
      round: number
      attacker: Side
      landed: boolean
      damage: number
      defenderHp: number
    }
  /**
   * Liczone do ośmiu i wstaje. Odliczanie jest animacją, nie losowaniem —
   * o tym, czy wstał, zdecydowała już symulacja.
   */
  | { type: 'knockdown'; round: number; fighter: Side; countTo: 8 }
  | { type: 'roundEnd'; round: number; score: Record<Side, number>; damage: Record<Side, number> }
  /**
   * Szklana szczęka: koncentracja w pasmie 50–70% i pierwszy ciężki cios
   * kładzie zawodnika w pierwszej rundzie. Warunkiem jest cios — jeśli
   * w pierwszej rundzie żaden nie wejdzie ciężko, walka toczy się dalej.
   */
  | { type: 'glassJaw'; round: number; fighter: Side; concentrationPercent: number }
  /** Nokaut: odliczanie zawsze dochodzi do dziesięciu (CLAUDE.md § Sędzia). */
  | { type: 'knockout'; round: number; winner: Side; countTo: 10 }
  | { type: 'technicalKnockout'; round: number; winner: Side; knockdowns: number }
  | { type: 'decision'; winner: Side | null; scorecard: Record<Side, number> }

export interface RoundResult {
  round: number
  score: Record<Side, number>
  damage: Record<Side, number>
  knockdowns: Record<Side, number>
  hpAfter: Record<Side, number>
}

/**
 * `walkover` — przeciwnik nie przeszedł badań, walki nie było.
 * `cancelled` — obaj nie przeszli; nie ma zwycięzcy i nie ma czego zapisać.
 */
export type FightMethod = 'KO' | 'TKO' | 'decision' | 'draw' | 'walkover' | 'cancelled'

export interface FightResult {
  /** Ziarno w hexie — z nim i ze snapshotem walkę da się odtworzyć. */
  seed: string
  /** Co dokładnie zahashowano. */
  seedKey: string
  /**
   * Wyjściowa pula życia każdej strony.
   *
   * Wyłącznie do rysowania pasków życia na froncie: zdarzenie `punch` podaje
   * `defenderHp` w punktach, a bez puli wyjściowej nie da się z tego zrobić
   * procentu. Front nie liczy tego sam — drugi rachunek tego samego to drugie
   * miejsce, w którym może się rozjechać z symulacją. Na wynik nie wpływa.
   */
  hpStart: Record<Side, number>
  rounds: RoundResult[]
  /** `null` tylko przy remisie. */
  winner: Side | null
  method: FightMethod
  /** Runda, w której padł nokaut; `null` przy wyniku na punkty. */
  endedInRound: number | null
  scorecard: Record<Side, number>
  damageDealt: Record<Side, number>
  /**
   * Wynik badań obu stron — pasmo koncentracji i kara, którą z niego
   * wymierzono. Bez tego nie widać, czemu zawodnik miał mniejszą pulę życia
   * albo czemu w ogóle nie wszedł do ringu.
   */
  medicals: Record<Side, ConcentrationVerdict>
  /** Wynik bramki na holderach obu stron — z liczbą, z której wyszedł. */
  holderGates: Record<Side, HolderGate>
  events: FightEvent[]
}

/** Trzy nokdauny w jednej rundzie kończą walkę — zwykła zasada boksu. */
const KNOCKDOWNS_FOR_TKO = 3

/**
 * Kolejność ciosów w rundzie bez udziału losowości.
 *
 * Każdy zawodnik ma swoje tempo, więc rozkładamy jego ciosy równomiernie
 * po rundzie i scalamy obie serie po pozycji. Szybszy wchodzi częściej,
 * ale nie dostaje wszystkich nadwyżkowych ciosów na końcu rundy.
 */
function punchOrder(tempo0: number, tempo1: number): (0 | 1)[] {
  const slots: { who: 0 | 1; at: number }[] = []
  for (let i = 0; i < tempo0; i++) slots.push({ who: 0, at: (i + 0.5) / tempo0 })
  for (let i = 0; i < tempo1; i++) slots.push({ who: 1, at: (i + 0.5) / tempo1 })
  slots.sort((x, y) => x.at - y.at || x.who - y.who)
  return slots.map((s) => s.who)
}

/**
 * Rozgrywa walkę.
 *
 * Zawodnicy są wewnętrznie ustawiani w kolejności kanonicznej (rosnąco po
 * adresie), żeby przebieg nie zależał od tego, który adres wpisano pierwszy.
 * Na wyjściu wszystko jest przetłumaczone z powrotem na `a` i `b` z wywołania.
 */
export function simulateFight(fighterA: FighterInput, fighterB: FighterInput): FightResult {
  const key = seedKey(fighterA.address, fighterB.address)
  const { next, seed } = seededRandom(key)

  // Kolejność kanoniczna: indeks 0 to mniejszy adres.
  const aIsFirst = fighterA.address.toLowerCase() <= fighterB.address.toLowerCase()
  const fighters: readonly [FighterInput, FighterInput] = aIsFirst
    ? [fighterA, fighterB]
    : [fighterB, fighterA]
  /** Indeks wewnętrzny → strona z wywołania. */
  const side = (i: 0 | 1): Side => (aIsFirst ? (i === 0 ? 'a' : 'b') : i === 0 ? 'b' : 'a')

  const profiles = [combatProfile(fighters[0]), combatProfile(fighters[1])] as const
  const hp = [profiles[0].hpStart, profiles[1].hpStart]
  const totalDamage = [0, 0]
  const scorecard = [0, 0]

  const bySide = <T,>(values: readonly [T, T]): Record<Side, T> =>
    ({ [side(0)]: values[0], [side(1)]: values[1] }) as Record<Side, T>

  const medicals = bySide([fighters[0].concentration, fighters[1].concentration])
  const holderGates = bySide([fighters[0].holderGate, fighters[1].holderGate])

  // Badania przed pierwszym dzwonkiem. Zawodnik, który ich nie przejdzie, nie
  // wchodzi do ringu — nie ma tu ani losowania, ani wyboru, tylko liczba:
  //
  //  1. Liczba holderów poniżej progu. Działa zawsze, bo Codex podaje ją za
  //     darmo. Sprawdzana pierwsza: to twardsza bramka, bo nie zależy od planu.
  //  2. Koncentracja podaży od 70% w górę, policzona na saldach po odsiewie.
  //     Bez odsiewu pasmo jest `clear` i ta bramka przepuszcza (`concentration.ts`).
  //
  // Zawodnik z obiema wadami dostaje pierwszą z nich — jeden powód na osobę.
  const failure = (f: FighterInput): MedicalFailure | null => {
    if (!f.holderGate.passed) return 'holders'
    if (f.concentration.enforced && f.concentration.band === 'failed') return 'concentration'
    return null
  }
  const failures = [failure(fighters[0]), failure(fighters[1])] as const

  if (failures[0] || failures[1]) {
    return noContest({
      failures,
      fighters,
      profiles,
      side,
      bySide,
      medicals,
      holderGates,
      seed,
      seedKey: key,
    })
  }

  const events: FightEvent[] = [{ type: 'instructions' }]
  const rounds: RoundResult[] = []

  // Szklana szczęka: pasmo 50–70%. Kładzie tylko w pierwszej rundzie i tylko
  // po ciosie, który sam w sobie starczyłby na nokdaun.
  const glassJaw = [
    fighters[0].concentration.enforced && fighters[0].concentration.band === 'glassJaw',
    fighters[1].concentration.enforced && fighters[1].concentration.band === 'glassJaw',
  ] as const

  let stopped: { winnerIndex: 0 | 1; round: number; method: 'KO' | 'TKO'; knockdowns: number } | null =
    null

  for (let round = 1; round <= ROUNDS && !stopped; round++) {
    events.push({ type: 'roundStart', round })

    const roundDamage = [0, 0]
    const knockdowns = [0, 0]

    for (const attacker of punchOrder(profiles[0].tempo, profiles[1].tempo)) {
      const defender = (attacker === 0 ? 1 : 0) as 0 | 1
      const att = profiles[attacker]
      const def = profiles[defender]

      const landed = next() < att.accuracy

      let damage = 0
      let swing = 0
      if (landed) {
        // Zmienność rozszerza widełki w obie strony, nie podnosi średniej.
        swing = 1 + (next() * 2 - 1) * att.damageSpread
        damage = Math.max(
          0.5,
          att.power * swing * def.guardSoak * def.damageTaken * att.momentum,
        )
        hp[defender] -= damage
        roundDamage[attacker] += damage
        totalDamage[attacker] += damage
      }

      // Szklana szczęka rozstrzyga się przed zwykłym sprawdzeniem puli życia,
      // bo pula może być jeszcze pełna — o nokaucie decyduje ciężar ciosu,
      // nie to, ile życia zostało.
      const glassJawKo = landed && round === 1 && glassJaw[defender] && swing >= att.heavySwing
      if (glassJawKo) hp[defender] = 0

      events.push({
        type: 'punch',
        round,
        attacker: side(attacker),
        landed,
        damage: round2(damage),
        defenderHp: round2(Math.max(0, hp[defender])),
      })

      if (glassJawKo) {
        stopped = { winnerIndex: attacker, round, method: 'KO', knockdowns: knockdowns[defender] }
        events.push({
          type: 'glassJaw',
          round,
          fighter: side(defender),
          concentrationPercent: fighters[defender].concentration.percent ?? 0,
        })
        events.push({ type: 'knockout', round, winner: side(attacker), countTo: 10 })
        break
      }

      if (hp[defender] <= 0) {
        stopped = { winnerIndex: attacker, round, method: 'KO', knockdowns: knockdowns[defender] }
        events.push({ type: 'knockout', round, winner: side(attacker), countTo: 10 })
        break
      }

      // Nokdaun: ciężki cios w kogoś, kto jest już poobijany. Oba warunki
      // deterministyczne — ciężar z ziarna, pula życia z przebiegu walki.
      if (landed && swing >= att.heavySwing && hp[defender] < def.hurtThreshold) {
        knockdowns[defender]++
        if (knockdowns[defender] >= KNOCKDOWNS_FOR_TKO) {
          stopped = {
            winnerIndex: attacker,
            round,
            method: 'TKO',
            knockdowns: knockdowns[defender],
          }
          events.push({
            type: 'technicalKnockout',
            round,
            winner: side(attacker),
            knockdowns: knockdowns[defender],
          })
          break
        }
        events.push({ type: 'knockdown', round, fighter: side(defender), countTo: 8 })
      }
    }

    // Punktacja rundy w systemie „10 punktów musi": rundę bierze ten, kto
    // bardziej nadszarpnął przeciwnika, a za każdy nokdaun schodzi punkt.
    //
    // Liczy się **udział** w puli życia przeciwnika, nie same obrażenia.
    // Inaczej wytrzymałość nie miała żadnego wpływu na wynik na punkty —
    // większa pula chroniła tylko przed nokautem, a karta jej nie widziała.
    // Zabrać komuś 30 ze 180 to nie to samo co 30 z 280.
    const share = [roundDamage[0] / profiles[1].hpStart, roundDamage[1] / profiles[0].hpStart]

    const score = [10, 10]
    if (share[0] > share[1]) score[1] = 9
    else if (share[1] > share[0]) score[0] = 9
    score[0] = Math.max(6, score[0] - knockdowns[0])
    score[1] = Math.max(6, score[1] - knockdowns[1])
    scorecard[0] += score[0]
    scorecard[1] += score[1]

    const result: RoundResult = {
      round,
      score: bySide([score[0], score[1]]),
      damage: bySide([round2(roundDamage[0]), round2(roundDamage[1])]),
      knockdowns: bySide([knockdowns[0], knockdowns[1]]),
      hpAfter: bySide([round2(Math.max(0, hp[0])), round2(Math.max(0, hp[1]))]),
    }
    rounds.push(result)
    events.push({ type: 'roundEnd', round, score: result.score, damage: result.damage })
  }

  let winnerIndex: 0 | 1 | null = null
  let method: FightMethod

  if (stopped) {
    winnerIndex = stopped.winnerIndex
    method = stopped.method
  } else if (scorecard[0] !== scorecard[1]) {
    winnerIndex = scorecard[0] > scorecard[1] ? 0 : 1
    method = 'decision'
  } else {
    // Równa karta: rozstrzyga ten sam miernik co karta, czyli udział
    // w puli życia przeciwnika — nie surowe obrażenia.
    const shareA = totalDamage[0] / profiles[1].hpStart
    const shareB = totalDamage[1] / profiles[0].hpStart
    if (shareA !== shareB) {
      winnerIndex = shareA > shareB ? 0 : 1
      method = 'decision'
    } else {
      method = 'draw'
    }
  }

  if (!stopped) {
    events.push({
      type: 'decision',
      winner: winnerIndex === null ? null : side(winnerIndex),
      scorecard: bySide([scorecard[0], scorecard[1]]),
    })
  }

  return {
    seed,
    seedKey: key,
    hpStart: bySide([round2(profiles[0].hpStart), round2(profiles[1].hpStart)]),
    rounds,
    winner: winnerIndex === null ? null : side(winnerIndex),
    method,
    endedInRound: stopped?.round ?? null,
    scorecard: bySide([scorecard[0], scorecard[1]]),
    damageDealt: bySide([round2(totalDamage[0]), round2(totalDamage[1])]),
    medicals,
    holderGates,
    events,
  }
}

/**
 * Wynik walki, której nie było: walkower albo odwołanie.
 *
 * Zawodnik nie wchodzi do ringu, gdy ma mniej holderów niż próg albo gdy
 * dziesięć portfeli — już po odsianiu pul płynności, adresu spalania i
 * kontraktu tokena — trzyma ponad dwie trzecie podaży dostępnej holderom.
 * Gdy oblali obaj, nie ma z kim walczyć i nie ma zwycięzcy.
 *
 * Karta jest pusta, nie wyzerowana „na korzyść" kogokolwiek: walkower to brak
 * walki, a nie wygrana 30–27. Pula życia jest wyliczona i podana mimo tego,
 * bo front rysuje z niej paski jeszcze przed pierwszym dzwonkiem.
 */
function noContest(input: {
  failures: readonly [MedicalFailure | null, MedicalFailure | null]
  fighters: readonly [FighterInput, FighterInput]
  profiles: readonly [CombatProfile, CombatProfile]
  side: (i: 0 | 1) => Side
  bySide: <T>(values: readonly [T, T]) => Record<Side, T>
  medicals: Record<Side, ConcentrationVerdict>
  holderGates: Record<Side, HolderGate>
  seed: string
  seedKey: string
}): FightResult {
  const { failures, fighters, profiles, side, bySide, medicals, holderGates, seed, seedKey } = input
  const percent = (i: 0 | 1) => fighters[i].concentration.percent ?? 0

  const events: FightEvent[] = []
  for (const i of [0, 1] as const) {
    const reason = failures[i]
    if (reason === 'holders') {
      events.push({
        type: 'medicalsFailed',
        fighter: side(i),
        reason,
        holders: fighters[i].holderGate.holders,
        minHolders: fighters[i].holderGate.minHolders,
      })
    } else if (reason === 'concentration') {
      events.push({
        type: 'medicalsFailed',
        fighter: side(i),
        reason,
        concentrationPercent: percent(i),
      })
    }
  }

  const failed = [failures[0] !== null, failures[1] !== null] as const
  const bothFailed = failed[0] && failed[1]
  let winnerIndex: 0 | 1 | null = null

  if (bothFailed) {
    events.push({
      type: 'fightCancelled',
      // Oba wpisy są niepuste: `bothFailed` znaczy, że oblali obaj.
      reasons: bySide([failures[0] as MedicalFailure, failures[1] as MedicalFailure]),
    })
  } else {
    winnerIndex = failed[0] ? 1 : 0
    const loserIndex = (winnerIndex === 0 ? 1 : 0) as 0 | 1
    events.push({ type: 'walkover', winner: side(winnerIndex), loser: side(loserIndex) })
  }

  return {
    seed,
    seedKey,
    hpStart: bySide([round2(profiles[0].hpStart), round2(profiles[1].hpStart)]),
    rounds: [],
    winner: winnerIndex === null ? null : side(winnerIndex),
    method: bothFailed ? 'cancelled' : 'walkover',
    endedInRound: null,
    scorecard: bySide([0, 0]),
    damageDealt: bySide([0, 0]),
    medicals,
    holderGates,
    events,
  }
}
