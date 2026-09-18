/**
 * Koncentracja podaży: ile tokena siedzi w dziesięciu największych portfelach.
 *
 * Czysta arytmetyka — bez sieci, bez env, bez modelu językowego. Model nigdy
 * nie dotyka tych liczb ani nie ocenia koncentracji; dostaje policzony procent
 * i go opisuje (CLAUDE.md § Zasada nadrzędna).
 *
 * Cała trudność jest w mianowniku i w tym, co wchodzi do licznika. Surowy
 * `top10HoldersPercent` z Codexu liczy dziesięć największych **sald**, a nie
 * dziesięciu największych **holderów**: w tej dziesiątce siedzą kontrakty par
 * płynności, adres spalania i sam kontrakt tokena. Żadne z nich nie jest
 * portfelem, który może wyjść na rynek. Dla PONS surowe 42,67% stoi przy
 * podaży w obiegu 712 mln z 1 mld całkowitej — 28,8% podaży nie jest w obiegu
 * i najpewniej właśnie ono podbija tę liczbę.
 *
 * Dlatego najpierw odsiew, potem próg. Kara wymierzona z liczby nieodsianej
 * trafiłaby token za to, że ma pulę płynności.
 */

/** Jedno saldo tokena: adres i ile trzyma, w jednostkach tokena. */
export interface HolderBalance {
  address: string
  /**
   * Saldo w jednostkach tokena (`shiftedBalance` z Codexu), nie w najmniejszej
   * jednostce. Musi być w tych samych jednostkach co `totalSupply`, inaczej
   * procent wychodzi przesunięty o rząd dziesiętny.
   */
  balance: number
}

/** Dlaczego adres wypadł z rachunku. */
export type ExclusionReason = 'pair' | 'burn' | 'token' | 'exchange'

export interface ExcludedAddress {
  address: string
  reason: ExclusionReason
  balance: number
  /** Udział w całkowitej podaży, 0–1. Do audytu: widać, co i ile zdjęto. */
  shareOfTotalSupply: number
}

/**
 * Adresy spalania. Lista jest krótka celowo — wchodzi na nią tylko adres,
 * którego rola jest jednoznaczna, bo każda pozycja tutaj zmienia mianownik.
 */
export const BURN_ADDRESSES: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]

/**
 * Znane portfele giełd, per sieć: `networkId` → adresy.
 *
 * Pusta i taka zostaje, dopóki nie ma potwierdzonego źródła etykiet dla tej
 * sieci. Wpisanie tu adresu „na wyczucie" byłoby wymyśleniem faktu o tokenie,
 * a do tego zdjęciem komuś salda z mianownika — czyli cichą zmianą wyniku
 * walki (CLAUDE.md § Czego nie robić).
 *
 * Codex ma na to `Balance.wallet` i `filterContracts` w `holders`, ale oba
 * siedzą za planem Growth — nie da się ich teraz sprawdzić.
 */
export const EXCHANGE_WALLETS: Readonly<Record<number, readonly string[]>> = {}

const norm = (address: string) => address.toLowerCase()

/**
 * Zbiór adresów, które nie są holderami: kontrakty par płynności, adres
 * spalania, kontrakt samego tokena i znane portfele giełd.
 *
 * Adresy par nie są zgadywane — to te same pary, które już ciągniemy
 * z `listPairsWithMetadataForToken` po to, żeby wybrać parę referencyjną.
 */
export function nonHolderAddresses(input: {
  tokenAddress: string
  pairAddresses: readonly string[]
  networkId: number
}): Map<string, ExclusionReason> {
  const out = new Map<string, ExclusionReason>()
  for (const burn of BURN_ADDRESSES) out.set(norm(burn), 'burn')
  for (const wallet of EXCHANGE_WALLETS[input.networkId] ?? []) out.set(norm(wallet), 'exchange')
  for (const pair of input.pairAddresses) out.set(norm(pair), 'pair')
  // Kontrakt tokena na końcu: gdyby był też parą, „token" jest trafniejszym opisem.
  out.set(norm(input.tokenAddress), 'token')
  return out
}

/**
 * `ok`        — policzone na saldach po odsiewie,
 * `unavailable` — nie było sald do odsiania (zapytanie `holders` za planem),
 * `insufficient` — sald było, ale po odsiewie zostało mniej niż dziesięć.
 */
export type ConcentrationStatus = 'ok' | 'unavailable' | 'insufficient'

