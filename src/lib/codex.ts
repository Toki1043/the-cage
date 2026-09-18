import {
  computeConcentration,
  concentrationUnavailable,
  concentrationVerdict,
  type Concentration,
  type ConcentrationVerdict,
  type HolderBalance,
} from './concentration.ts'
import { holderGate, type HolderGate } from './holder-gate.ts'
import {
  computeChartModifiers,
  computeStats,
  computeVulnerability,
  latestClose,
  sortPairsByLiquidity,
  weightClass,
  type Bars,
  type ChartModifiers,
  type FightStats,
  type WeightClass,
} from './stats.ts'

const CODEX_ENDPOINT = 'https://graph.codex.io/graphql'

const codexApiKey = process.env.CODEX_API_KEY
if (!codexApiKey) {
  throw new Error('CODEX_API_KEY is not set. Add it to .env.local (see CLAUDE.md § Konfiguracja API).')
}

/** Którą stroną pary jest nasz token. */
export type QuoteToken = 'token0' | 'token1'

/** Jedna para tokena, kandydat do bycia parą referencyjną. */
export interface PairCandidate {
  address: string
  liquidityUsd: number
  /** Obrót z ostatnich 24h na tej parze, w dolarach. */
  volume24hUsd: number
  createdAt: number
  /**
   * Strona pary, na której stoi nasz token — musi trafić do `getBars`.
   *
   * Bez tego świece wracają z ceną drugiej strony puli: dla pary WETH/USDG
   * `getBars` zwracał 1,00 zamiast 2398, kapitalizacja WETH wychodziła $46k
   * zamiast $110M i token wpadał do wagi muszej.
   */
  quoteToken: QuoteToken
  /** Token po drugiej stronie puli — WETH, USDG, cokolwiek. */
  backingSymbol: string | null
  exchange: string | null
}

/**
 * Snapshot danych wejściowych.
 *
 * Dane z Codexu ruszają się między dwoma zapytaniami pod rząd — liczba
 * holderów i płynność potrafią się zmienić w ciągu sekund. Dlatego wynik
 * zawsze idzie razem z tym, na czym został policzony; bez tego nie da się go
 * odtworzyć ani zweryfikować. Patrz CLAUDE.md § Determinizm.
 */
export interface TokenSnapshot {
  /** Para referencyjna: zawsze ta o największej płynności. */
  pairAddress: string
  pairBackingSymbol: string | null
  pairExchange: string | null
  pairQuoteToken: QuoteToken
  /** Ile par tokena rozważono przy wyborze. */
  pairsConsidered: number
  /**
   * Płynność drugiej pary w kolejności. Jeśli jest blisko pierwszej, wybór
   * może się przełączyć przy następnym zapytaniu — wtedy statystyki drgną
   * i widać z czego.
   */
  runnerUpLiquidityUsd: number | null
  /** Najstarsza para tokena — stabilniejsza miara wieku niż para referencyjna. */
  tokenFirstPairAt: number

  liquidityUsd: number
  /** Obrót 24h na parze referencyjnej — z niego liczy się siła. */
  volume24hUsd: number
  marketCapUsd: number
  holders: number
  priceUsd: number
  circulatingSupply: number
  totalSupply: number
  /**
   * Koncentracja podaży w dziesięciu największych portfelach, po odsianiu
   * adresów niebędących holderami. Idzie do snapshotu jak każda inna liczba
   * wejściowa: bez niej nie da się odtworzyć, czemu zawodnik dostał karę
   * albo nie przeszedł badań (CLAUDE.md § Determinizm).
   */
  concentration: Concentration
  /**
   * Kapitalizacja podana przez Codex, tylko do audytu. Codex liczy ją z ceny
   * pary, którą sam sobie wybrał, więc dryfuje między zapytaniami. Do wagi
   * i statystyk idzie `marketCapUsd` policzone z ceny pary referencyjnej.
   */
  reportedMarketCapUsd: number | null
  /**
   * Nasza kapitalizacja rozjechała się z podaną przez Codex więcej niż
   * trzykrotnie. Zwykle znaczy, że cena ze świec dotyczy drugiej strony puli.
   * Nie podmieniamy wtedy liczb — podmiana zabiłaby powtarzalność — tylko
   * oznaczamy dane jako podejrzane.
   */
  marketCapDivergesFromReported: boolean

  /** Unix seconds — powstanie pary referencyjnej. */
  pairCreatedAt: number
  pairAgeDays: number
  /** Kiedy zdjęto snapshot. */
  fetchedAt: number
}

