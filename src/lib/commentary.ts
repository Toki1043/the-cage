/**
 * Komentarz do walki: wejście, prompt i odczyt odpowiedzi modeli.
 *
 * Komentatorów jest dwóch i to dwa różne modele u dwóch dostawców, wołane
 * równolegle: głos przy ringu (`call`) i głos barwny (`colour`). Każdy ma
 * własny prompt i własny strumień; jeden może paść, a drugi dalej mówi.
 *
 * Czysty kod, bez sieci i bez env — trasa `/api/commentary` jest cienką
 * warstwą na wierzchu, a skrypty (`verify:commentary`, `check:commentary`)
 * mogą ćwiczyć wszystko stąd bez klucza. Plik `route.ts` w Next powinien
 * eksportować wyłącznie handlery, więc reszta mieszka tu.
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
 *
 * Wejście nie jest zaufane. Symbol tokena pochodzi z łańcucha, więc jest polem
 * tekstowym, które ustawia dowolny deployer — i trafia do promptu. Dlatego
 * każde pole jest wyłuskane i przepisane pojedynczo, nigdy `...body`.
 */
import type { WeightClassId } from './stats'
import { COMMENTARY_VOICES, type CommentaryVoice } from './commentary-voices.ts'

/* ------------------------------------------------------------------ */
/* Wejście                                                             */
/* ------------------------------------------------------------------ */

