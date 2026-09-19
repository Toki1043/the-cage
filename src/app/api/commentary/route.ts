import { NextRequest, NextResponse } from 'next/server'
import {
  COMMENTARY_MAX_TOKENS,
  cleanFighter,
  cleanRounds,
  commentaryMessages,
  type CommentaryErrorCode,
  type CommentaryEvent,
  type CommentaryRequest,
} from '@/lib/commentary'
import { runVoices, type VoiceSource } from '@/lib/commentary-run'
import { COMMENTARY_VOICES, type CommentaryVoice } from '@/lib/commentary-voices'
import { PER_IP_LIMIT, clientIp, rateLimit, rateLimitHeaders } from '@/lib/rate-limit'

// Typy, które front importuje stąd od początku. Logika mieszka w `lib/commentary`:
// plik trasy w Next powinien eksportować wyłącznie handlery.
export type {
  CommentaryErrorCode,
  CommentaryEvent,
  CommentaryFighterInput,
  CommentaryLine,
  CommentaryRequest,
  CommentaryRoundInput,
} from '@/lib/commentary'

/**
 * POST /api/commentary
 *
 * Komentarz do walki. Zastępuje `window.claude.use("sample")` z prototypu —
 * to była funkcja środowiska artefaktów claude.ai i na Vercelu nie istnieje
 * (CLAUDE.md § Uwaga o prototypie).
 *
 * Komentatorów jest dwóch, każdy na innym modelu u innego dostawcy (patrz
 * `VOICE_MODELS` w `openrouter.ts`): przy ringu i barwny. Trasa wysyła oba
 * zapytania **równolegle** i skleja ich strumienie w jeden.
 *
 * Odpowiedź to **strumień NDJSON**, nie jeden JSON. Każdy model pisze trzy rundy
 * po kolei, więc pierwsza jest gotowa po ułamku czasu całości — trasa wysyła ją
 * w chwili, gdy domknie się jej obiekt, a front dokleja ją do walki, która już
 * trwa. Głosy nie czekają na siebie.
 *
 * Padnięcie jednego głosu nie wywraca walki ani drugiego głosu:
 *  - błąd przed pierwszym tokenem jednego głosu → zdarzenie `voice_error` na
 *    początku strumienia, drugi mówi dalej;
 *  - błąd w trakcie albo przekroczony czas jednego głosu → `voice_error`,
 *    kwestie, które już doszły, zostają;
 *  - dopiero gdy nie odpowiedział żaden (albo żaden nie powiedział nic), wraca
 *    zwykły JSON ze statusem HTTP (przed strumieniem) albo zdarzenie `error`.
 *
 * Trasa ma ten sam limit zapytań na IP co `/api/fight` (`PER_IP_LIMIT`), we
 * własnym wiadrze. Jedno zapytanie do trasy to dwa wywołania modeli; limit
 * chroni koszt obu, a trasa jest publiczna i przyjmuje dowolny ładunek — bez
 * niego wystarczyłaby pętla `curl`, żeby wyczerpać kredyt. Przy przekroczeniu
 * wraca 429 z `Retry-After`.
 *
 * Modele widzą wyłącznie policzone liczby i nigdy wyniku walki; szczegóły
 * w `lib/commentary.ts`. Werdykt składa front szablonem (CLAUDE.md § Zasada nadrzędna).
 */

/**
 * Ile czekamy na otwarcie strumienia jednego głosu (nagłówki odpowiedzi) i ile
 * może trwać cała jego odpowiedź. Zmierzone: pierwszy token po 1–2 s, całość
 * po 2–5 s. Bez sufitu zawieszony model trzymałby otwarte połączenie, a walka
 * dawno by się skończyła.
 */
const VOICE_START_TIMEOUT_MS = 10_000
const VOICE_TOTAL_TIMEOUT_MS = 25_000

function fail(code: CommentaryErrorCode, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error: code }, { status, headers })
}

/** Kod błędu dla frontu z wyjątku SDK. Log po stronie serwera: front dostaje sam kod. */
function codeFor(error: unknown): { code: CommentaryErrorCode; status: number } {
  const status = (error as { status?: number })?.status
  if (status === 429) return { code: 'rate_limited', status: 429 }
  if (status === 401 || status === 403) return { code: 'not_authorized', status: 502 }
  return { code: 'upstream', status: 502 }
}