export interface TokenFightData {
  address: string
  name: string
  symbol: string
  networkId: number
  snapshot: TokenSnapshot
  stats: FightStats
  /**
   * Podatność 0–100 z kapitalizacji do płynności (szklana szczęka). Nie jest
   * statystyką bojową: w symulacji zmniejsza pulę życia i zwiększa obrażenia
   * przyjmowane. Liczona tu raz i niesiona obok statystyk, żeby symulacja nie
   * liczyła jej drugi raz z surowych liczb.
   */
  vulnerability: number
  /** Bramka na liczbie holderów — działa na darmowym planie, w przeciwieństwie do koncentracji. */
  holderGate: HolderGate
  weightClass: WeightClass
  modifiers: ChartModifiers
  /**
   * Pasmo koncentracji wyprowadzone ze snapshotu — to ono wchodzi do
   * symulacji. Trzymane obok statystyk, a nie liczone drugi raz w symulacji:
   * drugi rachunek tego samego to drugie miejsce, w którym może się rozjechać.
   */
  concentration: ConcentrationVerdict
}

// Jedyne zapytanie zawężone do par konkretnego tokena. `filterPairs(phrase:)`
// jest wyszukiwaniem tekstowym i zwraca też pary obce, więc nie nadaje się
// do wyboru pary referencyjnej.
const PAIRS_QUERY = `
  query($tokenAddress: String!, $networkId: Int!) {
    listPairsWithMetadataForToken(tokenAddress: $tokenAddress, networkId: $networkId) {
      results {
        liquidity
        volume
        quoteToken
        backingToken { symbol }
        exchange { name }
        pair { address createdAt token0 token1 }
      }
    }
  }
`

// Dane na poziomie tokena, nie pary: holderzy i podaż w obiegu. Płynność,
// wiek i cenę bierzemy z pary referencyjnej, nie stąd — `filterTokens`
// opisuje jedną parę, którą wybiera sam i zmienia między zapytaniami.
const TOKEN_QUERY = `
  query($phrase: String!, $network: [Int!]) {
    filterTokens(phrase: $phrase, filters: { network: $network }, limit: 1) {
      results {
        holders
        marketCap
        top10HoldersPercent
        token { info { address name symbol circulatingSupply totalSupply } }
      }
    }
  }
`

/**
 * Salda największych portfeli — jedyne źródło, z którego da się policzyć
 * koncentrację po odsianiu adresów niebędących holderami.
 *
 * **Wymaga planu Growth albo Enterprise.** Na darmowym kluczu wraca
 * `NOT_AUTHORIZED: please upgrade your plan` (sprawdzone też na WETH
 * z mainnetu, więc to blokada planu, nie sieci). Bez niej zostaje surowy
 * `top10HoldersPercent`, którego nie da się odsiać — patrz `fetchHolders`.
 *
 * `limit` 50 zamiast 10: dziesiątka musi zostać **po** odsiewie, a w surowej
 * dziesiątce siedzą pule płynności i adres spalania.
 */
const HOLDERS_QUERY = `
  query($tokenId: String!, $limit: Int!) {
    holders(input: { tokenId: $tokenId, limit: $limit }) {
      count
      status
      top10HoldersPercent
      items { address shiftedBalance }
    }
  }
`

// `symbol` to adres pary, nie tokena. Pytany adresem tokena `getBars` sam
// wybiera parę — i wybiera inną niż ta z wyboru po płynności.
const BARS_QUERY = `
  query($symbol: String!, $from: Int!, $to: Int!, $resolution: String!, $quoteToken: QuoteToken) {
    getBars(
      symbol: $symbol
      from: $from
      to: $to
      resolution: $resolution
      currencyCode: "USD"
      quoteToken: $quoteToken
      removeLeadingNullValues: true
    ) {
      c
      t
    }
  }
`

/**
 * Darmowy próg Codexu limituje nie tylko liczbę zapytań miesięcznie, ale i
 * tempo. Walka to 8 zapytań, więc dwie walki pod rząd potrafią dostać 429 —
 * a wtedy cała walka przepada na czymś, co samo przechodzi po chwili.
 * Codex podaje w odpowiedzi `retryAfterSeconds`, więc czekamy tyle, ile każe.
 */
const MAX_ATTEMPTS = 3
const MAX_RETRY_WAIT_MS = 12_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function retryAfterMs(payload: string, attempt: number): number {
  const match = payload.match(/"retryAfterSeconds":\s*(\d+(?:\.\d+)?)/)
  const advised = match ? Number(match[1]) * 1_000 : 0
  // Gdy Codex nie powie ile czekać, rośniemy wykładniczo: 1s, 2s, 4s.
  const fallback = 2 ** (attempt - 1) * 1_000
  return Math.min(Math.max(advised, fallback), MAX_RETRY_WAIT_MS)
}

