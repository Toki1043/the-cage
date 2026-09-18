'use client'

/**
 * Front walki, przeniesiony z prototyp-front.html.
 *
 * Wygląd, animacja i rysowani zawodnicy są te same. Zmieniły się trzy rzeczy:
 *
 * 1. Symulacji tu nie ma. Prototyp liczył walkę w przeglądarce własnym `rng`;
 *    teraz front woła `GET /api/fight` i **odgrywa** zdarzenia z odpowiedzi.
 *    Ani jednego `Math.random()` w tym pliku — wynik przyszedł policzony
 *    i front go tylko pokazuje (CLAUDE.md § Zasada nadrzędna).
 * 2. `window.claude.use("sample")` → `POST /api/commentary`. Tamta funkcja
 *    była częścią środowiska artefaktów claude.ai i na Vercelu nie istnieje.
 * 3. `window.claude.use("db")` i ranking wyłączone do czasu podpięcia bazy.
 *
 * Liczby w narożnikach nie są już wpisywane ręcznie — ciągnie je backend
 * z Codexu, więc pola są tylko do odczytu, a jedyne wejście to dwa adresy.
 *
 * Cała animacja jest imperatywna, na `getElementById`, tak jak w prototypie.
 * Komponent nie trzyma żadnego stanu React i nigdy się nie przerysowuje —
 * gdyby się przerysował, wyczyściłby ring w połowie rundy.
 */

import { useEffect, useRef } from 'react'
import type { TokenFightData } from '@/lib/codex'
import type { FightResult, Side } from '@/lib/fight'
import type { FightApiResponse } from '@/lib/fight-response'
import type { BoardEntry as LadderEntry, Leaderboard as LadderResponse } from '@/lib/leaderboard'
import type { FightStats, WeightClassId } from '@/lib/stats'
import type { CommentaryLine, CommentaryRequest } from './api/commentary/route'
import { drawFighter } from '@/lib/fighter-svg'
import { drawReferee } from '@/lib/referee-svg'
import {
  INSTRUCTIONS,
  fightCancelledCall,
  glassJawCall,
  judgesCall,
  knockdownCall,
  knockoutCall,
  medicalsFailedCall,
  standUpCall,
  technicalCall,
  verdictLine,
  walkoverCall,
} from '@/lib/referee'
import { count, ringsideRead, usd } from '@/lib/ringside'

/* ------------------------------------------------------------------ */
/* Stałe                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ile rund liczy symulacja. Lustro `ROUNDS` z `src/lib/fight.ts`, przepisane,
 * a nie zaimportowane — import wciągnąłby do paczki przeglądarki cały
 * symulator, a to jedyna rzecz, której na froncie być nie może.
 */
const SCHEDULED_ROUNDS = 3

/**
 * Realne kontrakty na Robinhood Chain: AI i WETH. Te same, na których stoją
 * skrypty weryfikacyjne (`scripts/verify-determinism.ts`), więc przycisk
 * pokazuje coś, co na pewno przechodzi przez Codex.
 */
const SAMPLE = {
  a: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
  b: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
}

/** Kategorie wagowe po angielsku — backend trzyma etykiety po polsku. */
const WEIGHT_LABELS: Record<WeightClassId, string> = {
  musza: 'Flyweight',
  lekka: 'Lightweight',
  srednia: 'Middleweight',
  polciezka: 'Light heavyweight',
  ciezka: 'Heavyweight',
}

const STAT_ROWS: readonly (readonly [keyof FightStats, string])[] = [
  ['wytrzymalosc', 'Stamina'],
  ['sila', 'Power'],
  ['garda', 'Guard'],
  ['szybkosc', 'Speed'],
]

/**
 * Taktowanie animacji, w milisekundach.
 *
 * Prototyp odgrywał po dwa ciosy na rundę, bo tyle liczyła jego symulacja.
 * Backend liczy tempo z szybkości, czyli 16–32 ciosy na rundę, z czego ponad
 * połowa to pudła. Dlatego cios trafiony i cios chybiony mają osobne czasy:
 * przy czasach z prototypu jedna runda szłaby pół minuty.
 *
 * Trafiony nie może zejść pod 165 ms w fazie wymachu, bo tyle trwa przejście
 * `.arm-lead` w CSS — przy krótszym ręka nie dochodzi do końca.
 */
const TIMING = {
  instructions: 1100,
  roundIntro: 900,
  stepForward: 95,
  landedWindup: 165,
  landedImpact: 120,
  landedRecover: 85,
  stepBack: 110,
  missWindup: 140,
  missRecover: 55,
  countEight: 110,
  countTen: 150,
  standUp: 500,
  roundEnd: 1100,
  stampHold: 1200,
  judges: 900,
} as const

