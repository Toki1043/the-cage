import { NextRequest, NextResponse } from 'next/server'
import { fetchTokenFightData } from '@/lib/codex'
import { simulateFight } from '@/lib/fight'
import { recordFight, readRecord, type TokenRecord } from '@/lib/leaderboard'
import { PER_IP_LIMIT, clientIp, rateLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { matchup } from '@/lib/stats'
import { trackedWallets } from '@/lib/tracked'

// Domyślna sieć: Robinhood Chain (Codex networkId 4663) — potwierdzone
// zapytaniem `{ getNetworks { name id } }`, patrz CLAUDE.md § Kolejność prac.
const DEFAULT_NETWORK_ID = 4663

/**
 * Limit zapytań na IP: dziesięć walk na minutę.
 *
 * Jedna walka to dziesięć zapytań do Codexu, a darmowy próg to 10 000
 * miesięcznie — dziesięć na minutę z jednego adresu to i tak więcej, niż
 * człowiek zdąży obejrzeć, i wciąż mniej, niż potrzeba, żeby pętla
 * odświeżająca stronę zjadła miesięczny budżet w kwadrans.
 *
 * Drugi powód jest w `tracked.ts`: licznik obserwowanych portfeli da się
 * sondować walka po walce. Limit tego nie zamyka, ale podnosi koszt.
 */
const RATE_LIMIT = PER_IP_LIMIT

/**
 * GET /api/fight?a=0x...&b=0x...&network=4663
 *
 * Ciągnie z Codexu płynność, kapitalizację, holderów, wiek pary i świece
 * dzienne dla dwóch tokenów, po czym zwraca dla każdego:
 *
 *  - snapshot danych wejściowych (bez niego wyniku nie da się odtworzyć),
 *  - cztery statystyki bojowe znormalizowane do 0–100 na sztywnych progach,
 *  - kategorię wagową z kapitalizacji,
 *  - modyfikatory z wykresu: zmiana 1h / 24h / 7d, spadek od szczytu, zmienność.
 *
 * Na koniec rozgrywa trzyrundową walkę: wynik liczy deterministyczna symulacja
 * z ziarna policzonego z obu adresów. Bez modelu językowego — komentarz i
 * sędzia dochodzą osobno i dostają gotowy rezultat.
 *
 * Każdy token przechodzi też skan GoPlus (publiczny, bez klucza): honeypot,
 * mintable, blacklist, owner zmienia salda, transfery do wstrzymania. Honeypot to bramka jak liczba
 * holderów — walkower, bez rund. Cztery pozostałe to ostrzeżenia w narożniku
 * i wyniku nie ruszają. Gdy GoPlus nie zna sieci albo nie odpowiada, skan
 * wraca jako `checks: null` z notatką, a walka idzie normalnie: brak danych
 * nie jest zaświadczeniem o czystości kontraktu.
 *
 * Osobno, obok walki i bez wpływu na nią, idzie licznik obserwowanych
 * portfeli: ile adresów z serwerowej listy `TRACKED_WALLETS` trzyma każdego
 * z tokenów. Wychodzi wyłącznie liczba — nigdy adresy i nigdy sama lista.
 *
 * Trasa ma limit zapytań na IP; przy przekroczeniu wraca 429 z `Retry-After`.
 *
 * Wynik idzie do rankingu razem ze snapshotem, na którym został policzony.
 * Zapis jest idempotentny po parze adresów, więc odświeżanie strony nie
 * dopisuje kolejnych zwycięstw. `?record=0` pomija zapis — tego używają
 * skrypty weryfikacyjne, żeby nie zaśmiecać rankingu.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const a = searchParams.get('a')
  const b = searchParams.get('b')
  const networkId = Number(searchParams.get('network') ?? DEFAULT_NETWORK_ID)

  if (!a || !b) {
    return NextResponse.json(
      { error: 'Podaj dwa adresy tokenów: ?a=0x...&b=0x...' },
      { status: 400 },
    )
  }

  if (a.toLowerCase() === b.toLowerCase()) {
    return NextResponse.json(
      { error: 'Podaj dwa różne adresy — token nie walczy sam ze sobą.' },
      { status: 400 },
    )
  }

  if (!Number.isInteger(networkId) || networkId <= 0) {
    return NextResponse.json(
      { error: 'Parametr `network` musi być liczbą całkowitą (id sieci Codexu).' },
      { status: 400 },
    )
  }

  // Limit przed pierwszym zapytaniem do Codexu — liczy się właśnie po to,
  // żeby te zapytania nie poszły.
  const verdict = await rateLimit('fight', clientIp(request.headers), RATE_LIMIT)
  const limitHeaders = rateLimitHeaders(verdict)
  if (!verdict.ok) {
    return NextResponse.json(
      {
        error:
          `Too many fights from this address. ${RATE_LIMIT.limit} a minute is the cap — ` +
          `try again in ${verdict.retryAfter}s.`,
      },
      { status: 429, headers: limitHeaders },
    )
  }

  try {
    const [tokenA, tokenB] = await Promise.all([
      fetchTokenFightData(a, networkId),
      fetchTokenFightData(b, networkId),
    ])

    const fight = simulateFight(tokenA, tokenB)

    // Ranking i licznik obserwowanych portfeli — obie rzeczy po walce, obie
    // równolegle. Żadna z nich nie może zmienić `fight`: wynik jest policzony
    // wyżej i od tej linii jest już tylko przekazywany dalej.
    const [standings, tracked] = await Promise.all([
      settle(tokenA, tokenB, fight, searchParams.get('record') !== '0'),
      trackedWallets(tokenA, tokenB),
    ])

    return NextResponse.json(
      {
        network: { id: networkId },
        tokenA,
        tokenB,
        // Walka między kategoriami dostaje widoczne oznaczenie — front musi
        // wiedzieć, że lżejszy bije powyżej swojej wagi (CLAUDE.md).
        matchup: matchup(tokenA.weightClass, tokenB.weightClass),
        fight,
        standings,
        tracked,
      },
      { headers: limitHeaders },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502, headers: limitHeaders },
    )
  }
}

/** Bilans obu kontraktów po dopisaniu tej walki. */
export interface Standings {
  /** `false`, gdy ta walka była już w rankingu — wtedy nic nie doszło. */
  recorded: boolean
  /**
   * Czemu nic nie doszło: `duplicate` — ta para już walczyła, `cancelled` —
   * obaj nie przeszli badań, więc nie było walki do zapisania.
   */
  reason: 'duplicate' | 'cancelled' | null
  /** `false`, gdy ranking stoi na pamięci procesu i zginie przy restarcie. */
  persistent: boolean
  a: TokenRecord | null
  b: TokenRecord | null
}

/**
 * Zapisuje wynik i odczytuje bilans obu kontraktów.
 *
 * Ranking nie może przewrócić walki: gdy bazy nie ma albo nie odpowiada,
 * wracamy z `null` i front pokazuje walkę bez bilansu. Wynik jest już
 * policzony — nie ma powodu, żeby użytkownik go nie zobaczył.
 */
async function settle(
  tokenA: Awaited<ReturnType<typeof fetchTokenFightData>>,
  tokenB: Awaited<ReturnType<typeof fetchTokenFightData>>,
  fight: ReturnType<typeof simulateFight>,
  record: boolean,
): Promise<Standings | null> {
  if (!record) return null

  try {
    const outcome = await recordFight(tokenA, tokenB, fight)
    const [a, b] = await Promise.all([
      readRecord(tokenA.networkId, tokenA.address),
      readRecord(tokenB.networkId, tokenB.address),
    ])
    return {
      recorded: outcome.recorded,
      reason: outcome.reason,
      persistent: outcome.persistent,
      a,
      b,
    }
  } catch {
    return null
  }
}
