import { NextRequest, NextResponse } from 'next/server'
import type { WeightClassId } from '@/lib/stats'

/**
 * POST /api/commentary
 *
 * Komentarz do walki. Zastępuje `window.claude.use("sample")` z prototypu —
 * to była funkcja środowiska artefaktów claude.ai i na Vercelu nie istnieje
 * (CLAUDE.md § Uwaga o prototypie).
 *
 * Model dostaje **wyłącznie policzone liczby** i zwraca **wyłącznie tekst**.
 * W szczególności nie dostaje:
 *
 *  - kto wygrał, jaką metodą i w której rundzie,
 *  - karty punktowej ani punktów życia,
 *  - świec, wykresu ani czegokolwiek do interpretacji.
 *
 * Werdykt i kwestie sędziego składa front z wyniku symulacji, szablonem.
 * Powód w CLAUDE.md § Zasada nadrzędna: model komentuje, matematyka decyduje.
 * Gdyby werdykt pisał model, wynik przestałby być powtarzalny.
 *
 * Trasa nie ufa wejściu. Symbol tokena pochodzi z łańcucha, więc jest polem
 * tekstowym, które ustawia dowolny deployer — i trafia do promptu. Dlatego
 * każde pole jest tu wyłuskane i przepisane pojedynczo, nigdy `...body`.
 */

/* ------------------------------------------------------------------ */
/* Wejście                                                             */
/* ------------------------------------------------------------------ */

export interface CommentaryFighterInput {
  symbol: string
  weightClass: WeightClassId
  stats: { wytrzymalosc: number; sila: number; garda: number; szybkosc: number }
  liquidityUsd: number
  marketCapUsd: number
  holders: number
  ageDays: number
}

export interface CommentaryRoundInput {
  round: number
  /** Ciosy wyprowadzone w rundzie przez każdą stronę. */
  thrown: { a: number; b: number }
  landed: { a: number; b: number }
  damage: { a: number; b: number }
  knockdowns: { a: number; b: number }
}

export interface CommentaryRequest {
  a: CommentaryFighterInput
  b: CommentaryFighterInput
  rounds: CommentaryRoundInput[]
}

export interface CommentaryLine {
  call: string
  colour: string
}

export interface CommentaryResponse {
  rounds: CommentaryLine[]
  model: string
}

/** Kody, które front tłumaczy na zdanie w ringu. Patrz `errCopy` na froncie. */
export type CommentaryErrorCode =
  | 'bad_request'
  /** Brak klucza w środowisku. */
  | 'not_configured'
  /** Klucz jest, ale Orbio go odrzuciło — najczęściej po rotacji. */
  | 'not_authorized'
  | 'rate_limited'
  | 'invalid_json'
  | 'upstream'

/* ------------------------------------------------------------------ */
/* Sanityzacja                                                         */
/* ------------------------------------------------------------------ */

/**
 * Symbol z łańcucha do promptu.
 *
 * Deployer wpisuje `symbol()` sam, więc równie dobrze może tam siedzieć akapit
 * instrukcji dla modelu. Zostawiamy litery, cyfry i trzy znaki, jakie normalne
 * tickery faktycznie mają, i ucinamy na 16 znakach.
 */
function cleanSymbol(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  const kept = text.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16)
  return kept || 'UNNAMED'
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function stat(value: unknown): number {
  return Math.round(Math.min(100, Math.max(0, finiteNumber(value))))
}

/** Kategorie po angielsku — reszta interfejsu jest po angielsku. */
const WEIGHT_LABELS: Record<WeightClassId, string> = {
  musza: 'flyweight',
  lekka: 'lightweight',
  srednia: 'middleweight',
  polciezka: 'light heavyweight',
  ciezka: 'heavyweight',
}

function weightLabel(value: unknown): string {
  return typeof value === 'string' && value in WEIGHT_LABELS
    ? WEIGHT_LABELS[value as WeightClassId]
    : 'unclassified'
}

interface CleanFighter {
  symbol: string
  weight: string
  stats: { wytrzymalosc: number; sila: number; garda: number; szybkosc: number }
  liquidityUsd: number
  marketCapUsd: number
  holders: number
  ageDays: number
}