/**
 * Czasy własnych animacji sędziego, w milisekundach. Muszą pokrywać
 * `refSwing` i `refWave` z globals.css — klasa schodzi po tym czasie, więc
 * krótsza wartość ucięłaby animację w połowie wymachu.
 */
const REF_GONG_MS = 600
const REF_WAVE_MS = 800

/* ------------------------------------------------------------------ */
/* Drobne pomocniki DOM                                                */
/* ------------------------------------------------------------------ */

function need(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Brak elementu #${id}`)
  return node
}

function field(id: string): HTMLInputElement {
  return need(id) as HTMLInputElement
}

const other = (side: Side): Side => (side === 'a' ? 'b' : 'a')

/**
 * Symbol tokena do HTML-a.
 *
 * `symbol()` wpisuje deployer, więc to zwykłe pole tekstowe z łańcucha —
 * bez tego wystarczyłby ticker z `<script>`, żeby wstrzyknąć go w stronę.
 * Zostawiamy znaki, jakie normalne tickery mają, i ucinamy na 16.
 */
function tick(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16) || 'UNNAMED'
}

/** Sekundy albo milisekundy — snapshot bywa zapisany i tak, i tak. */
function toDate(stamp: number): Date {
  return new Date(stamp > 1e12 ? stamp : stamp * 1000)
}

/* ------------------------------------------------------------------ */
/* Komentarz                                                           */
/* ------------------------------------------------------------------ */

/** Te same zdania co w prototypie — walka odbywa się tak czy inaczej. */
function errCopy(code: string): string {
  if (code === 'not_configured') return 'Commentary team stayed home — the fight still happens.'
  if (code === 'not_authorized') return 'Commentary team was turned away at the door. Fight stands.'
  if (code === 'rate_limited') return 'Too many fights at once. The commentators need a minute.'
  if (code === 'invalid_json') return 'The commentary came back as noise. Fight stands.'
  return 'No commentary on this one. Fight stands.'
}

/**
 * Co idzie do modelu: symbole, statystyki, liczby ze snapshotu i to, co się
 * stało w każdej rundzie. Czego nie idzie: zwycięzca, metoda, karta punktowa
 * i punkty życia. Model nie widzi wyniku (CLAUDE.md § Zasada nadrzędna),
 * a werdykt składa `verdictLine` z tego, co policzyła symulacja.
 *
 * Liczba wyprowadzonych i trafionych ciosów jest zliczana ze zdarzeń, bo
 * tylko one to wiedzą — karta rundy podaje same obrażenia.
 */
function commentaryPayload(data: FightApiResponse): CommentaryRequest {
  const corner = (token: TokenFightData) => ({
    symbol: token.symbol,
    weightClass: token.weightClass.id,
    stats: token.stats,
    liquidityUsd: token.snapshot.liquidityUsd,
    marketCapUsd: token.snapshot.marketCapUsd,
    holders: token.snapshot.holders,
    ageDays: token.snapshot.pairAgeDays,
  })

  const thrown = new Map<number, { a: number; b: number }>()
  const landed = new Map<number, { a: number; b: number }>()
  for (const event of data.fight.events) {
    if (event.type !== 'punch') continue
    const t = thrown.get(event.round) ?? { a: 0, b: 0 }
    t[event.attacker] += 1
    thrown.set(event.round, t)
    if (event.landed) {
      const l = landed.get(event.round) ?? { a: 0, b: 0 }
      l[event.attacker] += 1
      landed.set(event.round, l)
    }
  }

  return {
    a: corner(data.tokenA),
    b: corner(data.tokenB),
    rounds: data.fight.rounds.map((round) => ({
      round: round.round,
      thrown: thrown.get(round.round) ?? { a: 0, b: 0 },
      landed: landed.get(round.round) ?? { a: 0, b: 0 },
      damage: round.damage,
      knockdowns: round.knockdowns,
    })),
  }
}

