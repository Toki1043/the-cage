/**
 * Ranking per kontrakt, osobna lista dla każdej kategorii wagowej.
 *
 * Ranking jest per kontrakt, nie per walka — to on daje powód, żeby wrócić
 * drugi raz (CLAUDE.md § Stack docelowy). Pięć list zamiast jednej, bo token
 * za $500 mln i token za $2 mln stoją na innych półkach.
 *
 * Co tu nie wchodzi:
 *
 *  - Model językowy. Wynik przychodzi policzony z symulacji, tutaj jest tylko
 *    dodawany do rekordu.
 *  - Ocena tokena. Rekord to liczba wygranych walk, nic więcej. Pozycja na
 *    liście nie mówi nic o tym, czy token urośnie — patrz § Czego nie robić.
 *
 * Każdy zapisany wynik idzie razem ze snapshotem danych wejściowych, na
 * podstawie których został policzony. Bez tego wyniku nie da się odtworzyć
 * ani zweryfikować (CLAUDE.md § Determinizm).
 */

import type { TokenFightData } from './codex'
import type { FightResult, Side } from './fight'
import type { ContractSecurity } from './security'
import type { FightStats, WeightClassId } from './stats'
// Rozszerzenia `.ts` w importach wykonywanych w czasie działania: bez nich
// `node --experimental-strip-types` nie rozwiąże ścieżki, a na tym stoją
// skrypty weryfikacyjne. Bundler Next-a radzi sobie z jednym i drugim.
import { WEIGHT_CLASSES } from './stats.ts'
import { getJson, isPersistent, mgetJson, setIfAbsent, setJson, zadd, zcard, zrem, ztop } from './kv.ts'

/**
 * Wersja w kluczach: zmiana kształtu rekordu nie miesza się ze starymi.
 *
 * v2: siła liczona z obrotu 24h zamiast z kapitalizacji / płynności, plus
 * podatność i bramka na holderach. Walki z v1 były policzone inną regułą,
 * a klucz walki jest idempotentny po parze adresów — bez nowej wersji ta sama
 * para nie mogłaby zostać rozegrana ponownie, a ranking mieszałby dwie skale.
 */
const V = 'v2'

/** Klucz walki. `seedKey` jest funkcją obu adresów, więc ta sama para = ten sam klucz. */
const fightKey = (seedKey: string) => `fight:${V}:${seedKey}`
const tokenKey = (networkId: number, address: string) =>
  `token:${V}:${networkId}:${address.toLowerCase()}`
const boardKey = (weightClass: WeightClassId) => `board:${V}:${weightClass}`
const member = (networkId: number, address: string) => `${networkId}:${address.toLowerCase()}`

/**
 * Liczby ze snapshotu, na których policzono statystyki tej walki.
 *
 * Kopia, nie referencja do pełnego `TokenSnapshot`: rekord ma zostać czytelny
 * i mały, a to są jedyne wielkości wchodzące do mapowania.
 */
export interface RecordedInputs {
  liquidityUsd: number
  marketCapUsd: number
  /** Obrót 24h na parze referencyjnej — z niego liczy się siła. */
  volume24hUsd: number
  holders: number
  ageDays: number
  /** Kiedy zdjęto snapshot — dane z Codexu ruszają się w czasie. */
  fetchedAt: number
  /** Para referencyjna, z której wzięto płynność i cenę. */
  pairAddress: string
  /**
   * Koncentracja podaży po odsiewie, 0–100. `null`, gdy jej nie policzono.
   *
   * Idzie do rekordu, bo od niej zależy kara do wytrzymałości, szklana
   * szczęka i walkower — bez niej nie da się odtworzyć, czemu walka skończyła
   * się tak, jak się skończyła (CLAUDE.md § Determinizm).
   */
  top10Percent: number | null
  /** Czy pasmo koncentracji miało wpływ na tę walkę. */
  concentrationEnforced: boolean
  /**
   * Skan GoPlus, na którym stanęła bramka na honeypocie. Bez niego walkower za
   * honeypota jest nie do zweryfikowania — GoPlus zmienia zdanie w czasie.
   * Opcjonalne: rekordy sprzed skanu go nie mają, a brak pola to nie to samo
   * co `checks: null`.
   */
  security?: ContractSecurity
}

/** Rekord jednego kontraktu. */
export interface TokenRecord {
  networkId: number
  address: string
  symbol: string
  name: string

  fights: number
  wins: number
  losses: number
  draws: number
  /** Wygrane przed czasem: KO i TKO. */
  knockouts: number
  /** Ile walk było poza kategorią — front oznacza je widocznie. */
  crossClassFights: number

  /** Kategoria z ostatniej walki; kapitalizacja się rusza, więc token potrafi zmienić półkę. */
  weightClass: WeightClassId
  /** Statystyki z ostatniej walki. */
  stats: FightStats
  /** Dane wejściowe ostatniej walki. */
  inputs: RecordedInputs
  /** `seedKey` ostatniej walki — po nim można ją odtworzyć. */
  lastFightSeedKey: string
  updatedAt: number
}