function cleanFighter(raw: unknown): CleanFighter {
  const f = (raw ?? {}) as Partial<CommentaryFighterInput>
  const s = (f.stats ?? {}) as Partial<CommentaryFighterInput['stats']>
  return {
    symbol: cleanSymbol(f.symbol),
    weight: weightLabel(f.weightClass),
    stats: {
      wytrzymalosc: stat(s.wytrzymalosc),
      sila: stat(s.sila),
      garda: stat(s.garda),
      szybkosc: stat(s.szybkosc),
    },
    liquidityUsd: Math.max(0, finiteNumber(f.liquidityUsd)),
    marketCapUsd: Math.max(0, finiteNumber(f.marketCapUsd)),
    holders: Math.max(0, Math.round(finiteNumber(f.holders))),
    ageDays: Math.max(0, finiteNumber(f.ageDays)),
  }
}

interface CleanRound {
  round: number
  thrown: [number, number]
  landed: [number, number]
  damage: [number, number]
  knockdowns: [number, number]
}

function cleanRounds(raw: unknown): CleanRound[] {
  if (!Array.isArray(raw)) return []
  const pair = (v: unknown, round = false): [number, number] => {
    const o = (v ?? {}) as { a?: unknown; b?: unknown }
    const one = (x: unknown) => {
      const n = Math.max(0, finiteNumber(x))
      return round ? Math.round(n) : Math.round(n * 10) / 10
    }
    return [one(o.a), one(o.b)]
  }
  // Najwyżej trzy rundy — tyle liczy symulacja (`ROUNDS` w fight.ts).
  return raw.slice(0, 3).map((r, i) => {
    const o = (r ?? {}) as Partial<CommentaryRoundInput>
    return {
      round: Math.max(1, Math.round(finiteNumber(o.round, i + 1))),
      thrown: pair(o.thrown, true),
      landed: pair(o.landed, true),
      damage: pair(o.damage),
      knockdowns: pair(o.knockdowns, true),
    }
  })
}

/* ------------------------------------------------------------------ */
/* Prompt                                                             */
/* ------------------------------------------------------------------ */

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

/**
 * Karta walki dla komentatorów — bez wyniku.
 *
 * Są tu obrażenia i nokdauny z każdej rundy, bo to jest to, co komentator
 * widzi z krzesła przy ringu. Nie ma punktów życia, karty punktowej ani
 * zwycięzcy: z nich dałoby się odczytać rozstrzygnięcie, a tego model
 * widzieć nie może.
 */
function fightSheet(a: CleanFighter, b: CleanFighter, rounds: CleanRound[]): string {
  const corner = (f: CleanFighter, side: string) =>
    `${side}: $${f.symbol} (${f.weight}) — market cap ${usd(f.marketCapUsd)}, liquidity ${usd(
      f.liquidityUsd,
    )}, ${f.holders.toLocaleString('en-US')} holders, ${Math.round(f.ageDays)} days old. ` +
    `Stamina ${f.stats.wytrzymalosc}, power ${f.stats.sila}, guard ${f.stats.garda}, speed ${f.stats.szybkosc}.`

  const lines = [corner(a, 'Red corner'), corner(b, 'Blue corner'), '', 'What happened:']

  for (const r of rounds) {
    const kd =
      r.knockdowns[0] || r.knockdowns[1]
        ? ` Knockdowns: $${a.symbol} went down ${r.knockdowns[0]}, $${b.symbol} went down ${r.knockdowns[1]}.`
        : ''
    lines.push(
      `Round ${r.round}: $${a.symbol} threw ${r.thrown[0]} and landed ${r.landed[0]} for ${r.damage[0]} damage. ` +
        `$${b.symbol} threw ${r.thrown[1]} and landed ${r.landed[1]} for ${r.damage[1]} damage.${kd}`,
    )
  }

  return lines.join('\n')
}

const SYSTEM = [
  'You are the two-man commentary team at a boxing match where the fighters are crypto tokens.',
  'Ringside voice: fast, factual, calls the action. Colour voice: an ex-fighter who takes every punch personally and keeps drifting into stories about his own losses.',
  '',
  'The fight has already been decided by a simulation you cannot see. You are NOT told who won, and you must not guess, hint at, or announce a result — the referee does that. Call only what is on the sheet.',
  "Each fighter's stats come from real chain data: stamina is liquidity, power is how thin that liquidity is relative to market cap, guard is holder distribution, speed is how young the pair is.",
  'Work the real numbers in — a token with 40 holders should get mocked for having nobody in the arena.',
  '',
  'Hard rules:',
  '- Use only the numbers on the sheet. Invent no facts about either token: no team, no narrative, no listings, no history.',
  '- No price prediction, no trend reading, no "bullish" or "bearish", no buy or sell advice.',
  '- No emoji.',
  '- Output JSON only, no code fence, no commentary outside the JSON.',
].join('\n')

