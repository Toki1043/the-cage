/**
 * Pomiar czasu komentarza na żywo — bez frontu i bez trasy.
 * Uruchomienie: npm run check:commentary                       (oba głosy, modele z `VOICE_MODELS`)
 *             VOICE=colour npm run check:commentary            (tylko jeden głos)
 *             VOICE=call MODEL=anthropic/claude-haiku-4.5 npm run check:commentary
 *             LIST=1 npm run check:commentary                  (tylko lista modeli z pośrednika)
 *
 * Głosy są dwa (przy ringu i barwny), każdy na innym modelu; mierzymy je osobno,
 * bo trasa woła je równolegle i całość trwa tyle, co wolniejszy. `MODEL` nadpisuje
 * model wybranego głosu (wymaga `VOICE`). Lista z `LIST=1` pokazuje też modele,
 * których nikt nie obsługuje (404 „No provider is currently serving this model"),
 * więc kandydata trzeba zawsze wywołać na żywo.
 *
 * Mierzy trzy rzeczy osobno, bo każda ma inną dźwignię:
 *
 *  - opóźnienie stałe: pusty strzał na jeden token — ile trwa sama droga do modelu
 *    (pośrednik Orbio, OpenRouter, dostawca), zanim cokolwiek zacznie się generować,
 *  - czas do pierwszej rundy i do każdej kolejnej — to, co widzi gracz przy streamingu,
 *  - czas całości i liczbę tokenów — z tego wychodzi prędkość generowania.
 *
 * Używa tego samego promptu co trasa (`lib/commentary.ts`), więc liczby są
 * liczbami trasy, a nie osobnego eksperymentu. Zużywa kilka wywołań modelu.
 */
import {
  COMMENTARY_MAX_TOKENS,
  cleanFighter,
  cleanRounds,
  completedRoundObjects,
  voiceMessages,
} from '../src/lib/commentary.ts'
import { COMMENTARY_VOICES, type CommentaryVoice } from '../src/lib/commentary-voices.ts'
import { VOICE_MODELS, openrouter } from '../src/lib/openrouter.ts'

const ONLY = process.env.VOICE as CommentaryVoice | undefined
if (ONLY && !COMMENTARY_VOICES.includes(ONLY)) {
  console.error(`VOICE musi być jednym z: ${COMMENTARY_VOICES.join(', ')}`)
  process.exit(1)
}
if (process.env.MODEL && !ONLY) {
  console.error('MODEL nadpisuje model jednego głosu — podaj też VOICE=call albo VOICE=colour')
  process.exit(1)
}

if (process.env.LIST) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  })
  const body = (await res.json()) as { data?: { id: string }[] }
  const ids = (body.data ?? []).map((m) => m.id).filter((id) => /claude|haiku|sonnet|gpt|gemini|flash|mini/i.test(id))
  console.log(ids.join('\n') || `brak listy (HTTP ${res.status})`)
  process.exit(0)
}

// Realistyczna karta walki: dwie pary tokenów i trzy rundy z liczbami.
const a = cleanFighter({
  symbol: 'AI', weightClass: 'polciezka', stats: { wytrzymalosc: 72, sila: 58, garda: 74, szybkosc: 36 },
  liquidityUsd: 3_768_000, marketCapUsd: 299_000_000, volume24hUsd: 780_000, vulnerability: 63, holders: 48_790, ageDays: 66,
})
const b = cleanFighter({
  symbol: 'PONS', weightClass: 'polciezka', stats: { wytrzymalosc: 69, sila: 68, garda: 80, szybkosc: 36 },
  liquidityUsd: 2_880_000, marketCapUsd: 470_000_000, volume24hUsd: 2_570_000, vulnerability: 74, holders: 97_454, ageDays: 67,
})
const rounds = cleanRounds([
  { round: 1, thrown: { a: 11, b: 10 }, landed: { a: 6, b: 3 }, damage: { a: 47.4, b: 23.4 }, knockdowns: { a: 0, b: 0 } },
  { round: 2, thrown: { a: 10, b: 11 }, landed: { a: 5, b: 4 }, damage: { a: 38.1, b: 31.2 }, knockdowns: { a: 0, b: 0 } },
  { round: 3, thrown: { a: 11, b: 10 }, landed: { a: 5, b: 4 }, damage: { a: 34.0, b: 21.0 }, knockdowns: { a: 0, b: 0 } },
])

/** Kawałek strumienia w tym kształcie, jaki czytamy; `params` (np. `reasoning`) wychodzą poza typy SDK. */
type StreamChunk = {
  choices: { delta?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

const secs = (t0: number) => ((performance.now() - t0) / 1000).toFixed(2)

async function ping(voice: CommentaryVoice, model: string): Promise<string> {
  const t0 = performance.now()
  const stream = (await openrouter.chat.completions.create({
    model,
    max_tokens: 1,
    stream: true,
    messages: [{ role: 'user', content: 'Say: ok' }],
    ...VOICE_MODELS[voice].params,
  } as never)) as unknown as AsyncIterable<StreamChunk>
  const headers = secs(t0)
  for await (const chunk of stream) if (chunk.choices[0]?.delta?.content) break
  return `nagłówki ${headers}s, pierwszy token ${secs(t0)}s`
}

async function real(voice: CommentaryVoice, model: string): Promise<void> {
  const t0 = performance.now()
  const stream = (await openrouter.chat.completions.create({
    model,
    max_tokens: COMMENTARY_MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    messages: voiceMessages(voice, a, b, rounds),
    ...VOICE_MODELS[voice].params,
  } as never)) as unknown as AsyncIterable<StreamChunk>
  const headers = secs(t0)

  let text = ''
  let first = ''
  let chunks = 0
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null
  const marks: string[] = []
  let seen = 0

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage
    const piece = chunk.choices[0]?.delta?.content ?? ''
    if (!piece) continue
    chunks++
    if (!first) first = secs(t0)
    text += piece
    const done = completedRoundObjects(text).length
    while (seen < done) marks.push(`runda ${++seen} @ ${secs(t0)}s`)
  }
  const total = secs(t0)

  const out = usage?.completion_tokens ?? null
  const gen = out ? (out / Math.max(0.01, Number(total) - Number(first))).toFixed(0) : '?'
  console.log(`  nagłówki ${headers}s | pierwszy token ${first}s | ${marks.join(' | ')} | całość ${total}s`)
  console.log(`  tokeny: wejście ${usage?.prompt_tokens ?? '?'}, wyjście ${out ?? '?'} (${chunks} kawałków) | ~${gen} tok/s po pierwszym tokenie | ${text.length} znaków`)
}

for (const voice of ONLY ? [ONLY] : COMMENTARY_VOICES) {
  const model = process.env.MODEL ?? VOICE_MODELS[voice].model
  console.log(`\n== głos ${voice}: ${model}, sufit ${COMMENTARY_MAX_TOKENS} tokenów ==\n`)
  for (let i = 1; i <= 2; i++) console.log(`pusty strzał ${i}: ${await ping(voice, model)}`)
  console.log()
  for (let i = 1; i <= 3; i++) {
    console.log(`komentarz ${i}:`)
    await real(voice, model)
  }
}
console.log()
