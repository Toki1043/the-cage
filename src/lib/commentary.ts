/**
 * Komentarz do walki: wejście, prompt i odczyt odpowiedzi modelu.
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
 * `round` przychodzi, gdy model skończy pisać daną rundę — front dokleja ją do
 * walki od razu, nie czekając na resztę. `done` i `error` zamykają strumień;
 * błąd po pierwszej rundzie nie unieważnia rund, które już doszły.
 */
export type CommentaryEvent =
  | { type: 'round'; index: number; call: string; colour: string }
  | { type: 'done'; model: string }
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

const SYSTEM = [
  'You are the two-man commentary team at a boxing match where the fighters are crypto tokens.',
  'Ringside voice: fast, factual, calls the action. Colour voice: an ex-fighter who takes every punch personally and keeps drifting into stories about his own losses.',
  '',
  'The fight has already been decided by a simulation you cannot see. You are NOT told who won, and you must not guess, hint at, or announce a result — the referee does that. Call only what is on the sheet.',
  "Each fighter's stats come from real chain data: stamina is liquidity, power is 24h trading volume, guard is holder distribution, speed is how young the pair is. Glass jaw is market cap relative to liquidity: the higher it is, the less the fighter can take and the harder every punch lands on him.",
  'Work the real numbers in — a token that only just cleared the 200-holder minimum to enter the ring should get mocked for the size of its crowd.',
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
    'Example: {"rounds":[{"call":"SLOP comes out swinging and there is nothing behind it.","colour":"Two hundred and ten holders. I had more people at my divorce."}]}',
  ].join('\n')
}

export function commentaryMessages(
  a: CleanFighter,
  b: CleanFighter,
  rounds: CleanRound[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(fightSheet(a, b, rounds), rounds.length) },
  ]
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

/** Wpis rundy z odpowiedzi modelu → kwestie po oczyszczeniu i przycięciu. */
export function toLine(entry: unknown): CommentaryLine {
  const e = (entry ?? {}) as { call?: unknown; colour?: unknown }
  return { call: tidy(e.call, 140), colour: tidy(e.colour, 110) }
}