/** Zapisana walka: wynik plus wszystko, co było potrzebne, żeby go policzyć. */
export interface RecordedFight {
  seedKey: string
  seed: string
  networkId: number
  winner: Side | null
  method: FightResult['method']
  endedInRound: number | null
  scorecard: Record<Side, number>
  sides: Record<Side, { address: string; symbol: string; weightClass: WeightClassId; stats: FightStats; inputs: RecordedInputs }>
  settledAt: number
}

/* ------------------------------------------------------------------ */
/* Zapis wyniku                                                        */
/* ------------------------------------------------------------------ */

/** Trzy punkty za wygraną, jeden za remis. Nic więcej się nie liczy. */
export function points(record: Pick<TokenRecord, 'wins' | 'draws'>): number {
  return record.wins * 3 + record.draws
}

function inputsOf(token: TokenFightData): RecordedInputs {
  return {
    liquidityUsd: token.snapshot.liquidityUsd,
    marketCapUsd: token.snapshot.marketCapUsd,
    volume24hUsd: token.snapshot.volume24hUsd,
    holders: token.snapshot.holders,
    ageDays: token.snapshot.pairAgeDays,
    fetchedAt: token.snapshot.fetchedAt,
    pairAddress: token.snapshot.pairAddress,
    top10Percent: token.snapshot.concentration.top10Percent,
    concentrationEnforced: token.concentration.enforced,
    security: token.snapshot.security,
  }
}

function emptyRecord(token: TokenFightData): TokenRecord {
  return {
    networkId: token.networkId,
    address: token.address.toLowerCase(),
    symbol: token.symbol,
    name: token.name,
    fights: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    knockouts: 0,
    crossClassFights: 0,
    weightClass: token.weightClass.id,
    stats: token.stats,
    inputs: inputsOf(token),
    lastFightSeedKey: '',
    updatedAt: 0,
  }
}

export interface RecordOutcome {
  /** `false`, gdy ta walka była już zapisana — wtedy nic się nie zmieniło. */
  recorded: boolean
  /**
   * Czemu nic nie doszło: `duplicate` — ta para już walczyła,
   * `cancelled` — obaj nie przeszli badań, więc walki nie było.
   */
  reason: 'duplicate' | 'cancelled' | null
  /** Czy zapis poszedł do realnej bazy, czy do pamięci procesu. */
  persistent: boolean
  fight: RecordedFight
}

/**
 * Dopisuje wynik do rekordów obu kontraktów.
 *
 * Idempotentne po `seedKey`. Ta sama para adresów daje zawsze tę samą walkę,
 * więc odświeżenie strony nie może dopisać drugiego zwycięstwa — pierwszy
 * `SET NX` wygrywa, każde następne wywołanie tylko odczytuje zapisaną walkę.
 * Bez tego ranking mierzyłby, kto częściej klikał.
 */
export async function recordFight(
  tokenA: TokenFightData,
  tokenB: TokenFightData,
  result: FightResult,
): Promise<RecordOutcome> {
  const fight: RecordedFight = {
    seedKey: result.seedKey,
    seed: result.seed,
    networkId: tokenA.networkId,
    winner: result.winner,
    method: result.method,
    endedInRound: result.endedInRound,
    scorecard: result.scorecard,
    sides: {
      a: side(tokenA),
      b: side(tokenB),
    },
    settledAt: Math.floor(Date.now() / 1000),
  }

  // Walka odwołana nie jest wynikiem i nie może ruszyć rankingu. Zapisanie
  // jej jako remisu dałoby obu zawodnikom po punkcie za to, że nie weszli do
  // ringu; zapisanie jako przegranej obu — dwie przegrane z nikim.
  if (result.method === 'cancelled') {
    return { recorded: false, reason: 'cancelled', persistent: isPersistent(), fight }
  }

  const firstTime = await setIfAbsent(fightKey(result.seedKey), fight)
  if (!firstTime) {
    const stored = await getJson<RecordedFight>(fightKey(result.seedKey))
    return {
      recorded: false,
      reason: 'duplicate',
      persistent: isPersistent(),
      fight: stored ?? fight,
    }
  }

  const crossClass = tokenA.weightClass.id !== tokenB.weightClass.id
  await Promise.all([
    applyResult(tokenA, result.winner === 'a', result.winner === 'b', result, crossClass),
    applyResult(tokenB, result.winner === 'b', result.winner === 'a', result, crossClass),
  ])

  return { recorded: true, reason: null, persistent: isPersistent(), fight }
}

function side(token: TokenFightData): RecordedFight['sides']['a'] {
  return {
    address: token.address.toLowerCase(),
    symbol: token.symbol,
    weightClass: token.weightClass.id,
    stats: token.stats,
    inputs: inputsOf(token),
  }
}

/**
 * Jedna strona wyniku dopisana do rekordu kontraktu.
 *
 * Kategoria wagowa bierze się z tej walki, nie z rekordu: kapitalizacja się
 * rusza i token potrafi zmienić półkę. Wtedy schodzi ze starej listy, żeby
 * nie stał na dwóch naraz.
 */