export async function POST(request: NextRequest) {
  // Limit przed czymkolwiek innym: przed odczytem ciała, przed sanityzacją i
  // przed wywołaniem modelu. Liczy się każde zapytanie, także z błędnym
  // ładunkiem — inaczej pętla wysyłająca śmieci byłaby darmowa, a limit
  // chroni koszt modelu, nie tylko poprawne walki.
  const verdict = await rateLimit('commentary', clientIp(request.headers), PER_IP_LIMIT)
  const limitHeaders = rateLimitHeaders(verdict)
  if (!verdict.ok) return fail('rate_limited', 429, limitHeaders)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('bad_request', 400, limitHeaders)
  }

  const payload = (body ?? {}) as Partial<CommentaryRequest>
  const rounds = cleanRounds(payload.rounds)
  if (rounds.length === 0) return fail('bad_request', 400, limitHeaders)

  const a = cleanFighter(payload.a)
  const b = cleanFighter(payload.b)

  // Brak klucza to nie awaria: walka i tak się odbywa, tylko bez komentarza.
  // Sprawdzamy przed importem, bo `openrouter.ts` rzuca już przy wczytaniu
  // modułu — dlatego import jest dynamiczny, a nie na górze pliku.
  if (!process.env.OPENAI_API_KEY) return fail('not_configured', 503, limitHeaders)

  const { openrouter, VOICE_MODELS } = await import('@/lib/openrouter')
  const models = {
    call: VOICE_MODELS.call.model,
    colour: VOICE_MODELS.colour.model,
  }
  // Dwa głosy na jednym modelu to nie dwa głosy, a nagłówek strony twierdzi, że
  // modeli jest dwa (`lib/orbio-stack.ts`).
  if (models.call === models.colour) {
    console.warn('[commentary] oba głosy na tym samym modelu:', models.call)
  }

  // Oba strumienie startują naraz. `allSettled`: odmowa jednego nie przerywa
  // drugiego, tylko trafia do `startErrors`.
  const prompts = commentaryMessages(a, b, rounds)
  const opened = await Promise.allSettled(
    prompts.map(({ voice, messages }) =>
      openrouter.chat.completions.create(
        {
          model: VOICE_MODELS[voice].model,
          max_tokens: COMMENTARY_MAX_TOKENS,
          stream: true,
          messages,
          ...VOICE_MODELS[voice].params,
        } as never,
        { timeout: VOICE_START_TIMEOUT_MS, maxRetries: 0 },
      ),
    ),
  )

  type Upstream = Awaited<ReturnType<typeof openrouter.chat.completions.create>> & {
    controller: AbortController
  }
  const upstreams: Partial<Record<CommentaryVoice, Upstream>> = {}
  const startErrors: Partial<Record<CommentaryVoice, CommentaryErrorCode>> = {}
  let firstStartFailure: { code: CommentaryErrorCode; status: number } | null = null

  prompts.forEach(({ voice }, i) => {
    const result = opened[i]
    if (result.status === 'fulfilled') {
      upstreams[voice] = result.value as unknown as Upstream
    } else {
      const mapped = codeFor(result.reason)
      startErrors[voice] = mapped.code
      firstStartFailure ??= mapped
      console.error(
        `[commentary] Orbio odrzuciło głos ${voice} (${VOICE_MODELS[voice].model})`,
        (result.reason as { status?: number })?.status ?? '',
        result.reason,
      )
    }
  })

  // Żaden głos się nie otworzył: to samo co dawniej przy jednym modelu — zwykły
  // JSON ze statusem, jeszcze przed strumieniem.
  if (Object.keys(upstreams).length === 0) {
    const { code, status } = firstStartFailure ?? { code: 'upstream' as const, status: 502 }
    return fail(code, status, limitHeaders)
  }

  const encoder = new TextEncoder()
  // Klient odszedł. Po tym strumień jest zamknięty i każde `enqueue`/`close`
  // rzuca, więc wszystko poniżej sprawdza tę flagę, zamiast łapać wyjątki.
  let cancelled = false
  const timers: ReturnType<typeof setTimeout>[] = []
  const abortAll = () => {
    for (const timer of timers) clearTimeout(timer)
    for (const voice of COMMENTARY_VOICES) upstreams[voice]?.controller.abort()
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CommentaryEvent) => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      }

      // Sufit czasu na cały głos: po nim przerywamy tylko jego wywołanie, a
      // `runVoices` zgłasza go jako padniętego i nie rusza drugiego.
      const sources: Partial<Record<CommentaryVoice, VoiceSource>> = {}
      for (const voice of COMMENTARY_VOICES) {
        const upstream = upstreams[voice]
        if (!upstream) continue
        timers.push(setTimeout(() => upstream.controller.abort(), VOICE_TOTAL_TIMEOUT_MS))
        sources[voice] = deltas(upstream as unknown as AsyncIterable<{ choices: { delta?: { content?: string | null } }[] }>)
      }

      try {
        await runVoices({
          sources,
          startErrors,
          expected: rounds.length,
          models,
          send,
          isCancelled: () => cancelled,
          onError: (voice, error) =>
            console.error(`[commentary] strumień głosu ${voice} przerwany`, error),
        })
      } finally {
        for (const timer of timers) clearTimeout(timer)
        if (!cancelled) controller.close()
      }
    },

    // Klient odszedł (koniec walki, nowa walka, zamknięta karta): przerywamy
    // wywołania obu modeli, żeby nie płacić za tokeny, których nikt nie przeczyta.
    cancel() {
      cancelled = true
      abortAll()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      // Bez buforowania po drodze: całe zyskanie z streamingu ginie, jeśli
      // proxy trzyma odpowiedź do końca.
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      ...limitHeaders,
    },
  })
}

/** Kawałki `delta.content` ze strumienia SDK jako zwykły strumień tekstu. */
async function* deltas(
  upstream: AsyncIterable<{ choices: { delta?: { content?: string | null } }[] }>,
): AsyncGenerator<string> {
  for await (const chunk of upstream) {
    const piece = chunk.choices[0]?.delta?.content
    if (piece) yield piece
  }
}
