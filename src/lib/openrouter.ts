import OpenAI from 'openai'

/**
 * One client, one key.
 *
 * OpenRouter speaks the OpenAI wire format, so the official `openai` SDK works
 * unchanged with a different base URL. Next.js loads `.env.local` on its own,
 * so no `dotenv` here — this only runs server-side (route handlers, RSC).
 *
 * Orbio's key goes through Orbio's own proxy (`OPENAI_BASE_URL`), not straight
 * to OpenRouter — see CLAUDE.md § Konfiguracja API.
 */
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error(
    'OPENAI_API_KEY is not set. Copy it into .env.local (see CLAUDE.md § Konfiguracja API).',
  )
}

const baseURL = process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1'

export const openrouter = new OpenAI({
  apiKey,
  baseURL,
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL ?? 'https://orbio.so/build',
    'X-Title': process.env.APP_NAME ?? 'Orbio Build Week',
  },
})

/** Raw fetch against the same base, for endpoints the SDK does not model. */
export const openrouterFetch = (path: string, init: RequestInit = {}) =>
  fetch(`${baseURL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

/**
 * Modele komentatorów. Dwa głosy, dwa różne modele u dwóch dostawców, oba przez
 * ten sam klucz Orbio. Dostępność sprawdzona `GET /api/v1/models` (lista
 * potrafi zawierać modele, których nikt nie obsługuje — 404 „No provider is
 * currently serving this model" — więc każdy wybór był też wywołany na żywo).
 *
 * - `call` (przy ringu): `anthropic/claude-sonnet-4.5`, potwierdzony w CLAUDE.md.
 *   Nadpisuje go `OPENROUTER_MODEL`.
 * - `colour` (barwny): `google/gemini-3.5-flash`. Nadpisuje go
 *   `OPENROUTER_MODEL_COLOUR`. Ma domyślnie włączone rozumowanie, które zjadało
 *   ~95% limitu tokenów i urywało odpowiedź przed pierwszą kwestią, więc dostaje
 *   `reasoning: { effort: 'minimal' }` (zmierzone: 0 tokenów rozumowania, ~2 s
 *   całości). Z tego powodu modele OpenAI z rodziny GPT-5 odpadły: odrzucają
 *   `temperature` (404) i ignorowały limity znaków.
 *
 * `params` idą do żądania obok `model`, `max_tokens` i `messages`.
 */
import { DEFAULT_VOICE_MODELS, type CommentaryVoice } from './commentary-voices.ts'

export const VOICE_MODELS: Record<CommentaryVoice, { model: string; params: Record<string, unknown> }> = {
  call: {
    model: process.env.OPENROUTER_MODEL ?? DEFAULT_VOICE_MODELS.call,
    params: { temperature: 0.8 },
  },
  colour: {
    model: process.env.OPENROUTER_MODEL_COLOUR ?? DEFAULT_VOICE_MODELS.colour,
    params: { temperature: 0.8, reasoning: { effort: 'minimal' } },
  },
}