async function applyResult(
  token: TokenFightData,
  won: boolean,
  lost: boolean,
  result: FightResult,
  crossClass: boolean,
): Promise<void> {
  const key = tokenKey(token.networkId, token.address)
  const previous = (await getJson<TokenRecord>(key)) ?? emptyRecord(token)
  const beforeClass = previous.weightClass

  const record: TokenRecord = {
    ...previous,
    // Symbol, nazwa, statystyki i wejścia zawsze z najnowszej walki.
    symbol: token.symbol,
    name: token.name,
    fights: previous.fights + 1,
    wins: previous.wins + (won ? 1 : 0),
    losses: previous.losses + (lost ? 1 : 0),
    draws: previous.draws + (!won && !lost ? 1 : 0),
    knockouts:
      previous.knockouts + (won && (result.method === 'KO' || result.method === 'TKO') ? 1 : 0),
    crossClassFights: previous.crossClassFights + (crossClass ? 1 : 0),
    weightClass: token.weightClass.id,
    stats: token.stats,
    inputs: inputsOf(token),
    lastFightSeedKey: result.seedKey,
    updatedAt: Math.floor(Date.now() / 1000),
  }

  await setJson(key, record)

  const entry = member(token.networkId, token.address)
  if (previous.fights > 0 && beforeClass !== record.weightClass) {
    await zrem(boardKey(beforeClass), entry)
  }
  await zadd(boardKey(record.weightClass), points(record), entry)
}

/* ------------------------------------------------------------------ */
/* Odczyt list                                                         */
/* ------------------------------------------------------------------ */

export interface BoardEntry {
  rank: number
  points: number
  /** Część wygranych walk, 0–1. `null` przy zerowej liczbie walk. */
  winRate: number | null
  record: TokenRecord
}

export interface Board {
  weightClass: { id: WeightClassId; label: string }
  /** Ile kontraktów jest na tej liście łącznie, nie tylko na zwróconej stronie. */
  total: number
  entries: BoardEntry[]
}

/**
 * Kolejność: punkty, potem część wygranych, potem liczba walk, na końcu adres.
 *
 * Dogrywka po adresie nie jest ozdobą — bez niej dwa rekordy o tych samych
 * liczbach zamieniają się miejscami między odświeżeniami i lista wygląda
 * na losową. Tak samo jak przy wyborze pary referencyjnej (§ Determinizm).
 */
function compareRecords(x: TokenRecord, y: TokenRecord): number {
  return (
    points(y) - points(x) ||
    winRate(y) - winRate(x) ||
    y.fights - x.fights ||
    x.address.localeCompare(y.address)
  )
}

function winRate(record: TokenRecord): number {
  return record.fights > 0 ? record.wins / record.fights : 0
}

/**
 * Jedna lista, najlepsze kontrakty w swojej kategorii wagowej.
 *
 * Z ZSET-u schodzi więcej pozycji niż `limit`: ZSET zna tylko punkty, a przy
 * równych punktach kolejność rozstrzygają dalsze kryteria. Gdybyśmy wzięli
 * dokładnie `limit`, dogrywka działałaby wewnątrz przypadkowo wyciętej grupy.
 */
export async function readBoard(weightClass: WeightClassId, limit = 10): Promise<Board> {
  const label =
    WEIGHT_CLASSES.find((c) => c.id === weightClass)?.label ?? weightClass
  const key = boardKey(weightClass)

  const [members, total] = await Promise.all([
    ztop(key, Math.min(200, Math.max(limit * 3, limit + 10))),
    zcard(key),
  ])

  const keys = members.map((m) => {
    const [networkId, address] = m.split(':')
    return tokenKey(Number(networkId), address)
  })

  const records = (await mgetJson<TokenRecord>(keys)).filter(
    (record): record is TokenRecord => record !== null,
  )

  const entries = records
    .sort(compareRecords)
    .slice(0, limit)
    .map((record, index) => ({
      rank: index + 1,
      points: points(record),
      winRate: record.fights > 0 ? Math.round((record.wins / record.fights) * 100) / 100 : null,
      record,
    }))

  return { weightClass: { id: weightClass, label }, total, entries }
}

export interface Leaderboard {
  /** Pięć list, w kolejności od najlżejszej kategorii. */
  boards: Board[]
  /** `false`, gdy ranking stoi na pamięci procesu i zginie przy restarcie. */
  persistent: boolean
}

/** Wszystkie pięć list naraz — front pokazuje je obok siebie. */
export async function readLeaderboard(limit = 10): Promise<Leaderboard> {
  const boards = await Promise.all(WEIGHT_CLASSES.map((c) => readBoard(c.id, limit)))
  return { boards, persistent: isPersistent() }
}

/** Rekord jednego kontraktu — po walce front pokazuje bilans obu zawodników. */
export async function readRecord(
  networkId: number,
  address: string,
): Promise<TokenRecord | null> {
  return getJson<TokenRecord>(tokenKey(networkId, address))
}