async function codexQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(CODEX_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: codexApiKey!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) {
      const body = await res.text()
      lastError = new Error(`Codex request failed: ${res.status} ${body}`)
      // 429 i 5xx są przejściowe; 4xx poza 429 to błąd zapytania, nie warto powtarzać.
      const transient = res.status === 429 || res.status >= 500
      if (!transient || attempt === MAX_ATTEMPTS) throw lastError
      await sleep(retryAfterMs(body, attempt))
      continue
    }

    const json = await res.json()
    if (json.errors) {
      const payload = JSON.stringify(json.errors)
      lastError = new Error(`Codex GraphQL error: ${payload}`)
      // Limit tempa umie przyjść też ze statusem 200, w polu `errors`.
      if (!payload.includes('TOO_MANY_REQUESTS') || attempt === MAX_ATTEMPTS) throw lastError
      await sleep(retryAfterMs(payload, attempt))
      continue
    }
    return json.data as T
  }

  throw lastError ?? new Error('Codex request failed')
}

/** Rozjazd rzędu wielkości, nie kilku procent — te drgają normalnie. */
function divergesFromReported(ours: number, reported: number | null): boolean {
  if (reported === null || reported <= 0 || ours <= 0) return false
  const ratio = ours / reported
  return ratio > 3 || ratio < 1 / 3
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function fetchPairs(address: string, networkId: number): Promise<PairCandidate[]> {
  const data = await codexQuery<{
    listPairsWithMetadataForToken: {
      results: {
        liquidity: string | null
        volume: string | null
        quoteToken: QuoteToken | null
        backingToken: { symbol: string | null } | null
        exchange: { name: string | null } | null
        pair: { address: string; createdAt: number; token0: string; token1: string }
      }[]
    }
  }>(PAIRS_QUERY, { tokenAddress: address, networkId })

  const results = data.listPairsWithMetadataForToken?.results ?? []
  const wanted = address.toLowerCase()

  return results.map((r) => {
    // Liczymy stronę sami z token0/token1 — to jednoznaczne. `quoteToken`
    // od Codexu zgadzał się z tym w każdym sprawdzonym przypadku i służy
    // jako zapas, gdy adresów stron zabraknie.
    const side: QuoteToken | null =
      r.pair.token0?.toLowerCase() === wanted
        ? 'token0'
        : r.pair.token1?.toLowerCase() === wanted
          ? 'token1'
          : null

    return {
      address: r.pair.address,
      liquidityUsd: toNumber(r.liquidity),
      volume24hUsd: toNumber(r.volume),
      createdAt: Number(r.pair.createdAt),
      quoteToken: side ?? r.quoteToken ?? 'token0',
      backingSymbol: r.backingToken?.symbol ?? null,
      exchange: r.exchange?.name ?? null,
    }
  })
}

async function fetchTokenMeta(address: string, networkId: number) {
  const data = await codexQuery<{
    filterTokens: {
      results: {
        holders: number
        marketCap: string | null
        top10HoldersPercent: number | null
        token: {
          info: {
            address: string
            name: string
            symbol: string
            circulatingSupply: string | null
            totalSupply: string | null
          }
        }
      }[]
    }
  }>(TOKEN_QUERY, { phrase: address, network: [networkId] })

  const result = data.filterTokens?.results?.[0]
  if (!result) {
    throw new Error(`Token not found on network ${networkId}: ${address}`)
  }

  // `phrase` to wyszukiwanie, nie filtr po kluczu — upewniamy się, że wrócił
  // ten token, o który pytaliśmy, a nie coś podobnego z tej samej sieci.
  const returned = result.token.info.address
  if (returned.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `Codex returned a different token than requested: asked for ${address}, got ${returned}`,
    )
  }

  // Bramka na holderach jest twarda, więc brak liczby nie może wyjść jako zero:
  // zero to walkower, a walkower za to, że Codex czegoś nie zwrócił, byłby
  // wynikiem wziętym znikąd. Lepiej przewrócić zapytanie niż zmyślić werdykt.
  if (typeof result.holders !== 'number' || !Number.isFinite(result.holders)) {
    throw new Error(
      `Codex returned no holder count for ${address}, so the pre-fight check cannot be run.`,
    )
  }

  return {
    info: result.token.info,
    holders: result.holders,
    circulatingSupply: toNumber(result.token.info.circulatingSupply),
    totalSupply: toNumber(result.token.info.totalSupply),
    reportedMarketCapUsd: result.marketCap === null ? null : toNumber(result.marketCap),
    /** Bez odsiewu — tylko do audytu, nigdy do progów. */
    rawTop10Percent:
      typeof result.top10HoldersPercent === 'number' && Number.isFinite(result.top10HoldersPercent)
        ? result.top10HoldersPercent
        : null,
  }
}