export interface Concentration {
  status: ConcentrationStatus
  /**
   * Udział dziesięciu największych holderów w podaży trzymanej przez
   * holderów, 0–100. To jedyna liczba, z której wolno wymierzyć karę.
   */
  top10Percent: number | null
  /**
   * `top10HoldersPercent` wprost z Codexu, bez odsiewu. Wyłącznie do audytu
   * i do pokazania obok — nigdy do progów.
   */
  rawTop10Percent: number | null
  /** Mianownik `top10Percent`: podaż całkowita minus salda nie-holderów. */
  holderSupply: number | null
  totalSupply: number | null
  excluded: ExcludedAddress[]
  /** Jaka część całej podaży wypadła z rachunku, 0–1. */
  excludedShare: number | null
  /** Ile sald weszło do rachunku po odsiewie. */
  holdersConsidered: number
  /** Ile sald przyszło z API przed odsiewem. */
  balancesFetched: number
  /** Czemu nie ma liczby albo czemu jej nie należy używać do progów. */
  note: string | null
}

/** Brak danych o saldach — jawnie, żeby nigdzie nie udawał zera. */
export function concentrationUnavailable(
  rawTop10Percent: number | null,
  note: string,
): Concentration {
  return {
    status: 'unavailable',
    top10Percent: null,
    rawTop10Percent,
    holderSupply: null,
    totalSupply: null,
    excluded: [],
    excludedShare: null,
    holdersConsidered: 0,
    balancesFetched: 0,
    note,
  }
}

const TOP_N = 10

const round2 = (n: number) => Math.round(n * 100) / 100
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

/**
 * Koncentracja z sald, po odsianiu adresów niebędących holderami.
 *
 * Mianownik to podaż po odjęciu **wszystkich** odsianych sald, nie podaż
 * całkowita. Inaczej token z połową podaży w puli płynności wychodziłby na
 * mniej skoncentrowany niż jest: dzielilibyśmy salda holderów przez podaż,
 * do której holderzy nie mają dostępu.
 *
 * Salda sortowane malejąco, przy równych rosnąco po adresie — bez dogrywki
 * po adresie dwa identyczne salda zostawiają kolejność w rękach API i wynik
 * nie jest powtarzalny (CLAUDE.md § Determinizm).
 */
export function computeConcentration(input: {
  balances: readonly HolderBalance[]
  totalSupply: number
  tokenAddress: string
  pairAddresses: readonly string[]
  networkId: number
  rawTop10Percent: number | null
}): Concentration {
  const { balances, totalSupply, rawTop10Percent } = input

  if (balances.length === 0) {
    return concentrationUnavailable(rawTop10Percent, 'No holder balances returned.')
  }
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    return concentrationUnavailable(rawTop10Percent, 'Total supply unknown, so no denominator.')
  }

  const nonHolders = nonHolderAddresses(input)

  const excluded: ExcludedAddress[] = []
  const holders: HolderBalance[] = []
  for (const entry of balances) {
    const balance = Number.isFinite(entry.balance) ? Math.max(0, entry.balance) : 0
    const reason = nonHolders.get(norm(entry.address))
    if (reason) {
      excluded.push({
        address: norm(entry.address),
        reason,
        balance,
        shareOfTotalSupply: round6(balance / totalSupply),
      })
    } else {
      holders.push({ address: norm(entry.address), balance })
    }
  }

  excluded.sort((x, y) => y.balance - x.balance || x.address.localeCompare(y.address))
  holders.sort((x, y) => y.balance - x.balance || x.address.localeCompare(y.address))

  const excludedBalance = excluded.reduce((sum, e) => sum + e.balance, 0)
  const holderSupply = totalSupply - excludedBalance

  if (holderSupply <= 0) {
    return {
      ...concentrationUnavailable(rawTop10Percent, 'Every indexed balance is a non-holder address.'),
      status: 'insufficient',
      totalSupply,
      excluded,
      excludedShare: round6(excludedBalance / totalSupply),
      balancesFetched: balances.length,
    }
  }

  const top10Balance = holders.slice(0, TOP_N).reduce((sum, h) => sum + h.balance, 0)
  const percent = round2(Math.min(100, (top10Balance / holderSupply) * 100))

  // Mniej niż dziesięć sald po odsiewie znaczy, że API zwróciło zbyt krótką
  // stronę — liczba byłaby policzona z mniejszej dziesiątki niż deklaruje.
  const status: ConcentrationStatus = holders.length >= TOP_N ? 'ok' : 'insufficient'

  return {
    status,
    top10Percent: percent,
    rawTop10Percent,
    holderSupply: round6(holderSupply),
    totalSupply,
    excluded,
    excludedShare: round6(excludedBalance / totalSupply),
    holdersConsidered: holders.length,
    balancesFetched: balances.length,
    note:
      status === 'ok'
        ? null
        : `Only ${holders.length} holder balances after filtering, fewer than the ${TOP_N} needed.`,
  }
}

