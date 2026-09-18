/**
 * Obserwowane portfele: ile adresów z prywatnej listy trzyma danego tokena.
 *
 * Lista żyje **wyłącznie po stronie serwera**, w zmiennej `TRACKED_WALLETS`.
 * Nie ma jej w repozytorium, nie ma jej w paczce przeglądarki i nie wychodzi
 * w odpowiedzi API. Na zewnątrz idzie jedna liczba na zawodnika — ile adresów
 * z listy ma niezerowe saldo. Nigdy który adres.
 *
 * Dlatego ten moduł nie może zostać zaimportowany przez `page.tsx` nawet jako
 * typ wykonywalny: typ odpowiedzi siedzi w `fight-response.ts`, a cała reszta
 * zostaje na serwerze. Tak samo jak `CODEX_API_KEY` w `codex.ts`.
 *
 * Liczba jest **ozdobą, nie mechaniką**. Nie wchodzi do statystyk, do symulacji,
 * do snapshotu rankingu ani do promptu komentatorów. Walka wychodzi identycznie
 * z listą i bez niej — a musi, bo lista jest lokalna i zmienna, więc wynik
 * policzony z jej udziałem przestałby być odtwarzalny (CLAUDE.md § Determinizm).
 *
 * Czym ta liczba **nie jest**: sygnałem. Portfel na liście jest tam, bo ktoś go
 * tam wpisał, nie bo cokolwiek udowodnił. Nie oznaczamy tych portfeli jako
 * „smart money" ani „alfa" — portfel z serią trafień to najczęściej szczęściarz
 * widoczny właśnie dlatego, że trafił (CLAUDE.md § Narożnik: holderzy).
 *
 * Znane ograniczenie — sondowanie listy. Kto kontroluje własny token, może
 * wysłać pył na wybrany adres, rozegrać walkę i z tego, czy licznik podskoczył,
 * wywnioskować, że ten adres jest na liście. Powtórzone dla wielu kandydatów
 * odtwarza listę adres po adresie. Sama liczba tego nie zdradza, ale różnica
 * między dwoma zapytaniami już tak. Dlatego trasa `/api/fight` ma limit zapytań
 * na IP — on podnosi koszt takiego sondowania, ale go nie usuwa. Jeśli lista
 * ma być tajna wobec zdeterminowanego przeciwnika, a nie tylko wobec ciekawego
 * użytkownika, licznik trzeba schować za logowaniem.
 */

/* ------------------------------------------------------------------ */
/* Lista                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ile adresów najwyżej wchodzi z listy.
 *
 * Każdy adres to jedno wywołanie `balanceOf` na token, czyli dwa na walkę.
 * Bez górnej granicy wklejenie tysiąca adresów zamienia jedną walkę w dwa
 * tysiące zapytań do Alchemy i minutę oczekiwania w ścieżce krytycznej.
 */
export const MAX_TRACKED_WALLETS = 250

// Prefiks też wielkimi literami: adres skopiowany z eksploratora bywa
// `0X…`, a odrzucenie go byłoby cichym skróceniem listy.
const ADDRESS = /^0[xX][0-9a-fA-F]{40}$/

export interface TrackedList {
  /** Adresy z listy: małymi literami, bez powtórzeń, w kolejności wpisania. */
  wallets: string[]
  /** Ile wpisów odrzucono, bo nie były adresem. Sam licznik — nigdy treść. */
  dropped: number
  /** Ile adresów ucięto po przekroczeniu `MAX_TRACKED_WALLETS`. */
  truncated: number
}

/**
 * Parsowanie `TRACKED_WALLETS`. Rozdzielane przecinkiem, spacją albo nową
 * linią, żeby dało się wkleić listę w dowolnym z trzech kształtów, w jakich
 * ludzie trzymają adresy.
 *
 * Odrzucone wpisy są tylko liczone. Wpis, który nie przeszedł walidacji, bywa
 * adresem z literówką — przepisanie go do odpowiedzi albo do logu wyniosłoby
 * na zewnątrz kawałek listy, której cały sens jest w tym, że nie wychodzi.
 */
export function parseTrackedWallets(raw: string | undefined | null): TrackedList {
  const seen = new Set<string>()
  let dropped = 0

  for (const entry of (raw ?? '').split(/[\s,;]+/)) {
    if (entry.length === 0) continue
    if (!ADDRESS.test(entry)) {
      dropped++
      continue
    }
    seen.add(entry.toLowerCase())
  }

  const all = [...seen]
  return {
    wallets: all.slice(0, MAX_TRACKED_WALLETS),
    dropped,
    truncated: Math.max(0, all.length - MAX_TRACKED_WALLETS),
  }
}

