/**
 * Prowadzenie dwóch głosów naraz: kto mówi, kto padł i co z tego idzie do
 * strumienia. Czysta orkiestracja bez sieci — trasa podaje jej już otwarte
 * strumienie tekstu (albo powód, dla którego strumień się nie otworzył), a ona
 * zamienia je na zdarzenia NDJSON. Dzięki temu „jeden głos pada, drugi mówi
 * dalej" da się sprawdzić offline, na podstawionych źródłach.
 *
 * Zasada: awaria jednego głosu jest zdarzeniem `voice_error`, nigdy wyjątkiem.
 * `error` (koniec bez żadnej kwestii) wychodzi tylko wtedy, gdy nie powiedział
 * nic żaden głos.
 */
import { voiceScanner, type CommentaryErrorCode, type CommentaryEvent } from './commentary.ts'
import { COMMENTARY_VOICES, type CommentaryVoice } from './commentary-voices.ts'

/** Strumień tekstu jednego modelu (kawałki `delta.content`). */
export type VoiceSource = AsyncIterable<string>

export interface RunVoicesOptions {
  /** Głosy, których strumień się otworzył. */
  sources: Partial<Record<CommentaryVoice, VoiceSource>>
  /** Głosy, których strumień się nie otworzył, z kodem powodu. */
  startErrors: Partial<Record<CommentaryVoice, CommentaryErrorCode>>
  /** Liczba rund do skomentowania. */
  expected: number
  /** Skonfigurowane modele obu głosów, do zdarzenia `done`; kto padł, mówi `failed`. */
  models: Record<CommentaryVoice, string>
  send: (event: CommentaryEvent) => void
  /** Klient odszedł: nikt już nie słucha, więc nie ma czego zgłaszać. */
  isCancelled: () => boolean
  /** Do logu po stronie serwera; front dostaje sam kod. */
  onError?: (voice: CommentaryVoice, error: unknown) => void
}

export async function runVoices(options: RunVoicesOptions): Promise<void> {
  const { sources, startErrors, expected, models, send, isCancelled, onError } = options
  const failed = new Map<CommentaryVoice, CommentaryErrorCode>()
  let spoken = 0

  const down = (voice: CommentaryVoice, code: CommentaryErrorCode) => {
    if (failed.has(voice)) return
    failed.set(voice, code)
    send({ type: 'voice_error', voice, code })
  }

  for (const voice of COMMENTARY_VOICES) {
    const code = startErrors[voice]
    if (code) down(voice, code)
  }

  const speak = async (voice: CommentaryVoice, source: VoiceSource) => {
    const scanner = voiceScanner(voice, expected)
    const say = (lines: { index: number; text: string }[]) => {
      for (const line of lines) send({ type: 'line', voice, index: line.index, text: line.text })
    }
    try {
      for await (const chunk of source) say(scanner.push(chunk))
      say(scanner.finish())
      if (scanner.texts === 0) down(voice, 'invalid_json')
      else spoken++
    } catch (error) {
      // Przerwanie przez nas (klient odszedł) to nie błąd; timeout głosu tak.
      if (isCancelled()) return
      onError?.(voice, error)
      // Kwestie, które już doszły, zostają; głos jest oznaczony jako padnięty.
      if (scanner.texts > 0) spoken++
      down(voice, 'upstream')
    }
  }

  await Promise.all(
    COMMENTARY_VOICES.flatMap((voice) => {
      const source = sources[voice]
      return source ? [speak(voice, source)] : []
    }),
  )

  if (isCancelled()) return
  if (spoken === 0) {
    // Nikt nic nie powiedział: pierwszy powód z brzegu (jest zawsze, bo każdy
    // głos bez kwestii wyżej trafił do `failed`).
    send({ type: 'error', code: [...failed.values()][0] ?? 'invalid_json' })
    return
  }
  send({ type: 'done', models, failed: [...failed.keys()] })
}