/* ------------------------------------------------------------------ */
/* Progi                                                              */
/* ------------------------------------------------------------------ */

export type ConcentrationBandId = 'clear' | 'stamina' | 'glassJaw' | 'failed'

export interface ConcentrationBand {
  id: ConcentrationBandId
  /** Dolna granica włącznie, w procentach. */
  minPercent: number
  label: string
}

/**
 * Cztery pasma, stykające się bez dziur — tak samo jak kategorie wagowe
 * i tą samą konwencją: **granica należy do pasma wyższego**, więc dokładnie
 * 70% to już niezaliczone badania, a dokładnie 30% to już kara.
 *
 * Progi są sztywne i nigdy względem przeciwnika. Ten sam token dostaje to
 * samo pasmo w każdej walce (CLAUDE.md § Mapowanie danych na statystyki).
 */
export const CONCENTRATION_BANDS: readonly ConcentrationBand[] = [
  { id: 'failed', minPercent: 70, label: 'Failed the medical' },
  { id: 'glassJaw', minPercent: 50, label: 'Glass jaw' },
  { id: 'stamina', minPercent: 30, label: 'Stamina penalty' },
  { id: 'clear', minPercent: 0, label: 'Cleared' },
]

export function concentrationBand(percent: number): ConcentrationBand {
  return (
    CONCENTRATION_BANDS.find((band) => percent >= band.minPercent) ??
    CONCENTRATION_BANDS[CONCENTRATION_BANDS.length - 1]
  )
}

export interface ConcentrationVerdict {
  band: ConcentrationBandId
  label: string
  /** Procent, z którego wyszło pasmo. `null`, gdy pasma nie wyznaczono. */
  percent: number | null
  /** Kara do wytrzymałości jako część, 0–1. Niezerowa tylko w pasmie `stamina`. */
  staminaPenalty: number
  /**
   * Czy pasmo ma wpływ na walkę.
   *
   * `false`, gdy koncentracji nie udało się policzyć na saldach po odsiewie.
   * Wtedy pasmo jest `clear` i walka idzie bez kary — **nie** wymierzamy jej
   * z surowego `top10HoldersPercent`. Ta liczba zawiera pule płynności
   * i podaż poza obiegiem, więc walkower za nią byłby walkowerem za to, że
   * token ma parę na giełdzie.
   */
  enforced: boolean
}

const bandFloor = (id: ConcentrationBandId): number =>
  CONCENTRATION_BANDS.find((band) => band.id === id)?.minPercent ?? 0

/**
 * Kara do wytrzymałości rośnie liniowo w pasmie: 30% → 0, 50% → pełna.
 * Granice czytane po `id`, nie po pozycji w tablicy — kolejność pasm może się
 * zmienić, a wtedy odczyt po indeksie cicho liczyłby co innego.
 */
function staminaPenaltyFor(percent: number): number {
  const floor = bandFloor('stamina')
  const span = bandFloor('glassJaw') - floor
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (percent - floor) / span))
}

const CLEAR: ConcentrationVerdict = {
  band: 'clear',
  label: 'Cleared',
  percent: null,
  staminaPenalty: 0,
  enforced: false,
}

/**
 * Pasmo i kara z policzonej koncentracji.
 *
 * Deterministyczne: ta sama liczba daje zawsze to samo pasmo. Wynik idzie do
 * symulacji, a ta liczy walkę z ziarna — żadnej losowości poza ziarnem.
 */
export function concentrationVerdict(concentration: Concentration): ConcentrationVerdict {
  if (concentration.status !== 'ok' || concentration.top10Percent === null) {
    return { ...CLEAR, percent: null }
  }
  const percent = concentration.top10Percent
  const band = concentrationBand(percent)
  return {
    band: band.id,
    label: band.label,
    percent,
    staminaPenalty: band.id === 'stamina' ? round2(staminaPenaltyFor(percent)) : 0,
    enforced: true,
  }
}
