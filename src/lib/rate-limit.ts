/**
 * Limit zapytań na IP.
 *
 * Okno stałe, nie przesuwne: klucz zawiera numer okna (`floor(teraz / okno)`),
 * więc licznik nie wymaga czyszczenia — po upływie okna klucz po prostu wygasa.
 * Przesuwne okno byłoby dokładniejsze na granicy, ale wymaga trzymania znaczników
 * czasu każdego zapytania. Przy limicie liczonym w dziesiątkach na minutę ta
 * dokładność nic nie zmienia, a kosztuje znacznie więcej pamięci w bazie.
 *
 * Licznik idzie do tego samego magazynu co ranking (`kv.ts`): Upstash, jeśli
 * jest skonfigurowany, inaczej pamięć procesu. Bez bazy limit jest liczony per
 * instancja — na Vercelu instancji jest kilka i każda ma własny licznik, więc
 * realny próg jest wielokrotnością tego, co tu wpisane. `shared` mówi wprost,
 * co jest pod spodem, żeby nikt nie uznał limitu za mocniejszy niż jest.
 *
 * Po co on tu jest. Po pierwsze: jedna walka to dziesięć zapytań do Codexu,
 * a darmowy próg to 10 000 miesięcznie — kilka odświeżeń w pętli wyczerpuje
 * budżet na resztę tygodnia. Po drugie: licznik obserwowanych portfeli da się
 * sondować (patrz `tracked.ts`), a sondowanie wymaga wielu zapytań pod rząd.
 * Limit podnosi jego koszt.
 */

import { incrementWithTtl, isPersistent } from './kv.ts'

export interface RateLimitVerdict {
  /** `false` znaczy 429. */
  ok: boolean
  limit: number
  /** Ile zapytań zostało w tym oknie. */
  remaining: number
  /** Sekundy do otwarcia następnego okna — idzie do nagłówka `Retry-After`. */
  retryAfter: number
  /** Czy licznik jest wspólny między instancjami, czy per proces. */
  shared: boolean
}

/**
 * IP klienta z nagłówków.
 *
 * `x-forwarded-for` jest wpisywany przez klienta i można w nim napisać
 * cokolwiek — **ale** proxy Vercela nadpisuje go własnym łańcuchem, więc za
 * tym proxy pierwszy wpis jest prawdziwym adresem. Uruchomione bez takiego
 * proxy (goły `next start` wystawiony na świat) limit na IP da się obejść
 * podmianą nagłówka; wtedy potrzebny jest limit warstwę niżej.
 *
 * Lokalnie żadnego z tych nagłówków nie ma i wszystkie zapytania wpadają do
 * jednego wiadra `local`. Tak ma być: w `next dev` i tak jest jeden klient,
 * a dzięki temu limit da się przetestować bez udawania nagłówków.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const candidate = forwarded || headers.get('x-real-ip')?.trim() || ''
  // Ucięte, bo z nagłówka może przyjść dowolnie długi ciąg, a leci on do
  // klucza w bazie. Tylko znaki, jakie mają adresy IPv4 i IPv6.
  const cleaned = candidate.replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45)
  return cleaned || 'local'
}

/**
 * Limit na IP dla tras, które kosztują pieniądze albo darmowy budżet API:
 * dziesięć zapytań na minutę.
 *
 * Jedna definicja dla `/api/fight` (Codex) i `/api/commentary` (model), żeby
 * „taki sam limit" nie rozjechał się przy pierwszej zmianie jednego z nich.
 * Każda trasa liczy we **własnym wiadrze** (pierwszy argument `rateLimit`):
 * jedna walka to jedno wywołanie każdej z nich, więc wspólny licznik
 * zjadałby dwa zapytania na walkę i realny limit spadłby do pięciu walk
 * na minutę.
 */
export const PER_IP_LIMIT = { limit: 10, windowSeconds: 60 } as const

export interface RateLimitOptions {
  /** Ile zapytań na okno. */
  limit: number
  /** Długość okna w sekundach. */
  windowSeconds: number
  /**
   * „Teraz" w milisekundach. Wyłącznie po to, żeby kontrola mogła przejść
   * przez granicę okna bez czekania — trasa tego nie podaje.
   */
  nowMs?: number
}

/**
 * Zlicza jedno zapytanie i mówi, czy je przepuścić.
 *
 * Przy padniętej bazie **przepuszcza**. Limit jest ochroną budżetu API, nie
 * bramką bezpieczeństwa — zamknięcie walki dla wszystkich, bo nie odpowiada
 * Redis, byłoby gorszym awarią niż ta, przed którą limit chroni.
 */
export async function rateLimit(
  bucket: string,
  ip: string,
  { limit, windowSeconds, nowMs }: RateLimitOptions,
): Promise<RateLimitVerdict> {
  const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1_000)
  const window = Math.floor(nowSeconds / windowSeconds)
  const retryAfter = windowSeconds - (nowSeconds % windowSeconds)
  const shared = isPersistent()

  let used: number
  try {
    used = await incrementWithTtl(`rl:${bucket}:${window}:${ip}`, windowSeconds)
  } catch (error) {
    console.error('[rate-limit] licznik niedostępny, przepuszczam', error)
    return { ok: true, limit, remaining: limit, retryAfter, shared }
  }

  return {
    ok: used <= limit,
    limit,
    remaining: Math.max(0, limit - used),
    retryAfter,
    shared,
  }
}

/**
 * Nagłówki limitu. `RateLimit-*` bez prefiksu `X-`, tak jak w szkicu IETF,
 * i `Retry-After` tylko przy odmowie — wysłany przy przepuszczonym zapytaniu
 * mówiłby klientowi, żeby czekał bez powodu.
 */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(verdict.limit),
    'RateLimit-Remaining': String(verdict.remaining),
    'RateLimit-Reset': String(verdict.retryAfter),
  }
  if (!verdict.ok) headers['Retry-After'] = String(verdict.retryAfter)
  return headers
}