async function fetchCommentary(data: FightApiResponse): Promise<CommentaryLine[] | null> {
  try {
    const response = await fetch('/api/commentary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(commentaryPayload(data)),
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = (body as { error?: string } | null)?.error ?? 'upstream'
      need('arena-status').textContent = errCopy(code)
      return null
    }
    return (body as { rounds?: CommentaryLine[] } | null)?.rounds ?? null
  } catch {
    need('arena-status').textContent = errCopy('upstream')
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Tale of the tape                                                    */
/* ------------------------------------------------------------------ */

function drawTape(a: TokenFightData, b: TokenFightData) {
  need('tape').hidden = false
  need('stats').innerHTML = STAT_ROWS.map(([key, label]) => {
    const av = a.stats[key]
    const bv = b.stats[key]
    return (
      `<div class="stat"><div class="bar l"><i style="width:${av}%"></i><b>${av}</b></div>` +
      `<div class="lbl">${label}</div>` +
      `<div class="bar r"><i style="width:${bv}%"></i><b>${bv}</b></div></div>`
    )
  }).join('')
}

/* ------------------------------------------------------------------ */
/* Ringside read — czysta arytmetyka, bez modelu                        */
/* ------------------------------------------------------------------ */

function drawRead(a: TokenFightData, b: TokenFightData) {
  const reads = [a, b].map((token) =>
    ringsideRead({
      liquidityUsd: token.snapshot.liquidityUsd,
      marketCapUsd: token.snapshot.marketCapUsd,
      ageDays: token.snapshot.pairAgeDays,
    }),
  )
  const [ra, rb] = reads

  const card = (token: TokenFightData, read: typeof ra, side: Side) =>
    `<div class="rcard${side === 'b' ? ' b' : ''}"><h4>$${tick(token.symbol)}</h4><dl>` +
    `<dt>Sell before −10%</dt><dd>about ${usd(read.exitUsd)}</dd>` +
    `<dt>Paper per $1 of exit</dt><dd>$${count(read.paperPerDollar)}</dd>` +
    `<dt>Liquidity</dt><dd>${usd(token.snapshot.liquidityUsd)}</dd>` +
    `<dt>Market cap</dt><dd>${usd(token.snapshot.marketCapUsd)}</dd>` +
    `<dt>Pair age</dt><dd>${count(token.snapshot.pairAgeDays)}d</dd>` +
    `</dl><p class="say">${read.say}</p></div>`

  const thinner = ra.exitUsd < rb.exitUsd ? a : b
  const wider = thinner === a ? b : a
  const wide = Math.max(ra.exitUsd, rb.exitUsd)
  const thin = Math.min(ra.exitUsd, rb.exitUsd)
  const headline =
    `You can move about ${usd(wide)} out of $${tick(wider.symbol)} before the price drops 10%, ` +
    `and only about ${usd(thin)} out of $${tick(thinner.symbol)} — ` +
    `roughly a ${count(wide / Math.max(1, thin))}× difference in how easily you get your money back.`

  const box = document.createElement('div')
  box.className = 'read'
  box.innerHTML =
    '<h3>Ringside read</h3>' +
    '<p class="why">The same numbers the fight runs on, in dollars. No model touches this part. ' +
    'The exit figure assumes a constant-product pool; where liquidity is concentrated (Uniswap v3/v4) ' +
    'the real number lands either side of it, so read it as an order of magnitude, not a quote.</p>' +
    `<div class="reads">${card(a, ra, 'a')}${card(b, rb, 'b')}</div>` +
    `<p class="headline">${headline}</p>`

  const host = need('read-host')
  host.textContent = ''
  host.appendChild(box)
}

/* ------------------------------------------------------------------ */
/* Werdykt — szablon z wyniku symulacji                                */
/* ------------------------------------------------------------------ */

function drawVerdict(data: FightApiResponse) {
  const { fight } = data
  const symbol = (side: Side) => tick(side === 'a' ? data.tokenA.symbol : data.tokenB.symbol)

  const box = document.createElement('div')
  box.className = 'verdict'

  const headline = document.createElement('p')
  headline.className = 'w'
  if (fight.method === 'cancelled') {
    // Odwołana walka nie jest remisem: remis to wynik, a tu wyniku nie ma.
    headline.textContent = 'No contest'
  } else if (fight.winner === null) {
    headline.textContent = 'Draw'
  } else {
    headline.textContent = `$${symbol(fight.winner)} wins`
    headline.style.color = fight.winner === 'a' ? 'var(--red)' : 'var(--blue)'
  }

  const how = document.createElement('p')
  how.className = 'how'
  how.textContent = verdictLine(fight)

  // Ziarno i czas snapshotu razem: bez snapshotu wyniku nie da się odtworzyć,
  // bo dane z Codexu ruszają się w czasie (CLAUDE.md § Determinizm).
  const seed = document.createElement('p')
  seed.className = 'seed'
  const taken = toDate(data.tokenA.snapshot.fetchedAt)
  seed.textContent =
    `Fight seed ${fight.seed.slice(0, 12)}… — these two contracts always fight this way. ` +
    `Input snapshot taken ${taken.toISOString().slice(0, 16).replace('T', ' ')} UTC.`

  box.append(headline, how, seed)
  const host = need('verdict-host')
  host.textContent = ''
  host.appendChild(box)
}

/* ------------------------------------------------------------------ */
/* Ring: odgrywanie zdarzeń z backendu                                 */
/* ------------------------------------------------------------------ */

interface Clock {
  skip: boolean
}

/**
 * Odtwarzacz jednej walki.
 *
 * Nie podejmuje żadnej decyzji o przebiegu — przechodzi po `fight.events`
 * i zamienia je na klasy CSS. Odliczanie sędziego jest animacją, nie
 * losowaniem: jeśli symulacja dała nokaut, odliczanie zawsze dochodzi
 * do dziesięciu (CLAUDE.md § Sędzia).
 */
function createRing(data: FightApiResponse, clock: Clock) {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const sleep = (ms: number) =>
    new Promise<void>((resolve) =>
      setTimeout(resolve, clock.skip ? 0 : reduce ? Math.min(ms, 120) : ms),
    )

  const symbols: Record<Side, string> = {
    a: tick(data.tokenA.symbol),
    b: tick(data.tokenB.symbol),
  }
  const hpStart = data.fight.hpStart

  // Panel kwestii: linia sędziego, linia komentatora, linia barwy.
  const panel = { ref: '', call: '', colour: '' }
  function renderCalls() {
    const host = need('calls')
    host.textContent = ''
    const add = (className: string, text: string) => {
      if (!text) return
      const p = document.createElement('p')
      if (className) p.className = className
      p.textContent = text
      host.appendChild(p)
    }
    add('ref', panel.ref)
    add('', panel.call)
    add('col', panel.colour)
  }

  const setRef = (text: string) => {
    panel.ref = text
    renderCalls()
  }

  const setRoundTag = (text: string) => {
    need('roundtag').textContent = text
  }

  const setHp = (side: Side, pct: number) => {
    need(`f-${side}-hp`).style.width = `${Math.max(0, Math.min(100, pct))}%`
  }

  function pop(side: Side, text: string) {
    const host = need(`f-${side}`)
    const span = document.createElement('span')
    span.className = 'pop'
    span.textContent = text
    host.appendChild(span)
    setTimeout(() => span.remove(), 1100)
  }

  function flash() {
    const node = need('flash')
    node.classList.remove('on')
    void node.offsetWidth
    node.classList.add('on')
  }

  /**
   * Klasa na czas jednej animacji sędziego.
   *
   * Zdjęcie klasy i wymuszony reflow, bo ta sama klasa wraca przed końcem
   * poprzedniej animacji — gong bije co rundę. Bez tego przeglądarka nie
   * odtwarza jej drugi raz i pałka zostaje w miejscu.
   */
  function refCue(className: string, ms: number) {
    const node = need('ref-fig')
    node.classList.remove(className)
    void node.offsetWidth
    node.classList.add(className)
    setTimeout(() => node.classList.remove(className), clock.skip ? 0 : ms)
  }

  function stamp(text: string) {
    need('kotext').textContent = text
    need('kostamp').hidden = false
    const arena = need('arena')
    arena.classList.add('shake')
    setTimeout(() => arena.classList.remove('shake'), 450)
  }

  /** Odliczanie: 1 … 2 … 3, dopisywane do kwestii sędziego. */
  async function countTo(to: number, lead: string, step: number) {
    const ref = need('ref-fig')
    ref.classList.add('counting')
    const spoken: number[] = []
    for (let n = 1; n <= to; n++) {
      spoken.push(n)
      setRef(`${lead} ${spoken.join(' … ')}`)
      await sleep(step)
    }
    ref.classList.remove('counting')
  }

  async function throwPunch(event: Extract<FightResult['events'][number], { type: 'punch' }>) {
    const attacker = need(`f-${event.attacker}`)
    const defenderSide = other(event.attacker)
    const defender = need(`f-${defenderSide}`)

    attacker.classList.add('step-forward')
    await sleep(TIMING.stepForward)

    attacker.classList.add('punch')

    if (!event.landed) {
      await sleep(TIMING.missWindup)
      attacker.classList.remove('punch')
      attacker.classList.add('step-back')
      attacker.classList.remove('step-forward')
      await sleep(TIMING.stepBack)
      attacker.classList.remove('step-back')
      await sleep(TIMING.missRecover)
      return
    }

    await sleep(TIMING.landedWindup)
    defender.classList.add('hit')
    flash()
    pop(defenderSide, `-${Math.max(1, Math.round(event.damage))}`)
    setHp(defenderSide, (event.defenderHp / hpStart[defenderSide]) * 100)
    await sleep(TIMING.landedImpact)
    attacker.classList.remove('punch')
    defender.classList.remove('hit')
    attacker.classList.add('step-back')
    attacker.classList.remove('step-forward')
    await sleep(TIMING.stepBack)
    attacker.classList.remove('step-back')
    await sleep(TIMING.landedRecover)
  }

  function reset() {
    const arena = need('arena')
    arena.hidden = false
    // Światła gasną. Wejście zostaje kremowym plakatem, walka idzie w ciemnej
    // hali — klasa podmienia zmienne areny, patrz globals.css § światła gasną.
    arena.classList.add('lights-down')
    need('read-host').textContent = ''
    need('verdict-host').textContent = ''
    need('kostamp').hidden = true

    for (const side of ['a', 'b'] as const) {
      const token = side === 'a' ? data.tokenA : data.tokenB
      const host = need(`f-${side}`)
      host.classList.remove('down', 'punch', 'hit')
      host.innerHTML = drawFighter(
        {
          symbol: symbols[side],
          stamina: token.stats.wytrzymalosc,
          power: token.stats.sila,
          ageDays: token.snapshot.pairAgeDays,
        },
        side,
      )
      need(`f-${side}-tick`).textContent = `$${symbols[side]}`
      need(`f-${side}-meta`).textContent =
        `${count(token.snapshot.holders)} holders · ${count(token.snapshot.pairAgeDays)}d · ` +
        WEIGHT_LABELS[token.weightClass.id].toLowerCase()
      setHp(side, 100)
    }

    const ref = need('ref-fig')
    ref.className = 'referee'
    ref.innerHTML = drawReferee()

    setRoundTag('Staredown')
    panel.ref = ''
    panel.call = ''
    panel.colour = 'Both fighters are in the ring. Waiting on the commentary team.'
    renderCalls()
  }

  async function play(commentary: CommentaryLine[] | null) {
    for (const event of data.fight.events) {
      switch (event.type) {
        // Badania przed pierwszym dzwonkiem. Zawodnik z koncentracją podaży
        // od 70% w górę nie wchodzi do ringu — bez tych trzech gałęzi
        // walkower byłby pustą animacją i werdyktem bez wyjaśnienia.
        case 'medicalsFailed': {
          setRoundTag('Pre-fight check')
          panel.call = ''
          panel.colour = ''
          need(`f-${event.fighter}`).classList.add('down')
          setRef(medicalsFailedCall(symbols[event.fighter], event.concentrationPercent))
          refCue('talking', TIMING.instructions)
          await sleep(TIMING.instructions)
          break
        }
        case 'fightCancelled': {
          setRoundTag('No contest')
          setRef(fightCancelledCall(symbols.a, symbols.b))
          refCue('waving', REF_WAVE_MS)
          stamp('NO CONTEST')
          await sleep(TIMING.stampHold)
          break
        }
        case 'walkover': {
          setRoundTag('Walkover')
          setRef(walkoverCall(symbols[event.winner], symbols[event.loser]))
          refCue('waving', REF_WAVE_MS)
          stamp('W/O')
          await sleep(TIMING.stampHold)
          break
        }
        case 'glassJaw': {
          setRef(glassJawCall(symbols[event.fighter], event.concentrationPercent))
          refCue('waving', REF_WAVE_MS)
          break
        }
        case 'instructions': {
          setRoundTag('Instructions')
          panel.call = ''
          panel.colour = ''
          setRef(INSTRUCTIONS)
          refCue('talking', TIMING.instructions)
          await sleep(TIMING.instructions)
          break
        }
        case 'roundStart': {
          setRoundTag(`Round ${event.round} of ${SCHEDULED_ROUNDS}`)
          const line = commentary?.[event.round - 1]
          panel.ref = ''
          panel.call = line?.call ?? ''
          panel.colour = line?.colour ?? ''
          renderCalls()
          refCue('gong-hit', REF_GONG_MS)
          await sleep(TIMING.roundIntro)
          break
        }
        case 'punch': {
          await throwPunch(event)
          break
        }
        case 'knockdown': {
          const down = need(`f-${event.fighter}`)
          down.classList.add('down')
          await countTo(event.countTo, knockdownCall(symbols[event.fighter]), TIMING.countEight)
          down.classList.remove('down')
          setRef(standUpCall(symbols[event.fighter]))
          await sleep(TIMING.standUp)
          break
        }
        case 'roundEnd': {
          setRoundTag(`End of round ${event.round}`)
          await sleep(TIMING.roundEnd)
          break
        }
        case 'knockout': {
          const loser = other(event.winner)
          need(`f-${loser}`).classList.add('down')
          await countTo(event.countTo, knockoutCall(symbols[loser]), TIMING.countTen)
          stamp('KO')
          await sleep(TIMING.stampHold)
          break
        }
        case 'technicalKnockout': {
          const loser = other(event.winner)
          need(`f-${loser}`).classList.add('down')
          setRef(technicalCall(symbols[loser], event.knockdowns))
          refCue('waving', REF_WAVE_MS)
          stamp('TKO')
          await sleep(TIMING.stampHold)
          break
        }
        case 'decision': {
          setRoundTag('To the judges')
          setRef(judgesCall())
          refCue('judging', TIMING.judges)
          await sleep(TIMING.judges)
          break
        }
      }
    }
  }

  return { reset, play }
}

/* ------------------------------------------------------------------ */
/* Narożniki                                                           */
/* ------------------------------------------------------------------ */

function fillCorner(side: Side, token: TokenFightData) {
  need(`${side}-ticker`).textContent = `$${tick(token.symbol)}`
  need(`${side}-mcap`).textContent = usd(token.snapshot.marketCapUsd)
  need(`${side}-liq`).textContent = usd(token.snapshot.liquidityUsd)
  need(`${side}-holders`).textContent = count(token.snapshot.holders)
  need(`${side}-age`).textContent = `${count(token.snapshot.pairAgeDays)}d`
  need(`${side}-weight`).textContent = WEIGHT_LABELS[token.weightClass.id]
}

/**
 * Licznik obserwowanych portfeli w obu narożnikach.
 *
 * Front dostaje wyłącznie liczby: ile adresów z listy trzyma tokena i ile
 * adresów jest na liście. Samej listy tu nie ma i nie może być — siedzi
 * w zmiennej `TRACKED_WALLETS` po stronie serwera (`src/lib/tracked.ts`).
 *
 * Ułamek surowo, „3 of 40", bez etykiety w rodzaju „smart money": portfel na
 * liście jest tam, bo ktoś go wpisał, nie bo cokolwiek udowodnił
 * (CLAUDE.md § Narożnik: holderzy).
 */
function fillTracked(data: FightApiResponse) {
  // Karta otwarta przed wdrożeniem trafia na odpowiedź bez tego pola. Bez
  // zapasu rozpakowanie `undefined` wywraca cały przebieg walki na ozdobie.
  const tracked = data.tracked ?? { configured: false, watched: 0, a: null, b: null, note: null }
  const note = need('tracked-note')

  for (const side of ['a', 'b'] as const) {
    const row = need(`${side}-tracked-row`)
    row.hidden = !tracked.configured
    if (!tracked.configured) continue
    const held = side === 'a' ? tracked.a : tracked.b
    // Kreska, nie zero: nieudane sprawdzenie nie jest brakiem trafień.
    need(`${side}-tracked`).textContent =
      held === null ? '—' : `${count(held)} of ${count(tracked.watched)}`
  }

  note.hidden = !tracked.configured
  if (!tracked.configured) return
  note.textContent =
    tracked.a === null && tracked.b === null
      ? 'Watched wallets could not be checked this round. The fight is unaffected either way.'
      : 'Watched wallets: addresses from a private server-side list holding this contract. ' +
        'A count, not a signal — nobody here is labelled smart money, and it changes nothing ' +
        'about the fight.'
}

/**
 * Walka między kategoriami dostaje widoczne oznaczenie — lżejszy bije powyżej
 * swojej wagi (CLAUDE.md § Kategorie wagowe). Bez tego wynik z dwóch różnych
 * półek wyglądałby jak uczciwe porównanie.
 */
function showMatchup(data: FightApiResponse) {
  const node = need('crossclass')
  const { matchup } = data
  if (!matchup.crossClass || matchup.punchingUp === null) {
    node.hidden = true
    node.textContent = ''
    return
  }
  const up = matchup.punchingUp === 'a' ? data.tokenA : data.tokenB
  const down = matchup.punchingUp === 'a' ? data.tokenB : data.tokenA
  const classes = matchup.classGap === 1 ? 'one class' : `${matchup.classGap} classes`
  node.textContent =
    `$${tick(up.symbol)} is punching up: ${WEIGHT_LABELS[up.weightClass.id].toLowerCase()} ` +
    `against ${WEIGHT_LABELS[down.weightClass.id].toLowerCase()}, ${classes} above its own. ` +
    'Different shelves — the ladder keeps them apart.'
  node.hidden = false
}

/* ------------------------------------------------------------------ */
/* Drabina: ranking per kontrakt                                       */
/* ------------------------------------------------------------------ */

/**
 * Jedna pozycja listy.
 *
 * Symbol leci przez `tick()`, bo wiersz idzie do `innerHTML`, a symbol tokena
 * jest ciągiem z łańcucha — kto go wystawia, ten go wpisuje. `tick()` zostawia
 * wyłącznie litery, cyfry i trzy znaki, więc nic się stąd nie wykona.
 *
 * Bilans pisany surowo, „2-1-0". Bez etykiet mówiących, czy token jest dobry:
 * pozycja na liście to liczba wygranych walk, nie ocena kontraktu.
 */
function ladderRow(entry: LadderEntry): string {
  const r = entry.record
  const ko = r.knockouts > 0 ? `<span class="ko">${r.knockouts} by stoppage</span>` : ''
  const up = r.crossClassFights > 0 ? `<span class="up">${r.crossClassFights} out of class</span>` : ''
  return (
    `<li><span class="rank">${entry.rank}</span>` +
    `<span class="tick">$${tick(r.symbol)}</span>` +
    `<span class="rec">${r.wins}-${r.losses}-${r.draws}</span>` +
    `<span class="pts">${entry.points} pts</span>` +
    ko +
    up +
    `</li>`
  )
}

/**
 * Pięć list obok siebie, po jednej na kategorię wagową.
 *
 * Pusta kategoria zostaje na widoku zamiast zniknąć — inaczej po pierwszej
 * walce wyglądałoby to, jakby istniała tylko jedna półka.
 *
 * Drabina nigdy nie przewraca strony: jak ranking nie odpowiada, wchodzi
 * jedno zdanie i tyle. Walka jest ważniejsza niż lista.
 */
async function drawLadder(): Promise<void> {
  const host = document.getElementById('ladder')
  if (!host) return

  try {
    const response = await fetch('/api/leaderboard?limit=10', { cache: 'no-store' })
    if (!response.ok) throw new Error('ladder')
    const board = (await response.json()) as LadderResponse

    host.innerHTML = board.boards
      .map((list) => {
        const rows = list.entries.length
          ? `<ol>${list.entries.map(ladderRow).join('')}</ol>`
          : '<p class="none">Nobody has fought in this class yet.</p>'
        return (
          `<div class="board"><h4>${WEIGHT_LABELS[list.weightClass.id]}` +
          `<span class="cnt">${list.total}</span></h4>${rows}</div>`
        )
      })
      .join('')

    const note = document.getElementById('ladder-note')
    if (note) {
      // Bez bazy ranking stoi na pamięci procesu. Lepiej to napisać, niż
      // pozwolić komuś liczyć na listę, która zniknie przy następnym wdrożeniu.
      note.textContent = board.persistent
        ? ''
        : 'No database wired yet — these records live in server memory and reset on the next deploy.'
    }
  } catch {
    host.innerHTML = '<p class="none">The ladder is not answering right now.</p>'
  }
}

/* ------------------------------------------------------------------ */
/* Komponent                                                           */
/* ------------------------------------------------------------------ */

export default function Home() {
  const busy = useRef(false)
  const clock = useRef<Clock>({ skip: false })

  // Drabina wczytuje się raz, po zamontowaniu. `useEffect` nie dodaje stanu,
  // więc komponent nadal nigdy się nie przerysowuje i nie czyści ringu
  // w połowie rundy.
  useEffect(() => {
    void drawLadder()
  }, [])

  function loadSample() {
    field('a-addr').value = SAMPLE.a
    field('b-addr').value = SAMPLE.b
    need('status').textContent = 'Two real contracts on Robinhood Chain. Make the fight.'
  }

  function onSkip() {
    clock.current.skip = true
    need('skip').hidden = true
  }

  async function go() {
    if (busy.current) return

    const a = field('a-addr').value.trim()
    const b = field('b-addr').value.trim()
    const status = need('status')

    if (!a || !b) {
      status.textContent = 'Both corners need a contract address.'
      return
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      status.textContent = 'Two different contracts — a token does not fight itself.'
      return
    }

    busy.current = true
    clock.current = { skip: false }
    const goButton = need('go') as HTMLButtonElement
    goButton.disabled = true
    need('skip').hidden = true
    status.textContent = 'Pulling both corners off the chain…'

    try {
      const response = await fetch(
        `/api/fight?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
      )
      const body: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        status.textContent =
          (body as { error?: string } | null)?.error ?? 'Could not build the fight.'
        return
      }

      const data = body as FightApiResponse
      status.textContent = ''

      fillCorner('a', data.tokenA)
      fillCorner('b', data.tokenB)
      fillTracked(data)
      showMatchup(data)
      drawTape(data.tokenA, data.tokenB)

      const ring = createRing(data, clock.current)
      ring.reset()
      need('arena').scrollIntoView({ behavior: 'smooth', block: 'center' })

      // Komentarz przed pierwszym gongiem: kwestie z rundy pierwszej muszą
      // być gotowe, zanim ruszy animacja. Walka i tak się odbędzie, jeśli
      // ich nie będzie.
      need('arena-status').textContent = ''
      const commentary = await fetchCommentary(data)
      need('note').textContent = commentary
        ? 'Result is maths. Commentary is a model.'
        : 'Result is maths. No commentary on this one.'

      need('skip').hidden = false
      await ring.play(commentary)
      need('skip').hidden = true

      need('roundtag').textContent = 'Final'
      drawRead(data.tokenA, data.tokenB)
      drawVerdict(data)
      need('verdict-host').scrollIntoView({ behavior: 'smooth', block: 'center' })

      // Wynik jest już zapisany po stronie serwera — tu tylko przeciągamy
      // odświeżoną listę. Zapis jest idempotentny po parze adresów, więc
      // druga ta sama walka nie dopisze drugiego zwycięstwa.
      await drawLadder()
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'Could not reach the fight service.'
    } finally {
      busy.current = false
      ;(need('go') as HTMLButtonElement).disabled = false
    }
  }

  return (
    <div className="wrap">
      <header className="poster">
        <div className="venue">Sanctioned by nobody · No commission recognises this</div>
        <h1>
          Red corner<span className="v">versus</span>Blue corner
        </h1>
        <p>
          Two contracts, four stats each, three rounds. The numbers decide who wins — the
          commentary team just has to watch it happen.
        </p>
      </header>

      <section className="corners">
        <Corner side="a" title="Red corner" />
        <Corner side="b" title="Blue corner" />
      </section>

      <div className="controls">
        <button className="chip" type="button" onClick={loadSample}>
          Load a real undercard
        </button>
        <button className="main" id="go" type="button" onClick={go}>
          Make the fight
        </button>
      </div>
      <p className="status" id="status">
        Both corners fill themselves from the chain. Paste two contract addresses.
      </p>
      <p className="crossclass" id="crossclass" hidden />
      {/* Jedno zdanie pod oba narożniki, a nie po jednym w każdym: ta sama
          uwaga powtórzona dwa razy czyta się jak ostrzeżenie o czymś innym. */}
      <p className="tracked-note" id="tracked-note" hidden />

      <section className="arena" id="arena" hidden>
        <div className="scoreboard">
          <div className="sb a">
            <div className="nm" id="f-a-tick" />
            <div className="meta" id="f-a-meta" />
            <div className="hpbar">
              <i id="f-a-hp" />
            </div>
          </div>
          <div className="roundtag" id="roundtag" />
          <div className="sb b">
            <div className="nm" id="f-b-tick" />
            <div className="meta" id="f-b-meta" />
            <div className="hpbar">
              <i id="f-b-hp" />
            </div>
          </div>
        </div>
        <div className="ring">
          <div className="backdrop" />
          <div className="ropes">
            <span />
            <span />
            <span />
          </div>
          <div className="stage">
            <div className="floor" />
            <div className="fighter a" id="f-a" />
            <div className="fighter b" id="f-b" />
            <div className="referee" id="ref-fig" />
          </div>
          <div className="flash" id="flash" />
          <div className="kostamp" id="kostamp" hidden>
            <b id="kotext">KO</b>
          </div>
        </div>
        <div className="calls" id="calls" />
        <div className="bottom">
          <span className="status" id="arena-status" style={{ margin: 0, textAlign: 'left' }} />
          <button id="skip" type="button" onClick={onSkip} hidden>
            Skip to result
          </button>
        </div>
      </section>

      <section className="tape" id="tape" hidden>
        <h3>Tale of the tape</h3>
        <div id="stats" />
      </section>

      <section id="read-host" />
      <section id="verdict-host" />

      <section className="ladder">
        <h3>The ladder</h3>
        <p className="sub">
          One list per weight class, per contract rather than per fight. A contract carries its
          record around. Three points for a win, one for a draw — that is all a place on this list
          means. It is a fight record, not a verdict on the token.
        </p>
        <div className="scroller" id="ladder">
          <p className="none">Loading the ladder…</p>
        </div>
        <p className="sub" id="ladder-note" />
      </section>

      <footer>
        <span>Entertainment. A token that wins a fight is still a token.</span>
        <span id="note" />
      </footer>
    </div>
  )
}

/**
 * Narożnik. Adres jest jedynym polem do wpisania — i jedynym, które wygląda
 * jak pole.
 *
 * Reszta liczb przychodzi z `/api/fight`, więc jest odczytem, nie formularzem.
 * Wcześniej stały tu inputy z `readOnly`: pole, w które nie da się pisać,
 * czyta się jak zepsuty formularz, a nie jak dane.
 */
function Corner({ side, title }: { side: Side; title: string }) {
  return (
    <div className={`corner ${side}`}>
      <h2>
        <span>{title}</span>
        <span className="weight" id={`${side}-weight`} />
      </h2>
      <label className="field">
        <span>Contract address</span>
        <input id={`${side}-addr`} autoComplete="off" spellCheck={false} placeholder="0x…" />
      </label>
      <div className="readout">
        <div className="tick" id={`${side}-ticker`} />
        <dl>
          <div>
            <dt>Market cap</dt>
            <dd id={`${side}-mcap`}>—</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd id={`${side}-liq`}>—</dd>
          </div>
          <div>
            <dt>Holders</dt>
            <dd id={`${side}-holders`}>—</dd>
          </div>
          <div>
            <dt>Pair age</dt>
            <dd id={`${side}-age`}>—</dd>
          </div>
          {/* Wiersz na całą szerokość i domyślnie schowany: bez listy
              obserwowanych portfeli po stronie serwera nie ma tu czego
              pokazać, a puste pole czyta się jak zero trafień. */}
          <div className="wide" id={`${side}-tracked-row`} hidden>
            <dt>Watched wallets</dt>
            <dd id={`${side}-tracked`}>—</dd>
          </div>
        </dl>
        <p className="hint">Read from the chain, not typed. Snapshot taken when the bell rings.</p>
      </div>
    </div>
  )
}
