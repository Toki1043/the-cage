import { NextRequest, NextResponse } from 'next/server'
import {
  COMMENTARY_MAX_TOKENS,
  cleanFighter,
  cleanRounds,
  commentaryMessages,
  completedRoundObjects,
  parseModelJson,
  toLine,
  type CommentaryErrorCode,
  type CommentaryEvent,
  type CommentaryLine,
  type CommentaryRequest,
} from '@/lib/commentary'
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
 * Odpowiedź to **strumień NDJSON**, nie jeden JSON. Model pisze trzy rundy po
 * kolei, więc pierwsza jest gotowa po ułamku czasu całości — trasa wysyła ją
 * w chwili, gdy domknie się jej obiekt, a front dokleja ją do walki, która już
 * trwa. Wcześniej trasa czekała na całą odpowiedź (6–7 s) i front czekał na
 * trasę, zanim ruszył pierwszy gong.
 *
 * Błędy, które da się wykryć przed pierwszym tokenem (zły ładunek, brak klucza,
 * odmowa pośrednika), wracają jako zwykły JSON ze statusem HTTP. Błąd w trakcie
 * strumienia to zdarzenie `error` — rundy, które już doszły, zostają.
 *
 * Trasa ma ten sam limit zapytań na IP co `/api/fight` (`PER_IP_LIMIT`), we
 * własnym wiadrze. Każde wywołanie kosztuje za model, a trasa jest publiczna
 * i przyjmuje dowolny ładunek — bez limitu wystarczyłaby pętla `curl`, żeby
 * wyczerpać kredyt. Przy przekroczeniu wraca 429 z `Retry-After`.
 *
 * Model widzi wyłącznie policzone liczby i nigdy wyniku walki; szczegóły
 * w `lib/commentary.ts`. Werdykt składa front szablonem (CLAUDE.md § Zasada nadrzędna).
 */

function fail(code: CommentaryErrorCode, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error: code }, { status, headers })
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

  let model: string
  let upstream: Awaited<ReturnType<typeof startStream>>
  try {
    const { openrouter, DEFAULT_MODEL } = await import('@/lib/openrouter')
    model = DEFAULT_MODEL
    upstream = await startStream(openrouter, DEFAULT_MODEL, commentaryMessages(a, b, rounds))
  } catch (error) {
    const status = (error as { status?: number })?.status
    // Log po stronie serwera: front dostaje sam kod, a bez tego nie da się
    // odróżnić rotacji klucza od padniętego pośrednika.
    console.error('[commentary] Orbio odrzuciło zapytanie', status ?? '', error)
    if (status === 429) return fail('rate_limited', 429, limitHeaders)
    if (status === 401 || status === 403) return fail('not_authorized', 502, limitHeaders)
    return fail('upstream', 502, limitHeaders)
  }

  const encoder = new TextEncoder()
  const expected = rounds.length
  // Klient odszedł. Po tym strumień jest zamknięty i każde `enqueue`/`close`
  // rzuca, więc wszystko poniżej sprawdza tę flagę, zamiast łapać wyjątki.
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CommentaryEvent) => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      }

      let text = ''
      let emitted = 0
      let anyText = false

      const emit = (line: CommentaryLine) => {
        if (line.call || line.colour) anyText = true
        send({ type: 'round', index: emitted, ...line })
        emitted++
      }

      try {
        for await (const chunk of upstream) {
          text += chunk.choices[0]?.delta?.content ?? ''
          // Wszystko, co się już domknęło, a jeszcze nie poszło. Nadmiarowe
          // wpisy ponad liczbę rund lecą za burtę, jak dotąd.
          const done = completedRoundObjects(text)
          while (emitted < Math.min(done.length, expected)) emit(toLine(done[emitted]))
        }

        // Odpowiedź w kształcie, którego skaner nie rozpoznał (np. goła tablica
        // albo `rounds` w środku zdania): ostatnia szansa to parsowanie całości.
        if (emitted === 0) {
          const parsed = parseModelJson(text) as { rounds?: unknown } | null
          const entries = Array.isArray(parsed?.rounds) ? (parsed!.rounds as unknown[]) : []
          for (const entry of entries.slice(0, expected)) emit(toLine(entry))
        }

        send(anyText ? { type: 'done', model } : { type: 'error', code: 'invalid_json' })
      } catch (error) {
        // Przerwanie przez nas to nie błąd: nikt już nie słucha, a model przestał pisać.
        if (!cancelled) {
          console.error('[commentary] strumień przerwany po', emitted, 'rundach', error)
          send({ type: 'error', code: 'upstream' })
        }
      } finally {
        if (!cancelled) controller.close()
      }
    },

    // Klient odszedł (koniec walki, nowa walka, zamknięta karta): przerywamy
    // wywołanie modelu, żeby nie płacić za tokeny, których nikt nie przeczyta.
    cancel() {
      cancelled = true
      upstream.controller.abort()
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

/** Wywołanie modelu ze strumieniem. Rzuca przy błędzie HTTP, jeszcze przed pierwszym tokenem. */
async function startStream(
  client: typeof import('@/lib/openrouter').openrouter,
  model: string,
  messages: ReturnType<typeof commentaryMessages>,
) {
  return client.chat.completions.create({
    model,
    temperature: 0.8,
    max_tokens: COMMENTARY_MAX_TOKENS,
    stream: true,
    messages,
  })
}