/* ------------------------------------------------------------------ */
/* Wywołanie na łańcuchu                                               */
/* ------------------------------------------------------------------ */

/** Selektor `balanceOf(address)` — pierwsze cztery bajty keccaka z sygnatury. */
const BALANCE_OF = '0x70a08231'

/**
 * Dane wywołania `balanceOf(wallet)`: selektor i adres dopełniony do 32 bajtów.
 *
 * Standardowy `eth_call`, nie metoda rozszerzona Alchemy. Alchemy ma na to
 * `alchemy_getTokenBalances`, ale ta metoda istnieje tylko na sieciach, które
 * Alchemy wspiera w pełni — a domyślną siecią projektu jest Robinhood Chain.
 * `eth_call` działa na każdym RPC zgodnym z EVM, więc jeśli Alchemy tej sieci
 * nie wystawia, wystarczy wskazać w tej samej zmiennej dowolny inny RPC.
 */
export function balanceOfCallData(wallet: string): string {
  return BALANCE_OF + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/**
 * Czy zwrócone saldo jest niezerowe.
 *
 * `null` znaczy „nie wiem": puste `0x` (adres nie jest kontraktem ERC-20) albo
 * coś, co nie jest liczbą szesnastkową. Takiego wyniku nie wolno policzyć jako
 * zera, bo zero jest twierdzeniem — a my wtedy nic nie wiemy.
 */
export function holdsBalance(result: unknown): boolean | null {
  if (typeof result !== 'string') return null
  if (!/^0x[0-9a-fA-F]+$/.test(result)) return null
  // Wystarczy jedna cyfra różna od zera. Bez `BigInt`, bo projekt celuje
  // w ES2017 — i bez potrzeby, bo pytanie jest tylko o „czy niezerowe",
  // a saldo uint256 nie mieści się w `number`.
  return /[1-9a-fA-F]/.test(result.slice(2))
}

/**
 * RPC dla konkretnej sieci: `ALCHEMY_RPC_URL_<networkId>`, np.
 * `ALCHEMY_RPC_URL_4663` dla Robinhood Chain.
 *
 * Nazwa z numerem sieci, a nie jedna wspólna `ALCHEMY_RPC_URL`: URL od Alchemy
 * ma sieć wpisaną w hosta, więc jedna zmienna dla wszystkich sieci znaczy, że
 * przy `?network=` innym niż ten wpisany po cichu pytamy nie o ten łańcuch
 * i dostajemy wiarygodnie wyglądające zero.
 *
 * Klucz siedzi w tym URL-u, więc zmienna nigdy nie wychodzi do przeglądarki
 * ani do odpowiedzi API — na zewnątrz idzie najwyżej jej nazwa.
 */
export function rpcUrlEnvName(networkId: number): string {
  return `ALCHEMY_RPC_URL_${networkId}`
}

/**
 * Ile wywołań leci w jednej paczce JSON-RPC.
 *
 * Paczkowanie jest po to, żeby 250 adresów nie było 250 okrążeniami sieci.
 * Czterdzieści, a nie wszystko naraz: bramy RPC mają własne limity na rozmiar
 * paczki, a przekroczony limit wywraca całą paczkę, nie pojedyncze wywołanie.
 */
const BATCH_SIZE = 40

/** Ile czekamy na jedną paczkę. Liczba jest ozdobą — nie może trzymać walki. */
const TIMEOUT_MS = 8_000

interface BatchEntry {
  id: number
  result?: unknown
  error?: { message?: string }
}

/**
 * Ile adresów z listy trzyma ten token.
 *
 * Wywołania idą paczkami, po `BATCH_SIZE`. Wynik jest liczbą tylko wtedy, gdy
 * **każde** wywołanie wróciło z czytelnym saldem: jedno nieudane znaczy, że
 * licznik byłby zaniżony o nieznaną wartość, a zaniżona liczba wygląda dokładnie
 * tak samo jak prawdziwa. Wtedy wraca `null` i narożnik pokazuje kreskę.
 */
async function countHolding(
  rpcUrl: string,
  tokenAddress: string,
  wallets: readonly string[],
): Promise<{ holding: number } | { error: string }> {
  let holding = 0

  for (let start = 0; start < wallets.length; start += BATCH_SIZE) {
    const chunk = wallets.slice(start, start + BATCH_SIZE)
    const body = chunk.map((wallet, i) => ({
      jsonrpc: '2.0',
      id: start + i,
      method: 'eth_call',
      params: [{ to: tokenAddress, data: balanceOfCallData(wallet) }, 'latest'],
    }))

    let payload: unknown
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        // Bez treści odpowiedzi: przy błędnym URL-u bywa w niej klucz.
        return { error: `RPC returned ${response.status}.` }
      }
      payload = await response.json()
    } catch {
      return { error: 'RPC did not answer in time.' }
    }

    // Paczka wraca tablicą; pojedyncze wywołanie — obiektem. Bramy trzymają
    // się tego niejednakowo, więc przyjmujemy oba kształty.
    const entries: BatchEntry[] = Array.isArray(payload)
      ? (payload as BatchEntry[])
      : [payload as BatchEntry]

    if (entries.length !== chunk.length) {
      return { error: 'RPC answered a different number of calls than asked.' }
    }

    for (const entry of entries) {
      if (entry?.error) return { error: 'RPC rejected a balance call.' }
      const holds = holdsBalance(entry?.result)
      if (holds === null) return { error: 'RPC returned an unreadable balance.' }
      if (holds) holding++
    }
  }

  return { holding }
}