function userPrompt(sheet: string, roundCount: number): string {
  return [
    sheet,
    '',
    'Reply with only JSON: {"rounds":[{"call":string,"colour":string}]}',
    `One entry per round, in order, ${roundCount} total.`,
    "'call' at most 140 characters, 'colour' at most 110.",
    'Example: {"rounds":[{"call":"SLOP comes out swinging and there is nothing behind it.","colour":"Forty holders. I had more people at my divorce."}]}',
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Wyjście modelu                                                      */
/* ------------------------------------------------------------------ */

/**
 * Emoji i symbole obrazkowe — CLAUDE.md § Czego nie robić: bez emoji
 * w komentarzu. Jawne przedziały zamiast `\p{...}`, bo te ostatnie wymagają
 * targetu ES2018, a projekt stoi na ES2017.
 */
const PICTOGRAPHS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2122}\u{2139}]/gu

/**
 * Ucina do `max` znaków, ale nie w pół słowa: jeśli tekst jest za długi,
 * cofa się do końca ostatniego pełnego zdania w limicie, a gdy takiego nie
 * ma — do ostatniej spacji. Bez tego długa odpowiedź modelu urywała się
 * dokładnie na granicy znaków, czasem w połowie słowa.
 */
function tidy(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(PICTOGRAPHS, '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text

  const cut = text.slice(0, max)
  const lastSentenceEnd = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
    cut.endsWith('.') || cut.endsWith('!') || cut.endsWith('?') ? cut.length - 1 : -1,
  )
  if (lastSentenceEnd > 0) return cut.slice(0, lastSentenceEnd + 1)

  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut
}

/**
 * Model prosi się o czysty JSON i zwykle go daje, ale nie zawsze — bywa
 * ogrodzenie ```json albo zdanie wstępu. Bierzemy pierwszy obiekt w nawiasach.
 */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

function fail(code: CommentaryErrorCode, status: number) {
  return NextResponse.json({ error: code }, { status })
}

/* ------------------------------------------------------------------ */
/* Trasa                                                              */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('bad_request', 400)
  }

  const payload = (body ?? {}) as Partial<CommentaryRequest>
  const rounds = cleanRounds(payload.rounds)
  if (rounds.length === 0) return fail('bad_request', 400)

  const a = cleanFighter(payload.a)
  const b = cleanFighter(payload.b)

  // Brak klucza to nie awaria: walka i tak się odbywa, tylko bez komentarza.
  // Sprawdzamy przed importem, bo `openrouter.ts` rzuca już przy wczytaniu
  // modułu — dlatego import jest dynamiczny, a nie na górze pliku.
  if (!process.env.OPENAI_API_KEY) return fail('not_configured', 503)

  let text: string
  let model: string
  try {
    const { openrouter, DEFAULT_MODEL } = await import('@/lib/openrouter')
    model = DEFAULT_MODEL
    const completion = await openrouter.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.8,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(fightSheet(a, b, rounds), rounds.length) },
      ],
    })
    text = completion.choices[0]?.message?.content ?? ''
  } catch (error) {
    const status = (error as { status?: number })?.status
    // Log po stronie serwera: front dostaje sam kod, a bez tego nie da się
    // odróżnić rotacji klucza od padniętego pośrednika.
    console.error('[commentary] Orbio odrzuciło zapytanie', status ?? '', error)
    if (status === 429) return fail('rate_limited', 429)
    if (status === 401 || status === 403) return fail('not_authorized', 502)
    return fail('upstream', 502)
  }

  const parsed = parseModelJson(text) as { rounds?: unknown } | null
  if (!parsed || !Array.isArray(parsed.rounds)) return fail('invalid_json', 502)

  // Tyle wpisów, ile rund — brakujące zostają puste, nadmiarowe lecą za burtę.
  const lines: CommentaryLine[] = rounds.map((_, i) => {
    const entry = (parsed.rounds as unknown[])[i] as { call?: unknown; colour?: unknown } | undefined
    return {
      call: tidy(entry?.call, 140),
      colour: tidy(entry?.colour, 110),
    }
  })

  if (lines.every((l) => !l.call && !l.colour)) return fail('invalid_json', 502)

  const response: CommentaryResponse = { rounds: lines, model }
  return NextResponse.json(response)
}
