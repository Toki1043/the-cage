/**
 * Generator grafiki statycznej dla areny. Odpalany ręcznie, nie w czasie żądania.
 *
 * Wolno tu generować to, co się nie rusza, albo to, co da się animować
 * warstwami. Sędzia musi zostać animowalny, więc jego postać idzie w dwóch
 * kawałkach: kłoda osobno, pałka osobno, a obrót pałki robi CSS. To obchodzi
 * powód zasady z CLAUDE.md § Sędzia („obrazek jest statyczny i nie umie się
 * ruszać"), nie łamiąc go — warstwa się rusza, choć jest obrazkiem.
 *
 * Model nie dostaje tu żadnych liczb o tokenach i nie ma wpływu na wynik
 * walki. Zasada „matematyka decyduje, modele komentują" zostaje nietknięta.
 *
 * Wywołanie idzie przez pośrednika Orbio (`OPENAI_BASE_URL`), tym samym
 * kluczem co komentarz, i wydaje limit — dlatego osobny skrypt uruchamiany
 * ręcznie, a nie część builda.
 *
 * Użycie:
 *   node --experimental-strip-types --no-warnings scripts/generate-art.ts <preset> [model] [rozmiar]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

/** Własny parser .env.local — `source` w zsh wywala się na `APP_NAME=The Cage`. */
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '')
  }
  return out
}

const env = loadEnv('.env.local')

/**
 * Prompty.
 *
 * `hall` leży POD rysowanymi sylwetkami, więc bez lin, bez zawodników i bez
 * ostrego tłumu. `sahur` i `club` muszą wyjść wycięte na przezroczystym tle,
 * bo wchodzą jako dwie warstwy jedna na drugą — stąd nacisk w prompcie na
 * puste ręce u kłody i brak dłoni przy pałce.
 *
 * Nigdzie nie pada nazwisko ani wizerunek żyjącej osoby (CLAUDE.md § Sędzia).
 */
/** Wspólna część obu poz, żeby garda i cios były tym samym zwierzakiem. */
const FIGHTER_STYLE = [
  'Clean readable cartoon illustration, bold simple shapes, soft shading, thick dark outlines,',
  'full body visible head to feet, front view, centred in frame with margin around it,',
  'on a fully transparent background.',
  'The background must be 100% empty transparent alpha, completely blank.',
  'No background of any kind: no dark backdrop, no vignette, no glow, no halo, no rim light,',
  'no gradient behind the character, no coloured panel, no floor, no ground shadow, no ring,',
  'no ropes, no scenery, no other characters,',
  'no text, no letters, no numbers, no logos, no watermark, no signature.',
].join(' ')

const BULL_BASE = [
  'A muscular anthropomorphic bull standing upright on two legs as a boxer:',
  'broad shoulders, thick neck, two curved horns, a ring in its nose, dark charcoal-grey hide,',
  'wearing deep red boxing trunks with a waistband and large red boxing gloves, and dark boots.',
  FIGHTER_STYLE,
].join(' ')

const BEAR_BASE = [
  'A heavy anthropomorphic brown bear standing upright on two legs as a boxer:',
  'thick shoulders, round ears, a broad muzzle, shaggy warm-brown fur,',
  'wearing deep blue boxing trunks with a waistband and large blue boxing gloves, and dark boots.',
  FIGHTER_STYLE,
].join(' ')

