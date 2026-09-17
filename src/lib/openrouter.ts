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

/** Confirmed working model per CLAUDE.md — verify others via GET /api/v1/models. */
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5'