export interface CommentaryFighterInput {
  symbol: string
  weightClass: WeightClassId
  stats: { wytrzymalosc: number; sila: number; garda: number; szybkosc: number }
  liquidityUsd: number
  marketCapUsd: number
  volume24hUsd: number
  /** Szklana szczęka 0–100: kapitalizacja względem płynności. */
  vulnerability: number
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

/** Kwestie jednej rundy po złożeniu głosów; brakujący głos to pusty łańcuch. */
export interface CommentaryLine {
  call: string
  colour: string
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

/**
 * Zdarzenia strumienia NDJSON z `/api/commentary`: jedna linia JSON na zdarzenie.
 *
 * `line` przychodzi, gdy dany model skończy pisać daną rundę — front dokleja ją
 * do walki od razu, nie czekając ani na resztę rund, ani na drugi głos.
 * `voice_error` mówi, że jeden z dwóch głosów padł (przed pierwszym tokenem albo
 * w trakcie); drugi mówi dalej i walka idzie normalnie. `done` i `error`
 * zamykają strumień: `error` tylko wtedy, gdy nie doszła żadna kwestia,
 * a błąd po części rund nie unieważnia rund, które już doszły.
 */
export type CommentaryEvent =
  | { type: 'line'; voice: CommentaryVoice; index: number; text: string }
  | { type: 'voice_error'; voice: CommentaryVoice; code: CommentaryErrorCode }
  | { type: 'done'; models: Record<CommentaryVoice, string>; failed: CommentaryVoice[] }
  | { type: 'error'; code: CommentaryErrorCode }

/**
 * Sufit tokenów odpowiedzi. Trzy rundy po ≤250 znaków to około 200 tokenów, więc
 * 600 zostawia zapas na ogrodzenie i spacje, a nie pozwala modelowi rozpisać się
 * na 2000 tokenów, gdyby zignorował limity znaków. Sam sufit nie skraca
 * poprawnej odpowiedzi — chroni przed kosztem tej niepoprawnej.
 */
export const COMMENTARY_MAX_TOKENS = 600

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

export interface CleanFighter {
  symbol: string
  weight: string
  stats: { wytrzymalosc: number; sila: number; garda: number; szybkosc: number }
  liquidityUsd: number
  marketCapUsd: number
  volume24hUsd: number
  vulnerability: number
  holders: number
  ageDays: number
}

export function cleanFighter(raw: unknown): CleanFighter {
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
    volume24hUsd: Math.max(0, finiteNumber(f.volume24hUsd)),
    vulnerability: stat(f.vulnerability),
    holders: Math.max(0, Math.round(finiteNumber(f.holders))),
    ageDays: Math.max(0, finiteNumber(f.ageDays)),
  }
}

export interface CleanRound {
  round: number
  thrown: [number, number]
  landed: [number, number]
  damage: [number, number]
  knockdowns: [number, number]
}

export function cleanRounds(raw: unknown): CleanRound[] {
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
    )}, 24h volume ${usd(f.volume24hUsd)}, ${f.holders.toLocaleString('en-US')} holders, ` +
    `${Math.round(f.ageDays)} days old. ` +
    `Stamina ${f.stats.wytrzymalosc}, power ${f.stats.sila}, guard ${f.stats.garda}, speed ${f.stats.szybkosc}. ` +
    `Glass jaw ${f.vulnerability} out of 100.`

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

/**
 * Limity znaków kwestii na głos. Front ma dla każdej własny wiersz w panelu,
 * a `tidy` ucina to, co model mimo prośby rozpisał.
 */
export const VOICE_LIMITS: Record<CommentaryVoice, number> = { call: 140, colour: 110 }

/** Wspólna część: kim jest para komentatorów, czego nie wolno i skąd są liczby. */
const SHARED_RULES = [
  'The fight has already been decided by a simulation you cannot see. You are NOT told who won, and you must not guess, hint at, or announce a result — the referee does that. Call only what is on the sheet.',
  "Each fighter's stats come from real chain data: stamina is liquidity, power is 24h trading volume, guard is holder distribution, speed is how young the pair is. Glass jaw is market cap relative to liquidity: the higher it is, the less the fighter can take and the harder every punch lands on him.",
  'Work the real numbers in — a token that only just cleared the 200-holder minimum to enter the ring should get mocked for the size of its crowd.',
  '',
  'Hard rules:',
  '- Use only the numbers on the sheet. Invent no facts about either token: no team, no narrative, no listings, no history.',
  '- Never say who is ahead, who took a round, or who is winning on the cards. The numbers describe a round; the referee scores the fight.',
  '- No price prediction, no trend reading, no "bullish" or "bearish", no buy or sell advice.',
  '- No emoji.',
  '- Output JSON only, no code fence, no commentary outside the JSON.',
]

/**
 * Charakter każdego głosu. Dwa różne modele plus dwa różne polecenia: przy
 * ringu krótko i po faktach, z krzesła obok — osobiście i z boku.
 */
const PERSONA: Record<CommentaryVoice, string[]> = {
  call: [
    'You are the ringside voice of a two-man commentary team at a boxing match where the fighters are crypto tokens.',
    'Your job is the play-by-play: fast, factual, present tense. Say who threw, who landed, how much damage, who hit the canvas. Short, punchy sentences. Your partner does the colour; you never drift into stories.',
  ],
  colour: [
    'You are the colour voice of a two-man commentary team at a boxing match where the fighters are crypto tokens.',
    'You are an ex-fighter who takes every punch personally and keeps drifting into stories about his own losses. Your partner calls the action, so you never do: you react to the numbers on the sheet and to what they must feel like, in dry, wounded, slightly rambling humour.',
  ],
}

function systemPrompt(voice: CommentaryVoice): string {
  return [...PERSONA[voice], '', ...SHARED_RULES].join('\n')
}

const EXAMPLES: Record<CommentaryVoice, string> = {
  call: '{"rounds":[{"call":"SLOP comes out swinging and there is nothing behind it."}]}',
  colour: '{"rounds":[{"colour":"Two hundred and ten holders. I had more people at my divorce."}]}',
}

function userPrompt(voice: CommentaryVoice, sheet: string, roundCount: number): string {
  return [
    sheet,
    '',
    `Reply with only JSON: {"rounds":[{"${voice}":string}]}`,
    `One entry per round, in order, ${roundCount} total.`,
    `'${voice}' at most ${VOICE_LIMITS[voice]} characters.`,
    `Example: ${EXAMPLES[voice]}`,
  ].join('\n')
}

/** Wiadomości dla jednego głosu. Ta sama karta walki, inny charakter. */
export function voiceMessages(
  voice: CommentaryVoice,
  a: CleanFighter,
  b: CleanFighter,
  rounds: CleanRound[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: systemPrompt(voice) },
    { role: 'user', content: userPrompt(voice, fightSheet(a, b, rounds), rounds.length) },
  ]
}

/** Wiadomości dla wszystkich głosów, w kolejności `COMMENTARY_VOICES`. */
export function commentaryMessages(a: CleanFighter, b: CleanFighter, rounds: CleanRound[]) {
  return COMMENTARY_VOICES.map((voice) => ({ voice, messages: voiceMessages(voice, a, b, rounds) }))
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
export function tidy(value: unknown, max: number): string {
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
export function parseModelJson(text: string): unknown {
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

/**
 * Kompletne obiekty z tablicy `"rounds"` w tekście, który model jeszcze pisze.
 *
 * Model odpowiada jednym JSON-em `{"rounds":[{...},{...},{...}]}`, a strumień
 * daje go kawałkami. Cały JSON da się sparsować dopiero na końcu — ale każdy
 * obiekt rundy jest kompletny już wtedy, gdy zamknie się jego `}`, a to jest
 * dużo wcześniej. Skaner liczy głębokość nawiasów z uwzględnieniem łańcuchów
 * i cudzysłowów z ukośnikiem (`"To \"jego\" rundy"`), więc klamry wewnątrz
 * tekstu komentarza go nie mylą.
 *
 * Bezstanowy: dostaje cały dotychczasowy tekst i oddaje wszystko, co jest
 * już kompletne. Tekst ma kilka kilobajtów, więc ponowne skanowanie przy
 * każdym kawałku nic nie kosztuje, a nie ma stanu, który mógłby się rozjechać.
 * Obiekt, którego nie da się sparsować, jest pomijany, nie wywraca reszty.
 */
export function completedRoundObjects(text: string): unknown[] {
  const key = text.indexOf('"rounds"')
  if (key === -1) return []
  const open = text.indexOf('[', key)
  if (open === -1) return []

  const found: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)))
        } catch {
          // Uszkodzony obiekt: pomijamy, żeby jeden nie zabrał pozostałych.
        }
        start = -1
      }
      if (depth < 0) break
    } else if (ch === ']' && depth === 0) {
      break
    }
  }

  return found
}

/** Wpis rundy z odpowiedzi jednego modelu → jego kwestia po oczyszczeniu i przycięciu. */
export function toVoiceText(entry: unknown, voice: CommentaryVoice): string {
  const e = (entry ?? {}) as Record<string, unknown>
  return tidy(e[voice], VOICE_LIMITS[voice])
}

/**
 * Konwertuje entry na CommentaryLine z oboma głosami.
 * Używane przez route do emisji rund w strumieniu.
 */
export function toLine(entry: unknown): CommentaryLine {
  return {
    call: toVoiceText(entry, 'call'),
    colour: toVoiceText(entry, 'colour'),
  }
}

/**
 * Odczyt strumienia jednego głosu: dostaje kawałki tekstu, oddaje kwestie, które
 * właśnie się domknęły. Ta sama logika co dawniej w trasie (skaner obiektów,
 * a na końcu parsowanie całości jako ostatnia szansa), tylko osobno dla każdego
 * głosu i bez sieci, więc da się ją ćwiczyć w `verify:commentary`.
 *
 * Kwestie puste po oczyszczeniu (np. same emoji) nie wychodzą: front i tak nic by
 * z nich nie pokazał, a `texts` liczy tylko te, które wyszły.
 */
export interface VoiceLine {
  index: number
  text: string
}

export function voiceScanner(voice: CommentaryVoice, expected: number) {
  let text = ''
  let emitted = 0
  let texts = 0

  const drain = (entries: unknown[]): VoiceLine[] => {
    const out: VoiceLine[] = []
    while (emitted < Math.min(entries.length, expected)) {
      const line = toVoiceText(entries[emitted], voice)
      if (line) {
        texts++
        out.push({ index: emitted, text: line })
      }
      emitted++
    }
    return out
  }

  return {
    /** Kolejny kawałek tekstu z modelu → kwestie domknięte od poprzedniego wołania. */
    push(chunk: string): VoiceLine[] {
      text += chunk
      return drain(completedRoundObjects(text))
    },
    /** Koniec strumienia: jeśli skaner nic nie rozpoznał, próbujemy sparsować całość. */
    finish(): VoiceLine[] {
      if (emitted > 0) return []
      const parsed = parseModelJson(text) as { rounds?: unknown } | null
      const entries = Array.isArray(parsed?.rounds) ? (parsed!.rounds as unknown[]) : []
      return drain(entries.slice(0, expected))
    },
    /** Ile niepustych kwestii już wyszło. */
    get texts() {
      return texts
    },
  }
}