const PRESETS: Record<string, { prompt: string; background?: string; size: string }> = {
  hall: {
    size: '1536x1024',
    prompt: [
      'Empty boxing arena interior at night, seen from ringside, painterly and atmospheric.',
      'Deep blue-black darkness, heavy haze in the air, two shafts of warm amber light',
      'falling from hanging industrial lamps high above. Far in the background, a blurred,',
      'featureless mass of spectator silhouettes lost in shadow — no visible faces, no',
      'individual people, no recognisable persons. The lower third of the frame is almost',
      'empty dark canvas floor with soft light pooling on it.',
      'No ring ropes, no ring posts, no fighters, no referee, no text, no letters,',
      'no logos, no watermarks, no signage.',
      'Muted desaturated palette: amber #E0B24A key light against near-black #0A0F16.',
      'Cinematic, moody, wide panoramic composition, painted texture rather than photo.',
    ].join(' '),
  },
  sahur: {
    size: '1024x1024',
    background: 'transparent',
    prompt: [
      'Full body character cutout on a fully transparent background, front view, standing upright.',
      'The character is a cartoon wooden log come to life: one thick vertical tree-trunk section',
      'forms its entire body, with visible bark texture and a flat cut cross-section showing',
      'growth rings on top of its head. A face sits on the front of the trunk: two wide round',
      'cartoon eyes with dark pupils, angled stern eyebrows, and an open shouting mouth.',
      'It has two thin bare wooden stick arms and two short thin wooden legs ending in small',
      'dark shoes. It wears a black bow tie just below its face, like a boxing referee.',
      'IMPORTANT: both hands are empty and open. It holds nothing whatsoever — no bat, no club,',
      'no stick, no mallet, no hammer, no objects of any kind.',
      'Clean readable cartoon illustration, bold simple shapes, soft shading, centred in frame,',
      'whole body visible with margin around it, standing straight, arms held slightly away',
      'from the body. Warm mid-brown wood tones.',
      'No background, no floor, no ground shadow, no scenery, no text, no letters, no logos,',
      'no watermark, no signature.',
    ].join(' '),
  },
  /*
   * Zawodnicy: byk z Wall Street i niedźwiedź jako bear market. Ikonografia
   * rynku, nie wizerunek żadnej osoby.
   *
   * Po dwie pozy na postać — garda i cios — bo front przełącza klatki przy
   * uderzeniu. Opis postaci jest w obu promptach identyczny co do słowa,
   * żeby model nie narysował dwóch różnych zwierząt; różni się wyłącznie
   * zdanie o ułożeniu rąk.
   *
   * Barwy spodenek idą za narożnikiem: byk czerwony, niedźwiedź niebieski.
   */
  'bull-guard': {
    size: '1024x1024',
    background: 'transparent',
    prompt: BULL_BASE + ' Standing in a tight boxing guard, both gloved fists raised close to the chin, elbows tucked in, weight settled.',
  },
  'bull-punch': {
    size: '1024x1024',
    background: 'transparent',
    prompt: BULL_BASE + ' Throwing a straight punch: the near arm fully extended forward to the right, glove out at full reach, the far glove kept up by the chin, body turned into the shot.',
  },
  'bear-guard': {
    size: '1024x1024',
    background: 'transparent',
    prompt: BEAR_BASE + ' Standing in a tight boxing guard, both gloved fists raised close to the chin, elbows tucked in, weight settled.',
  },
  'bear-punch': {
    size: '1024x1024',
    background: 'transparent',
    prompt: BEAR_BASE + ' Throwing a straight punch: the near arm fully extended forward to the right, glove out at full reach, the far glove kept up by the chin, body turned into the shot.',
  },
  club: {
    size: '1024x1024',
    background: 'transparent',
    prompt: [
      'A single cartoon wooden baseball bat on a fully transparent background, nothing else.',
      'Standing vertically, thin handle at the bottom, thick striking end at the top.',
      'Warm mid-brown wood tones with grain, and a dark grip wrap at the very bottom',
      'of the handle.',
      'Clean readable cartoon illustration, bold simple shapes, soft shading, centred in',
      'frame with margin around it.',
      'No hand, no arm, no character, no background, no floor, no shadow, no text,',
      'no letters, no logos, no watermark.',
    ].join(' '),
  },
}

const presetName = process.argv[2] ?? 'hall'
const preset = PRESETS[presetName]
if (!preset) {
  console.error(`Nieznany preset: ${presetName}. Dostępne: ${Object.keys(PRESETS).join(', ')}`)
  process.exit(1)
}

const model = process.argv[3] ?? env.OPENROUTER_IMAGE_MODEL ?? 'openai/gpt-image-1'
const size = process.argv[4] ?? preset.size

const body: Record<string, unknown> = { model, prompt: preset.prompt, n: 1, size }
if (preset.background) body.background = preset.background

/**
 * Trasa obrazkowa pośrednika to `POST /images` — samo `/images`, bez
 * `/generations`. Ustalone sondowaniem, bo:
 *   - `chat/completions` z `modalities: ["image"]` → 400 „Use the images or
 *     videos endpoint for this output modality",
 *   - `/images/generations` → 404 i strona HTML pośrednika.
 * Nie zgaduj tej ścieżki przy zmianie modelu (CLAUDE.md § Konfiguracja API).
 */
const response = await fetch(`${env.OPENAI_BASE_URL}/images`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${env.OPENAI_API_KEY}`,
    'content-type': 'application/json',
    'HTTP-Referer': env.APP_URL ?? '',
    'X-Title': env.APP_NAME ?? '',
  },
  body: JSON.stringify(body),
})

const text = await response.text()
if (!response.ok) {
  console.error(`HTTP ${response.status}`)
  console.error(text.slice(0, 900))
  process.exit(1)
}

const payload = JSON.parse(text) as {
  data?: { b64_json?: string; url?: string }[]
  usage?: unknown
}
const first = payload.data?.[0]
if (!first?.b64_json && !first?.url) {
  console.error('Brak obrazka w odpowiedzi. Kształt:')
  console.error(JSON.stringify(payload).slice(0, 900))
  process.exit(1)
}

/** Model zwraca albo base64 w polu, albo link do pobrania. Obsłuż oba. */
const bytes: Buffer = first.b64_json
  ? Buffer.from(first.b64_json, 'base64')
  : Buffer.from(await (await fetch(first.url as string)).arrayBuffer())

const head = bytes.subarray(0, 4).toString('hex')
const ext = head.startsWith('89504e47') ? 'png' : head.startsWith('52494646') ? 'webp' : 'jpg'
mkdirSync('public/arena', { recursive: true })
const outName = process.argv[5] ?? presetName
const file = `public/arena/${outName}.${ext}`
writeFileSync(file, bytes)
console.log(`${file} · ${(bytes.length / 1024).toFixed(0)} KB · ${model} · ${size}`)
console.log('usage:', JSON.stringify(payload.usage))
