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
import type { CommentaryEvent, CommentaryLine, CommentaryRequest } from '@/lib/commentary'
import { drawFighter } from '@/lib/fighter-svg'
import { drawReferee } from '@/lib/referee-svg'
import { HallBanners } from './hall-banners'
import {
  INSTRUCTIONS,
  fightCancelledCall,
  glassJawCall,
  holdersFailedCall,
  honeypotFailedCall,
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
import type { SecurityChecks, SecurityFlag } from '@/lib/security'
import { explainFight, type WhyCell } from '@/lib/why'

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
/** Zdanie w panelu, dopóki kwestia danej rundy nie dojdzie z modelu. */
const WAITING_FOR_LINE = 'The commentators are still on the line…'

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
    volume24hUsd: token.snapshot.volume24hUsd,
    vulnerability: token.vulnerability,
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

/**
 * Kwestie komentatorów, które dochodzą w trakcie walki.
 *
 * Walka nie czeka na komentarz: startuje od razu, a każda runda dokleja się do
 * panelu w chwili, gdy model ją domknie. `lines[i]` jest puste, dopóki runda
 * `i + 1` nie dojdzie; `onLine` woła się przy każdej, która dojdzie.
 */
interface Commentary {
  lines: (CommentaryLine | undefined)[]
  onLine: ((index: number, line: CommentaryLine) => void) | null
  /** `pending` do końca strumienia; potem `done` (są kwestie) albo `failed` (nie ma żadnej). */
  state: 'pending' | 'done' | 'failed'
  /** Przerywa strumień; serwer przerywa wtedy wywołanie modelu. */
  abort: () => void
}

/**
 * Otwiera strumień NDJSON z `/api/commentary` i zwraca od razu, bez czekania.
 *
 * Nigdy nie rzuca: brak komentarza nie może przewrócić walki. Awaria kończy się
 * zdaniem w `arena-status` i stanem `failed`, a kwestie, które już doszły,
 * zostają nawet wtedy, gdy strumień urwie się po drodze.
 */
function openCommentary(
  data: FightApiResponse,
  onSettled: (state: 'done' | 'failed') => void,
): Commentary {
  const controller = new AbortController()
  const commentary: Commentary = {
    lines: [],
    onLine: null,
    state: 'pending',
    abort: () => controller.abort(),
  }

  const settle = (state: 'done' | 'failed', code?: string) => {
    if (commentary.state !== 'pending') return
    commentary.state = state
    if (state === 'failed') need('arena-status').textContent = errCopy(code ?? 'upstream')
    onSettled(state)
  }

  const handle = (raw: string) => {
    if (!raw.trim()) return
    let event: CommentaryEvent
    try {
      event = JSON.parse(raw) as CommentaryEvent
    } catch {
      return
    }
    if (event.type === 'round') {
      const line = { call: event.call, colour: event.colour }
      commentary.lines[event.index] = line
      commentary.onLine?.(event.index, line)
    } else if (event.type === 'done') {
      settle('done')
    } else {
      // Błąd po części rund nie unieważnia tych, które już są.
      settle(commentary.lines.some(Boolean) ? 'done' : 'failed', event.code)
    }
  }

  void (async () => {
    try {
      const response = await fetch('/api/commentary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commentaryPayload(data)),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        // Błędy sprzed pierwszego tokenu wracają jako zwykły JSON ze statusem.
        const body: unknown = await response.json().catch(() => null)
        settle('failed', (body as { error?: string } | null)?.error ?? 'upstream')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          handle(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      }
      handle(buffer)
      // Strumień skończył się bez `done` i bez `error` (urwane połączenie).
      settle(commentary.lines.some(Boolean) ? 'done' : 'failed', 'upstream')
    } catch {
      // Przerwanie przez nas (koniec walki) to nie błąd i nic nie ma do pokazania.
      if (controller.signal.aborted) return
      settle(commentary.lines.some(Boolean) ? 'done' : 'failed', 'upstream')
    }
  })()

  return commentary
}

/* ------------------------------------------------------------------ */
/* Tale of the tape                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tale of the tape jako dwie osobne karty zamiast jednego paska porównania —
 * czerwona karta po lewej, niebieska po prawej (nowy układ areny).
 */
function drawTape(a: TokenFightData, b: TokenFightData) {
  const rows = (token: TokenFightData) =>
    STAT_ROWS.map(([key, label]) => {
      const v = token.stats[key]
      return (
        `<div class="stat-row"><span class="stat-lbl">${label}</span>` +
        `<div class="stat-bar"><i style="width:${v}%"></i></div>` +
        `<span class="stat-val">${v}</span></div>`
      )
    }).join('')
  need('stats-a').innerHTML = rows(a)
  need('stats-b').innerHTML = rows(b)
}

/* ------------------------------------------------------------------ */
/* Ringside read — czysta arytmetyka, bez modelu                        */
/* ------------------------------------------------------------------ */

/**
 * Ringside read jako dwie osobne pływające karty (czerwona po lewej,
 * niebieska po prawej) plus jedna wspólna linijka porównania w panelu
 * sędziego na dole — zamiast jednego bloku pod areną.
 */
function drawRead(a: TokenFightData, b: TokenFightData) {
  const reads = [a, b].map((token) =>
    ringsideRead({
      liquidityUsd: token.snapshot.liquidityUsd,
      marketCapUsd: token.snapshot.marketCapUsd,
      ageDays: token.snapshot.pairAgeDays,
    }),
  )
  const [ra, rb] = reads

  const fill = (side: Side, token: TokenFightData, read: typeof ra) => {
    const box = need(`read-card-${side}`)
    box.innerHTML =
      '<h4>Ringside read</h4><dl>' +
      `<dt>Sell before −10%</dt><dd>about ${usd(read.exitUsd)}</dd>` +
      `<dt>Paper per $1 of exit</dt><dd>$${count(read.paperPerDollar)}</dd>` +
      `<dt>Liquidity</dt><dd>${usd(token.snapshot.liquidityUsd)}</dd>` +
      `<dt>Market cap</dt><dd>${usd(token.snapshot.marketCapUsd)}</dd>` +
      `<dt>Pair age</dt><dd>${count(token.snapshot.pairAgeDays)}d</dd>` +
      `</dl><p class="say">${read.say}</p>`
    box.hidden = false
  }
  fill('a', a, ra)
  fill('b', b, rb)

  const thinner = ra.exitUsd < rb.exitUsd ? a : b
  const wider = thinner === a ? b : a
  const wide = Math.max(ra.exitUsd, rb.exitUsd)
  const thin = Math.min(ra.exitUsd, rb.exitUsd)
  const ratio = wide / Math.max(1, thin)

  const headline = need('read-headline')
  // Sub-1.2x is noise, not a real gap — a "1x difference" reads as a claim
  // that one side is worse, when the exit costs the same either way.
  headline.textContent =
    ratio < 1.2
      ? `Exiting either token costs about the same before the price drops 10%: roughly ${usd(wide)} ` +
        `out of $${tick(wider.symbol)} and ${usd(thin)} out of $${tick(thinner.symbol)}.`
      : `You can move about ${usd(wide)} out of $${tick(wider.symbol)} before the price drops 10%, ` +
        `and only about ${usd(thin)} out of $${tick(thinner.symbol)} — ` +
        `roughly a ${count(ratio)}× difference in how easily you get your money back.`
  headline.hidden = false
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

  // Ziarno, czas snapshotu i zdanie o determinizmie mieszkają teraz w linii
  // o źródle w panelu WHY (`why.ts`): ta sama treść dokładniej, bo mówi
  // też, że dane z Codexu ruszają się w czasie (CLAUDE.md § Determinizm).
  box.append(headline, how)
  const host = need('verdict-host')
  host.textContent = ''
  host.appendChild(box)
}

/* ------------------------------------------------------------------ */
/* WHY — stała tabela, czysta arytmetyka                                */
/* ------------------------------------------------------------------ */

/**
 * Panel „WHY": każda statystyka obok surowej liczby, z której powstała,
 * jedno zdanie liczone z tych liczb i linia o źródle.
 *
 * To nie jest komentarz: nic tu nie przechodzi przez model, a panel nie znika
 * z ekranu po kilku sekundach jak kwestie komentatorów — zostaje do następnej
 * walki. Cała treść przychodzi z `explainFight`. Tekst wchodzi przez
 * `textContent`, nie przez `innerHTML`: symbol tokena wpisuje deployer.
 */
function whyCell(cell: WhyCell): HTMLTableCellElement {
  const td = document.createElement('td')
  if (cell.score !== null) {
    const score = document.createElement('b')
    score.textContent = String(cell.score)
    const raw = document.createElement('span')
    raw.textContent = ` ← ${cell.raw}`
    td.append(score, raw)
  } else {
    td.textContent = cell.raw
  }
  if (cell.warn) td.classList.add('flag-detected')
  return td
}

function setWhyOpen(open: boolean) {
  need('why-body').hidden = !open
  need('why-hint').textContent = open ? 'hide ▾' : 'show ▸'
  need('why-toggle').setAttribute('aria-expanded', String(open))
}

function drawWhy(data: FightApiResponse) {
  const why = explainFight(data)

  const table = need('why-table') as HTMLTableElement
  table.textContent = ''

  const head = table.createTHead().insertRow()
  const corner = document.createElement('th')
  corner.scope = 'col'
  corner.textContent = 'stat ← on-chain number'
  const heads = (['a', 'b'] as const).map((side) => {
    const th = document.createElement('th')
    th.scope = 'col'
    th.className = side === 'a' ? 'red' : 'blue'
    th.textContent = `$${why.symbols[side]}`
    return th
  })
  head.append(corner, ...heads)

  const body = table.createTBody()
  for (const row of why.rows) {
    const tr = body.insertRow()
    const label = document.createElement('th')
    label.scope = 'row'
    label.textContent = row.label
    tr.append(label, whyCell(row.a), whyCell(row.b))
  }

  need('why-sentence').textContent = why.sentence
  need('why-source').textContent = why.source
  // Zwinięty po każdej walce: ring z wynikiem ma być widoczny od razu, a tabela
  // czeka na kliknięcie. Otwarty stan poprzedniej walki się nie przenosi.
  setWhyOpen(false)
  need('why-panel').hidden = false
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
    // Karty ringside read i werdykt należą do poprzedniej walki — nowa walka
    // chowa je z powrotem, aż drawRead/drawVerdict wypełnią je na nowo.
    need('read-card-a').hidden = true
    need('read-card-a').innerHTML = ''
    need('read-card-b').hidden = true
    need('read-card-b').innerHTML = ''
    need('read-headline').hidden = true
    need('verdict-host').textContent = ''
    // Tabela WHY też należy do poprzedniej walki.
    need('why-panel').hidden = true
    need('why-table').textContent = ''
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

  async function play(commentary: Commentary | null) {
    // Runda, której kwestie są teraz na ekranie. Linia z modelu, która dojdzie
    // w trakcie tej rundy, dokleja się do panelu; ta, która dojdzie za późno
    // (runda już minęła), nie nadpisze kwestii kolejnej.
    let currentRound = 0
    if (commentary) {
      commentary.onLine = (index, line) => {
        if (index + 1 !== currentRound) return
        panel.call = line.call
        panel.colour = line.colour
        renderCalls()
      }
    }

    for (const event of data.fight.events) {
      switch (event.type) {
        // Badania przed pierwszym dzwonkiem. Zawodnik z zbyt małą liczbą
        // holderów, z honeypotem wykrytym przez GoPlus albo z koncentracją
        // podaży od 70% w górę nie wchodzi do ringu — bez tych trzech gałęzi
        // walkower byłby pustą animacją i werdyktem bez wyjaśnienia.
        case 'medicalsFailed': {
          setRoundTag('Pre-fight check')
          panel.call = ''
          panel.colour = ''
          need(`f-${event.fighter}`).classList.add('down')
          setRef(
            event.reason === 'holders'
              ? holdersFailedCall(symbols[event.fighter], event.holders, event.minHolders)
              : event.reason === 'honeypot'
                ? honeypotFailedCall(symbols[event.fighter])
                : medicalsFailedCall(symbols[event.fighter], event.concentrationPercent),
          )
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
          currentRound = event.round
          const line = commentary?.lines[event.round - 1]
          panel.ref = ''
          panel.call = line?.call ?? ''
          // Kwestia jeszcze nie doszła: zdanie zastępcze, które `onLine` podmieni.
          panel.colour = line?.colour ?? (commentary?.state === 'pending' ? WAITING_FOR_LINE : '')
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
    // Walka skończona: kolejne kwestie nie mają już dokąd wracać.
    if (commentary) commentary.onLine = null
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
  need(`tape-card-${side}`).hidden = false
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

  for (const side of ['a', 'b'] as const) {
    const row = need(`${side}-tracked-row`)
    row.hidden = !tracked.configured
    need(`${side}-goat-help`).hidden = true
    need(`${side}-goat-help-btn`).setAttribute('aria-expanded', 'false')
    if (!tracked.configured) continue
    const held = side === 'a' ? tracked.a : tracked.b
    // Kreska, nie zero: nieudane sprawdzenie nie jest brakiem trafień.
    need(`${side}-tracked`).textContent =
      held === null ? '—' : `${count(held)} of ${count(tracked.watched)}`
    need(`${side}-goat-note`).textContent =
      held === null ? 'Could not be checked this round. The fight is unaffected either way.' : ''
  }
}

/**
 * Opisy schowane za „?" w karcie narożnika. Wcześniej były to dwie długie
 * notatki na środku ekranu, przed walką, nachodzące na ring; opis jest
 * potrzebny tylko temu, kto o niego zapyta.
 */
const SCAN_HELP =
  'Contract scan by GoPlus. “Not detected” means the scan did not find it, not that the ' +
  'contract is safe; “no data” means the scan could not say. Only a honeypot changes the ' +
  'fight — the other four are warnings.'

const GOAT_HELP =
  'Addresses from a private server-side list holding this contract. A count, not a signal — ' +
  'being on the list says nothing about what any wallet does next, and it changes nothing ' +
  'about the fight.'

/** Rozwija i zwija opis pod tabelką karty. Stan trzyma atrybut `hidden`, nie React. */
function toggleHelp(button: HTMLElement, targetId: string) {
  const text = need(targetId)
  const open = text.hidden
  text.hidden = !open
  button.setAttribute('aria-expanded', String(open))
}

function HelpButton({ target, label }: { target: string; label: string }) {
  return (
    <button
      className="help-btn"
      id={`${target}-btn`}
      type="button"
      aria-label={label}
      aria-expanded="false"
      aria-controls={target}
      onClick={(event) => toggleHelp(event.currentTarget, target)}
    >
      ?
    </button>
  )
}

/**
 * Skan kontraktu z GoPlus w obu narożnikach: pięć wierszy, trzy stany.
 *
 * Brak danych to „no data", nie „not detected": GoPlus potrafi znać adres i nie
 * zwrócić żadnego z pól (WETH na Robinhood Chain), a puste pole czytane jak
 * zero wyglądałoby jak czysty kontrakt. „Detected" idzie na złoto, nie na
 * czerwień — czerwień to kolor narożnika.
 *
 * Nigdzie nie stoi słowo „safe". Honeypot zatrzymuje zawodnika (walkower), cztery
 * pozostałe to ostrzeżenia i o wyniku nie decydują.
 */
const SECURITY_KEYS: readonly (keyof SecurityChecks)[] = [
  'honeypot',
  'mintable',
  'blacklist',
  'ownerCanChangeBalances',
  'transferPausable',
]

const SECURITY_FLAG_TEXT: Record<SecurityFlag, string> = {
  detected: 'detected',
  not_detected: 'not detected',
  unknown: 'no data',
}

function fillSecurity(data: FightApiResponse) {
  for (const side of ['a', 'b'] as const) {
    const token = side === 'a' ? data.tokenA : data.tokenB
    // Karta otwarta przed wdrożeniem trafia na odpowiedź bez tego pola.
    const security = token.snapshot.security ?? null
    for (const key of SECURITY_KEYS) {
      const flag: SecurityFlag = security?.checks?.[key] ?? 'unknown'
      const cell = need(`${side}-sec-${key}`)
      cell.textContent = SECURITY_FLAG_TEXT[flag]
      cell.classList.toggle('flag-detected', flag === 'detected')
    }
    // Notatka należy do tego tokena, więc leży w jego własnej karcie — nie ma
    // potrzeby dopisywać do niej symbolu, jak we wspólnej notatce na środku.
    need(`${side}-scan-note`).textContent = security?.note ?? ''
    // Nowa walka zaczyna ze zwiniętym opisem.
    need(`${side}-scan-help`).hidden = true
    need(`${side}-scan-help-btn`).setAttribute('aria-expanded', 'false')
  }
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

  /**
   * Rozwija i zwija tabelę WHY. Domyślnie jest zwinięta do paska nagłówka, żeby
   * po walce od razu było widać ring z wynikiem; rozwija się kliknięciem.
   */
  function toggleWhy() {
    setWhyOpen(need('why-body').hidden)
  }

  /**
   * Ranking żyje w chowanej szufladzie z boku ekranu, żeby arena sama w sobie
   * została pełnoekranowa i bez przewijania strony.
   */
  function toggleLadder() {
    const drawer = need('ladder-drawer')
    const open = drawer.classList.toggle('open')
    const tab = need('ladder-tab')
    tab.setAttribute('aria-expanded', String(open))
    tab.textContent = open ? 'CLOSE ✕' : 'RANKING ▤'
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

      // Komentarz startuje tu, równolegle z resztą, i nikt na niego nie czeka.
      // Walka ma ruszyć od razu; tekst rund dokleja się, gdy dojdzie ze
      // strumienia. Nie ma rund (walkower, odwołanie) — nie ma czego komentować
      // i nie wołamy modelu.
      need('arena-status').textContent = ''
      const commentary =
        data.fight.rounds.length > 0
          ? openCommentary(data, (state) => {
              if (state === 'failed') {
                need('note').textContent = 'Result is maths. No commentary on this one.'
              }
            })
          : null
      need('note').textContent = commentary
        ? 'Result is maths. Commentary is a model.'
        : 'Result is maths. No commentary on this one.'

      fillCorner('a', data.tokenA)
      fillCorner('b', data.tokenB)
      fillTracked(data)
      fillSecurity(data)
      showMatchup(data)
      drawTape(data.tokenA, data.tokenB)

      const ring = createRing(data, clock.current)
      ring.reset()

      need('skip').hidden = false
      try {
        await ring.play(commentary)
      } finally {
        // Koniec walki (albo skip): reszta strumienia nikomu nie jest potrzebna,
        // a przerwanie zatrzymuje też model po stronie serwera.
        commentary?.abort()
      }
      need('skip').hidden = true

      need('roundtag').textContent = 'Final'
      // Kwestia ostatniej rundy zrobiła swoje — zostawiona, spychała werdykt
      // (puentę całej walki) tak nisko, że panel sędziego zasłaniał ring.
      need('calls').innerHTML = ''
      drawRead(data.tokenA, data.tokenB)
      drawVerdict(data)
      drawWhy(data)

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
    <div className="cage">
      <div className="cage-bg" aria-hidden />
      <HallBanners />

      {/* Pasek terminala na górze ekranu — jedyne miejsce do wpisania czegoś.
          Bez osobnego ekranu startowego: to samo wejście leży na tle areny.
          `.topbar` jest jedynym elementem tu pozycjonowanym `absolute` —
          pasek i komunikaty pod nim płyną normalnie jeden pod drugim w jego
          wnętrzu. Sam `.topbar` jest w przepływie siatki `.cage` (środkowa
          kolumna, pierwszy wiersz `auto`), więc scena pod nim zaczyna się
          zawsze pod jego prawdziwą dolną krawędzią. */}
      <div className="topbar">
        <header className="termbar">
          <div className="addr-row">
            <AddressField side="a" />
            <AddressField side="b" />
          </div>
          <div className="term-actions">
            <button className="chip" type="button" onClick={loadSample}>
              sample
            </button>
            <button className="term-go" id="go" type="button" onClick={go}>
              Make the fight
            </button>
          </div>
        </header>

        <p className="status" id="status">
          Both corners fill themselves from the chain. Paste two contract addresses.
        </p>
        <p className="crossclass" id="crossclass" hidden />
        {/* Tu zostają tylko krótkie komunikaty. Długie opisy GOAT WALLETS i skanu
            GoPlus mieszkają za „?" w karcie narożnika — na środku ekranu przed
            walką nie ma dla nich miejsca. */}
      </div>

      <main className="stage-floor">
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
          {/* Nad ringiem, nie pod nim: panel sędziego jest zakotwiczony od
              dołu ekranu i rośnie w górę wraz z treścią, więc dolna krawędź
              areny bywa przez niego zasłonięta. Tutaj przycisk zawsze zostaje
              klikalny. */}
          <div className="bottom">
            <span className="status" id="arena-status" style={{ margin: 0, textAlign: 'left' }} />
            <button id="skip" type="button" onClick={onSkip} hidden>
              Skip to result
            </button>
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
        </section>
      </main>

      {/* Karty na tle areny: czerwony zawodnik po lewej, niebieski po prawej.
          Zaczynają schowane i wchodzą w trakcie walki, nie wszystkie naraz —
          fillCorner/drawTape/drawRead je odsłaniają po kolei. */}
      <div className="side-stack left">
        <CornerCard side="a" />
        <div className="float-card red read-card" id="read-card-a" hidden />
      </div>
      <div className="side-stack right">
        <CornerCard side="b" />
        <div className="float-card blue read-card" id="read-card-b" hidden />
      </div>

      {/* Sędzia: kwestie w trakcie walki i werdykt na końcu, w tej samej
          karcie na dole środkiem (CLAUDE.md § Sędzia — ogłasza, nie decyduje). */}
      <div className="judge-dock">
        {/* Stała tabela po walce, nad panelem sędziego. Nie jest komentarzem:
            zostaje na ekranie do następnej walki i nie przechodzi przez model. */}
        <section className="why-panel" id="why-panel" aria-labelledby="why-title" hidden>
          {/* Cały pasek nagłówka jest przyciskiem: zwinięty panel to jedna,
              szeroka strefa kliknięcia, a nie mały przycisk z boku. */}
          <h3>
            <button
              className="why-head"
              id="why-toggle"
              type="button"
              aria-expanded="false"
              aria-controls="why-body"
              onClick={toggleWhy}
            >
              <span id="why-title">WHY</span>
              <span className="why-hint" id="why-hint">show ▸</span>
            </button>
          </h3>
          <div id="why-body" hidden>
            <div className="why-scroll">
              <table className="why-table" id="why-table" />
            </div>
            <p className="why-sentence" id="why-sentence" />
            <p className="why-source" id="why-source" />
          </div>
        </section>
        <div className="judge-panel" id="judge-panel">
          <div className="calls" id="calls" />
          <p className="read-headline" id="read-headline" hidden />
          <div id="verdict-host" />
          <p className="note-line" id="note" />
        </div>
      </div>

      <button
        className="ladder-tab"
        id="ladder-tab"
        type="button"
        aria-expanded="false"
        aria-controls="ladder-drawer"
        onClick={toggleLadder}
      >
        RANKING ▤
      </button>
      <aside className="ladder-drawer" id="ladder-drawer">
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
        <footer>
          <span>Entertainment. A token that wins a fight is still a token.</span>
        </footer>
      </aside>
    </div>
  )
}

/** `0x2e8c31…111e18` → `0x2e8c…111e18`. Puste, gdy nie ma czego skracać. */
function shortAddress(value: string): string {
  const v = value.trim()
  return v.length > 13 ? `${v.slice(0, 6)}…${v.slice(-6)}` : ''
}

/**
 * Pole adresu w karcie narożnika. `<input id="{side}-addr">` dalej trzyma
 * PEŁNY adres i to z niego czyta `go()` — skrót jest wyłącznie warstwą
 * wyświetlania: CSS chowa tekst inputu i rysuje `data-short` z `::after`,
 * dopóki pole nie ma fokusu. Po kliknięciu wraca pełny adres.
 *
 * `loadSample()` ustawia `.value` bez żadnego zdarzenia, więc samo
 * nasłuchiwanie `input` nie złapie próbki. Zamiast dokładać wywołanie do
 * tamtej funkcji, opakowujemy setter `value` na tym jednym elemencie.
 */
function AddressField({ side }: { side: Side }) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const boxNode = box.current
    const input = boxNode?.querySelector('input')
    if (!boxNode || !input) return

    const sync = () => {
      const short = shortAddress(input.value)
      if (short) boxNode.setAttribute('data-short', short)
      else boxNode.removeAttribute('data-short')
    }

    const own = Object.getOwnPropertyDescriptor(input, 'value')
    const base = own ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (base?.get && base.set) {
      const { get, set } = base
      Object.defineProperty(input, 'value', {
        configurable: true,
        get() {
          return get.call(this)
        },
        set(next: string) {
          set.call(this, next)
          sync()
        },
      })
    }
    input.addEventListener('input', sync)
    sync()

    return () => {
      input.removeEventListener('input', sync)
      if (own) Object.defineProperty(input, 'value', own)
      else Reflect.deleteProperty(input, 'value')
    }
  }, [])

  const red = side === 'a'
  return (
    <div className={`float-card ${red ? 'red' : 'blue'} addr-card`}>
      <label htmlFor={`${side}-addr`}>{red ? 'RED_CORNER' : 'BLUE_CORNER'}</label>
      <div className="addr-box" ref={box}>
        <input id={`${side}-addr`} autoComplete="off" spellCheck={false} placeholder="0x…" />
      </div>
    </div>
  )
}

/**
 * Karta narożnika: ticker, kategoria wagowa, odczyt z łańcucha i tale of the
 * tape tego zawodnika. Adresu tu już nie ma — wpisuje się go w pasku
 * terminala na górze, to jest już tylko odczyt z `/api/fight`.
 */
function CornerCard({ side }: { side: Side }) {
  return (
    <div className={`float-card ${side === 'a' ? 'red' : 'blue'} tape-card`} id={`tape-card-${side}`} hidden>
      <h4>
        <span className="tick" id={`${side}-ticker`} />
        <span className="weight" id={`${side}-weight`} />
      </h4>
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
        {/* Skan GoPlus: nagłówek z „?" i pięć wierszy na całą szerokość, żeby
            „not detected" i „no data" nie łamały się w połówce karty. Karta jest
            schowana do pierwszej walki, więc puste „—" nigdy nie jest widoczne. */}
        <div className="wide scan-head">
          <dt>Contract scan · GoPlus</dt>
          <dd>
            <HelpButton target={`${side}-scan-help`} label="About the contract scan" />
          </dd>
        </div>
        <div className="wide">
          <dt>Honeypot</dt>
          <dd id={`${side}-sec-honeypot`}>—</dd>
        </div>
        <div className="wide">
          <dt>Mintable</dt>
          <dd id={`${side}-sec-mintable`}>—</dd>
        </div>
        <div className="wide">
          <dt>Blacklist</dt>
          <dd id={`${side}-sec-blacklist`}>—</dd>
        </div>
        <div className="wide">
          <dt>Owner can edit balances</dt>
          <dd id={`${side}-sec-ownerCanChangeBalances`}>—</dd>
        </div>
        <div className="wide">
          <dt>Transfers pausable</dt>
          <dd id={`${side}-sec-transferPausable`}>—</dd>
        </div>
        {/* Wiersz na całą szerokość i domyślnie schowany: bez listy
            obserwowanych portfeli po stronie serwera nie ma tu czego
            pokazać, a puste pole czyta się jak zero trafień. */}
        <div className="wide" id={`${side}-tracked-row`} hidden>
          <dt>
            GOAT WALLETS <HelpButton target={`${side}-goat-help`} label="About GOAT WALLETS" />
          </dt>
          <dd id={`${side}-tracked`}>—</dd>
        </div>
      </dl>
      {/* Opisy za „?": zwinięte, dopóki ktoś o nie nie poprosi. Poza `<dl>`, bo
          akapit nie jest dozwolonym dzieckiem listy opisowej. */}
      <p className="corner-help" id={`${side}-scan-help`} hidden>
        {SCAN_HELP} <span id={`${side}-scan-note`} />
      </p>
      <p className="corner-help" id={`${side}-goat-help`} hidden>
        {GOAT_HELP} <span id={`${side}-goat-note`} />
      </p>
      <div className="stat-rows" id={`stats-${side}`} />
    </div>
  )
}