/* ------------------------------------------------------------------ */
/* Wyjście                                                            */
/* ------------------------------------------------------------------ */

/**
 * To, co widzi front. Same liczby — ani jednego adresu, ani listy, ani klucza.
 */
export interface TrackedWallets {
  /** Czy lista jest ustawiona po stronie serwera. */
  configured: boolean
  /** Ile adresów jest na liście. Liczba, nie adresy. */
  watched: number
  /** Ile adresów z listy trzyma tokena z czerwonego narożnika. */
  a: number | null
  /** To samo dla niebieskiego. */
  b: number | null
  /** Czemu nie ma liczby, albo czego brakuje w konfiguracji. Nigdy adresu. */
  note: string | null
}

const UNCONFIGURED: TrackedWallets = {
  configured: false,
  watched: 0,
  a: null,
  b: null,
  note: null,
}

export interface TrackedToken {
  address: string
  networkId: number
}

/**
 * Licznik obserwowanych portfeli dla obu zawodników.
 *
 * Nigdy nie rzuca. Brak listy, brak RPC, padnięta brama — wszystko wraca jako
 * `null` z notatką, a walka idzie dalej. Wynik jest już policzony z danych
 * Codexu; nie ma powodu, żeby użytkownik go nie zobaczył z powodu ozdoby.
 */
export async function trackedWallets(
  a: TrackedToken,
  b: TrackedToken,
): Promise<TrackedWallets> {
  const list = parseTrackedWallets(process.env.TRACKED_WALLETS)

  // Zmiennej nie ma albo nie ma w niej ani jednego adresu — narożnik nie
  // pokazuje wtedy nic. Pusta lista to nie „zero trafień", to brak listy.
  if (list.wallets.length === 0) {
    if (list.dropped > 0) {
      console.warn(`[tracked] TRACKED_WALLETS: ${list.dropped} wpisów nie jest adresem`)
    }
    return UNCONFIGURED
  }
  if (list.dropped > 0 || list.truncated > 0) {
    console.warn(
      `[tracked] TRACKED_WALLETS: ${list.wallets.length} adresów w użyciu, ` +
        `${list.dropped} odrzuconych, ${list.truncated} uciętych ponad limit ${MAX_TRACKED_WALLETS}`,
    )
  }

  const base: TrackedWallets = {
    configured: true,
    watched: list.wallets.length,
    a: null,
    b: null,
    note: null,
  }

  const missing = [a.networkId, b.networkId]
    .filter((id, i, all) => all.indexOf(id) === i)
    .filter((id) => !process.env[rpcUrlEnvName(id)])
  if (missing.length > 0) {
    return { ...base, note: `Set ${missing.map(rpcUrlEnvName).join(' and ')} to check balances.` }
  }

  const [countA, countB] = await Promise.all([
    countHolding(process.env[rpcUrlEnvName(a.networkId)]!, a.address, list.wallets),
    countHolding(process.env[rpcUrlEnvName(b.networkId)]!, b.address, list.wallets),
  ])

  const failure = 'error' in countA ? countA.error : 'error' in countB ? countB.error : null
  if (failure) console.warn('[tracked] nie udało się policzyć obserwowanych portfeli:', failure)

  return {
    ...base,
    a: 'holding' in countA ? countA.holding : null,
    b: 'holding' in countB ? countB.holding : null,
    note: failure,
  }
}
