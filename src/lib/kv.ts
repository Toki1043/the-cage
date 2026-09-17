/**
 * Minimalny klient Redisa przez REST — Vercel KV albo Upstash, ten sam
 * protokół. Tylko te komendy, których używa ranking.
 *
 * Bez paczki `@upstash/redis`: potrzebne są cztery komendy, a każda kolejna
 * zależność to kolejna rzecz, która może się zepsuć w Build Week.
 *
 * Zmienne: `KV_REST_API_URL` / `KV_REST_API_TOKEN` (tak nazywa je Vercel KV)
 * albo `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (tak nazywa je
 * Upstash wprost). Token żyje wyłącznie po stronie serwera.
 *
 * Bez tych zmiennych wchodzi magazyn w pamięci procesu — lokalnie pozwala
 * klikać ranking bez zakładania bazy, ale ginie przy restarcie i nie jest
 * wspólny między instancjami. Dlatego `isPersistent()` mówi wprost, co jest
 * pod spodem, a odpowiedź API przekazuje to dalej.
 */

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null

/** Czy pod spodem jest realna baza, czy pamięć procesu. */
export function isPersistent(): boolean {
  return Boolean(url && token)
}

type Command = (string | number)[]

/**
 * Paczka komend w jednym wywołaniu REST. Upstash zwraca tablicę wyników
 * w kolejności komend; błąd jednej nie przewraca pozostałych, więc każdy
 * wynik sprawdzamy osobno.
 */
async function pipeline(commands: Command[]): Promise<unknown[]> {
  if (commands.length === 0) return []
  if (!url || !token) return memoryPipeline(commands)

  const response = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error('KV ' + response.status + ': ' + (await response.text()).slice(0, 200))
  }

  const payload = (await response.json()) as { result?: unknown; error?: string }[]
  return payload.map((entry) => {
    if (entry?.error) throw new Error('KV: ' + entry.error)
    return entry?.result ?? null
  })
}

/* ------------------------------------------------------------------ */
/* Komendy używane przez ranking                                       */
/* ------------------------------------------------------------------ */

/** GET z odpakowaniem JSON. `null`, gdy klucza nie ma albo nie da się sparsować. */
export async function getJson<T>(key: string): Promise<T | null> {
  const [raw] = await pipeline([['GET', key]])
  return parse<T>(raw)
}

/** MGET — jedno wywołanie na całą stronę rankingu, nie jedno na token. */
export async function mgetJson<T>(keys: string[]): Promise<(T | null)[]> {
  if (keys.length === 0) return []
  const [raw] = await pipeline([['MGET', ...keys]])
  return (Array.isArray(raw) ? raw : []).map((entry) => parse<T>(entry))
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await pipeline([['SET', key, JSON.stringify(value)]])
}

/**
 * SET NX — zapisuje tylko wtedy, gdy klucza jeszcze nie było, i mówi czy
 * zapisał. Na tym stoi idempotencja rankingu: ta sama walka policzona drugi
 * raz nie może dopisać drugiego zwycięstwa.
 */
export async function setIfAbsent(key: string, value: unknown): Promise<boolean> {
  const [result] = await pipeline([['SET', key, JSON.stringify(value), 'NX']])
  return result !== null
}

export async function zadd(key: string, score: number, member: string): Promise<void> {
  await pipeline([['ZADD', key, score, member]])
}

/** Token, który zmienił kategorię wagową, musi zejść ze starej listy. */
export async function zrem(key: string, member: string): Promise<void> {
  await pipeline([['ZREM', key, member]])
}

/** Najwyższe wyniki najpierw. */
export async function ztop(key: string, limit: number): Promise<string[]> {
  const [raw] = await pipeline([['ZRANGE', key, 0, Math.max(0, limit - 1), 'REV']])
  return Array.isArray(raw) ? raw.map(String) : []
}

export async function zcard(key: string): Promise<number> {
  const [raw] = await pipeline([['ZCARD', key]])
  return typeof raw === 'number' ? raw : Number(raw ?? 0)
}

/** Upstash zwraca stringi; w magazynie pamięciowym leżą już obiekty. */
function parse<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Magazyn zapasowy: pamięć procesu                                    */
/* ------------------------------------------------------------------ */

/**
 * Tyle Redisa, ile potrzebuje ranking, w dwóch mapach.
 *
 * Trzymamy tu dokładnie to samo co poleciałoby do Upstasha — stringi JSON,
 * nie obiekty — żeby ścieżka bez bazy zachowywała się jak ta z bazą i nie
 * ukrywała błędów serializacji do czasu wdrożenia.
 *
 * Mapy wiszą na `globalThis`: w `next dev` moduły przeładowują się przy
 * każdej zmianie pliku, a zwykła zmienna modułowa gubiłaby przy tym ranking.
 */
const memory = ((globalThis as Record<string, unknown>).__cageKv ??= {
  strings: new Map<string, string>(),
  zsets: new Map<string, Map<string, number>>(),
}) as { strings: Map<string, string>; zsets: Map<string, Map<string, number>> }

function memoryPipeline(commands: Command[]): unknown[] {
  return commands.map((command) => {
    const [name, key, ...rest] = command.map(String) as [string, string, ...string[]]

    switch (name.toUpperCase()) {
      case 'GET':
        return memory.strings.get(key) ?? null

      case 'MGET':
        return [key, ...rest].map((k) => memory.strings.get(k) ?? null)

      case 'SET': {
        const [value, flag] = rest
        if (flag?.toUpperCase() === 'NX' && memory.strings.has(key)) return null
        memory.strings.set(key, value)
        return 'OK'
      }

      case 'ZADD': {
        const [score, member] = rest
        const set = memory.zsets.get(key) ?? new Map<string, number>()
        const fresh = !set.has(member)
        set.set(member, Number(score))
        memory.zsets.set(key, set)
        return fresh ? 1 : 0
      }

      case 'ZRANGE': {
        const [start, stop] = rest
        const reversed = rest.some((r) => r.toUpperCase() === 'REV')
        const entries = [...(memory.zsets.get(key) ?? new Map())]
        // Przy równych wynikach Redis sortuje po członie leksykograficznie,
        // a przy REV odwraca całość — stąd ta sama kolejność co w bazie.
        entries.sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]))
        if (reversed) entries.reverse()
        const end = Number(stop) < 0 ? entries.length + Number(stop) + 1 : Number(stop) + 1
        return entries.slice(Number(start), end).map(([member]) => member)
      }

      case 'ZREM': {
        memory.zsets.get(key)?.delete(rest[0])
        return 1
      }

      case 'ZCARD':
        return memory.zsets.get(key)?.size ?? 0

      default:
        throw new Error('Magazyn pamięciowy nie zna komendy ' + name)
    }
  })
}