/** Ile sald ciągniemy: dziesiątka musi zostać po odsiewie. */
const HOLDER_BALANCES_LIMIT = 50

/**
 * Plan raz odmówił — nie pytamy drugi raz w tym procesie.
 *
 * Bez tego każda walka wysyła dwa zapytania, o których już wiemy, że wrócą
 * z `NOT_AUTHORIZED`. Przy darmowym progu 10 000 miesięcznie to 2 zapytania
 * na walkę wyrzucone na odpowiedź, którą znamy, plus jedno okrążenie sieci
 * w ścieżce krytycznej. Blokada planu nie zmieni się w trakcie życia procesu;
 * po podniesieniu planu wystarczy restart.
 */
let holdersPlanDenied: string | null = null

/**
 * Salda największych portfeli, albo `null` gdy plan ich nie daje.
 *
 * Nie wywraca walki. Brak sald znaczy tylko, że koncentracji nie da się
 * odsiać — a wtedy nie wymierzamy z niej kary. Zamiana tego na błąd
 * zabrałaby całą funkcjonalność za coś, co jest ograniczeniem planu API.
 */
async function fetchHolderBalances(
  address: string,
  networkId: number,
): Promise<{ balances: HolderBalance[] } | { balances: null; note: string }> {
  if (holdersPlanDenied !== null) return { balances: null, note: holdersPlanDenied }

  try {
    const data = await codexQuery<{
      holders: {
        count: number
        status: string
        top10HoldersPercent: number | null
        items: { address: string; shiftedBalance: string | null }[]
      }
    }>(HOLDERS_QUERY, { tokenId: `${address}:${networkId}`, limit: HOLDER_BALANCES_LIMIT })

    const holders = data.holders
    if (holders?.status === 'DISABLED') {
      return { balances: null, note: 'Codex reports holder data disabled for this token.' }
    }
    const items = holders?.items ?? []
    if (items.length === 0) {
      return { balances: null, note: 'Codex returned no holder balances for this token.' }
    }
    return {
      balances: items.map((item) => ({
        address: item.address,
        balance: toNumber(item.shiftedBalance),
      })),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Plan Growth/Enterprise — jedyny powód, dla którego to zapytanie pada
        // na sprawnym kluczu. Rozpoznajemy go, żeby front mógł napisać wprost,
    // czego brakuje, zamiast pokazywać puste pole.
    if (message.includes('NOT_AUTHORIZED') || message.includes('upgrade your plan')) {
      holdersPlanDenied =
        'Holder balances need a Codex Growth or Enterprise plan, so the top-10 share ' +
        'cannot be filtered down to real holders. Shown unfiltered, and it carries no ' +
        'weight in the fight.'
      return { balances: null, note: holdersPlanDenied }
    }
    return { balances: null, note: `Holder balances unavailable: ${message}` }
  }
}

/**
 * Świece są dodatkiem: bez nich walka nadal się rozegra, tylko bez
 * modyfikatorów z wykresu. Dlatego błąd tutaj nie wywraca całego zapytania.
 */
async function fetchBars(
  pair: PairCandidate,
  networkId: number,
  from: number,
  to: number,
  resolution: '1D' | '60',
): Promise<Bars | null> {
  try {
    const data = await codexQuery<{ getBars: { c: (number | null)[]; t: number[] } }>(BARS_QUERY, {
      symbol: `${pair.address}:${networkId}`,
      from,
      to,
      resolution,
      quoteToken: pair.quoteToken,
    })
    const bars = data.getBars
    if (!bars?.t?.length) return null
    return bars
  } catch {
    return null
  }
}

/**
 * Pełne dane jednego zawodnika: snapshot, cztery statystyki 0–100, kategoria
 * wagowa i modyfikatory z wykresu. Czysta arytmetyka — model językowy nie
 * dotyka żadnej z tych liczb.
 *
 * Wszystko, co zależy od pary — płynność, wiek, cena, świece — pochodzi
 * z jednej pary referencyjnej: tej o największej płynności. Inaczej ta sama
 * para adresów daje za każdym razem inne statystyki, a ranking traci sens.
 *
 * Koszt: 5 zapytań na token, czyli 10 na walkę — piąte to salda holderów do
 * koncentracji podaży. Darmowy próg Codexu to 10 000 miesięcznie, więc mieści
 * się w tym około 1000 walk; przy większym ruchu potrzebny cache per token.
 * Patrz CLAUDE.md § Źródło danych.
 */
export async function fetchTokenFightData(
  address: string,
  networkId: number,
): Promise<TokenFightData> {
  const [pairs, meta, holderBalances] = await Promise.all([
    fetchPairs(address, networkId),
    fetchTokenMeta(address, networkId),
    fetchHolderBalances(address, networkId),
  ])

  if (pairs.length === 0) {
    throw new Error(`Token has no indexed pairs on network ${networkId}: ${address}`)
  }

  const ranked = sortPairsByLiquidity(pairs)
  const pair = ranked[0]
  const fetchedAt = Math.floor(Date.now() / 1000)

  // Świece z pary referencyjnej: dzienne od jej powstania (szczyt, zmienność,
  // okno 7d) i godzinowe z ostatniej doby z zapasem (cena, okna 1h i 24h).
  const [daily, hourly] = await Promise.all([
    fetchBars(pair, networkId, pair.createdAt, fetchedAt, '1D'),
    fetchBars(pair, networkId, fetchedAt - 30 * 3_600, fetchedAt, '60'),
  ])

  // Cena z pary referencyjnej, nie z tej, którą wybrał sobie Codex.
  const priceUsd = latestClose(hourly) ?? 0

  // Koncentracja podaży: najpierw odsiew adresów niebędących holderami,
  // dopiero potem procent. Adresy par bierzemy z `ranked` — to te same pary,
  // które już mamy z wyboru pary referencyjnej, więc odsiew nie kosztuje
  // ani jednego dodatkowego zapytania.
  const concentration =
    holderBalances.balances === null
      ? concentrationUnavailable(meta.rawTop10Percent, holderBalances.note)
      : computeConcentration({
          balances: holderBalances.balances,
          totalSupply: meta.totalSupply,
          tokenAddress: meta.info.address,
          pairAddresses: ranked.map((p) => p.address),
          networkId,
          rawTop10Percent: meta.rawTop10Percent,
        })

  // Kapitalizacja z ceny pary referencyjnej i podaży w obiegu. To definicja
  // kapitalizacji, a nie wybór jednego z kilku wyników — i dzięki temu waga
  // nie przeskakuje między kategoriami przy niezmienionym tokenie.
  const marketCapUsd = priceUsd * meta.circulatingSupply

  const snapshot: TokenSnapshot = {
    pairAddress: pair.address,
    pairBackingSymbol: pair.backingSymbol,
    pairExchange: pair.exchange,
    pairQuoteToken: pair.quoteToken,
    pairsConsidered: ranked.length,
    runnerUpLiquidityUsd: ranked[1]?.liquidityUsd ?? null,
    tokenFirstPairAt: Math.min(...ranked.map((p) => p.createdAt)),

    liquidityUsd: pair.liquidityUsd,
    volume24hUsd: pair.volume24hUsd,
    marketCapUsd,
    holders: meta.holders,
    priceUsd,
    circulatingSupply: meta.circulatingSupply,
    totalSupply: meta.totalSupply,
    concentration,
    reportedMarketCapUsd: meta.reportedMarketCapUsd,
    marketCapDivergesFromReported: divergesFromReported(
      marketCapUsd,
      meta.reportedMarketCapUsd,
    ),

    pairCreatedAt: pair.createdAt,
    pairAgeDays: Math.max(0, (fetchedAt - pair.createdAt) / 86_400),
    fetchedAt,
  }

  return {
    address: meta.info.address,
    name: meta.info.name,
    symbol: meta.info.symbol,
    networkId,
    snapshot,
    stats: computeStats({
      liquidityUsd: snapshot.liquidityUsd,
      marketCapUsd: snapshot.marketCapUsd,
      volume24hUsd: snapshot.volume24hUsd,
      holders: snapshot.holders,
      ageDays: snapshot.pairAgeDays,
    }),
    vulnerability: computeVulnerability(snapshot),
    holderGate: holderGate(snapshot.holders),
    weightClass: weightClass(snapshot.marketCapUsd),
    modifiers: computeChartModifiers(daily, hourly),
    concentration: concentrationVerdict(snapshot.concentration),
  }
}
