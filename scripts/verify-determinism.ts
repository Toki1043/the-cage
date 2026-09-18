/**
 * Kontrola powtarzalności na żywym API.
 *
 * Sprawdza trzy różne rzeczy, bo to trzy różne obietnice:
 *
 * 1. Dwa wywołania pod rząd dają identyczne statystyki.
 * 2. Wybór pary referencyjnej jest niezmienny — także po przerwie. To jest
 *    ta część, która wcześniej była zepsuta: Codex zwracał raz jedną parę
 *    tokena, raz inną, i statystyki skakały o kilkanaście punktów.
 * 3. Statystyki dają się odtworzyć z zapisanego snapshotu. To jedyna
 *    obietnica, która obowiązuje też po tygodniu — łańcuch żyje, więc wynik
 *    jest weryfikowalny przez snapshot, nie przez powtórzenie zapytania
 *    (CLAUDE.md § Determinizm).
 *
 * Surowe wejścia po przerwie drgają i to jest normalne. Jeśli statystyka
 * siedzi na granicy zaokrąglenia, może wtedy przeskoczyć o punkt — skrypt
 * pokazuje to jako dryf, nie jako błąd, i mówi o ile.
 *
 * Wymaga działającego serwera. Uruchomienie:
 *   npm run dev
 *   npm run verify:determinism
 */
import { computeStats, computeVulnerability, weightClass } from '../src/lib/stats.ts'

const BASE = process.env.FIGHT_URL ?? 'http://localhost:3117'
const A = process.env.FIGHT_A ?? '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18' // AI
const B = process.env.FIGHT_B ?? '0x0bd7d308f8e1639fab988df18a8011f41eacad73' // WETH
const GAP_MS = Number(process.env.FIGHT_GAP_MS ?? 25_000)

interface TokenPayload {
  symbol: string
  stats: Record<string, number>
  vulnerability: number
  weightClass: { id: string }
  snapshot: {
    pairAddress: string
    pairQuoteToken: string
    pairCreatedAt: number
    pairsConsidered: number
    liquidityUsd: number
    marketCapUsd: number
    volume24hUsd: number
    holders: number
    priceUsd: number
    pairAgeDays: number
  }
}
interface FightPayload {
  tokenA: TokenPayload
  tokenB: TokenPayload
  fight: {
    seed: string
    seedKey: string
    winner: string | null
    method: string
    scorecard: Record<string, number>
    endedInRound: number | null
    rounds: unknown[]
    events: unknown[]
  }
  error?: string
}

const TOKENS = ['tokenA', 'tokenB'] as const
const PAIR_INVARIANTS = ['pairAddress', 'pairQuoteToken', 'pairCreatedAt', 'pairsConsidered'] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = 0

function check(label: string, ok: boolean, detail: string) {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function fight(label: string): Promise<FightPayload> {
  const res = await fetch(`${BASE}/api/fight?a=${A}&b=${B}`)
  const json = (await res.json()) as FightPayload
  if (!res.ok || json.error) {
    console.error(`${label}: ${json.error ?? res.status}`)
    process.exit(1)
  }
  const f = json.fight
  const winner = f.winner === null ? 'remis' : f.winner === 'a' ? json.tokenA.symbol : json.tokenB.symbol
  console.log(
    `${label}: ${json.tokenA.symbol} ${JSON.stringify(json.tokenA.stats)}  ` +
      `${json.tokenB.symbol} ${JSON.stringify(json.tokenB.stats)}\n` +
      `            walka: ${winner} (${f.method}) ${f.scorecard.a}-${f.scorecard.b}  ziarno ${f.seed.slice(0, 12)}…`,
  )
  return json
}

console.log('== Dwa wywołania pod rząd ==')
const first = await fight('przebieg 1')
const second = await fight('przebieg 2')

console.log('\n== 1. Statystyki pod rząd ==')
// Statystyka siedząca dokładnie na granicy zaokrąglenia potrafi przeskoczyć
// o punkt między dwoma wywołaniami, bo płynność zmienia się co blok. To jest
// świadomie zaakceptowane (cache wejdzie razem z rankingiem), więc nie jest
// tu porażką — ale musi być widoczne, bo od tego zależy, czy walka ma prawo
// wyjść identycznie.
let statsStable = true
for (const token of TOKENS) {
  const a = first[token]
  const b = second[token]
  const same = JSON.stringify(a.stats) === JSON.stringify(b.stats)
  if (!same) statsStable = false
  const moved = Object.keys(a.stats)
    .filter((k) => a.stats[k] !== b.stats[k])
    .map((k) => `${k}: ${a.stats[k]} → ${b.stats[k]}`)
  console.log(
    same
      ? `OK   ${a.symbol} statystyki — ${JSON.stringify(a.stats)}`
      : `~    ${a.symbol} statystyki drgnęły na granicy zaokrąglenia — ${moved.join(', ')}`,
  )
  check(`${a.symbol} kategoria wagowa`, a.weightClass.id === b.weightClass.id, a.weightClass.id)
}

console.log('\n== Walka pod rząd ==')
// To jest sedno: walka ma być policzona, nie wylosowana. Ziarno zależy
// wyłącznie od adresów, więc jest niezmienne bezwarunkowo. Cały przebieg
// jest niezmienny pod warunkiem tych samych statystyk na wejściu — i to
// porównujemy co do ciosu, nie tylko po zwycięzcy.
check('ziarno identyczne', first.fight.seed === second.fight.seed, first.fight.seed)
check(
  'klucz ziarna z posortowanych adresów',
  first.fight.seedKey === second.fight.seedKey,
  first.fight.seedKey,
)

if (statsStable) {
  check('zwycięzca identyczny', first.fight.winner === second.fight.winner, String(first.fight.winner))
  check('sposób zakończenia identyczny', first.fight.method === second.fight.method, first.fight.method)
  check(
    'karta punktowa identyczna',
    JSON.stringify(first.fight.scorecard) === JSON.stringify(second.fight.scorecard),
    JSON.stringify(first.fight.scorecard),
  )
  check(
    'cały przebieg rund identyczny',
    JSON.stringify(first.fight.rounds) === JSON.stringify(second.fight.rounds),
    `${first.fight.rounds.length} rund(y)`,
  )
  check(
    'każdy cios identyczny',
    JSON.stringify(first.fight.events) === JSON.stringify(second.fight.events),
    `${first.fight.events.length} zdarzeń`,
  )
} else {
  // Statystyki weszły inne, więc walka ma prawo wyjść inna. Powtarzalność
  // samej symulacji sprawdza wtedy npm run verify:fight na ustalonych
  // wejściach — tam nic nie drga i porównanie jest twarde.
  console.log('~    statystyki drgnęły, więc przebieg walki nie jest tu porównywalny')
  console.log('     (symulację na ustalonych wejściach sprawdza npm run verify:fight)')
  const sameOutcome = first.fight.winner === second.fight.winner
  console.log(
    sameOutcome
      ? `     zwycięzca mimo dryfu ten sam: ${first.fight.winner}`
      : `     dryf przeważył też zwycięzcę: ${first.fight.winner} vs ${second.fight.winner}`,
  )
}

console.log(`\n== Trzecie wywołanie po ${GAP_MS / 1000}s ==`)
await sleep(GAP_MS)
const third = await fight('przebieg 3')
const runs = [first, second, third]

console.log('\n== 2. Ziarno i wybór pary niezmienne także po przerwie ==')
// Ziarno liczy się wyłącznie z adresów, więc nie ma prawa drgnąć nigdy —
// nawet jeśli dane z łańcucha się ruszą.
const seeds = runs.map((r) => r.fight.seed)
check('ziarno niezależne od danych z łańcucha', seeds.every((x) => x === seeds[0]), seeds[0])
for (const token of TOKENS) {
  const symbol = first[token].symbol
  for (const field of PAIR_INVARIANTS) {
    const values = runs.map((r) => String(r[token].snapshot[field]))
    const same = values.every((v) => v === values[0])
    const shown = values[0].length > 46 ? `${values[0].slice(0, 43)}...` : values[0]
    check(`${symbol}.${field}`, same, same ? shown : values.join(' vs '))
  }
}

console.log('\n== 3. Statystyki odtwarzalne z własnego snapshotu ==')
runs.forEach((run, i) => {
  for (const token of TOKENS) {
    const { symbol, stats, vulnerability, weightClass: wc, snapshot } = run[token]
    const recomputed = computeStats({
      liquidityUsd: snapshot.liquidityUsd,
      marketCapUsd: snapshot.marketCapUsd,
      volume24hUsd: snapshot.volume24hUsd,
      holders: snapshot.holders,
      ageDays: snapshot.pairAgeDays,
    })
    // Podatność też musi dać się odtworzyć ze snapshotu: idzie do symulacji
    // obok statystyk i bez tego walki nie da się zweryfikować.
    const vulnerabilityOk = computeVulnerability(snapshot) === vulnerability
    const statsOk = JSON.stringify(recomputed) === JSON.stringify(stats) && vulnerabilityOk
    const wcOk = weightClass(snapshot.marketCapUsd).id === wc.id
    check(
      `przebieg ${i + 1} ${symbol}`,
      statsOk && wcOk,
      statsOk && wcOk ? 'przeliczone ze snapshotu zgadza się' : `${JSON.stringify(recomputed)} vs ${JSON.stringify(stats)}`,
    )
  }
})

console.log('\n== Dryf łańcucha (informacyjnie, nie błąd) ==')
const outcomes = runs.map((r) => `${r.fight.winner}/${r.fight.method}/${r.fight.scorecard.a}-${r.fight.scorecard.b}`)
if (outcomes.every((o) => o === outcomes[0])) {
  console.log(`     wynik walki stały przez wszystkie ${runs.length} wywołania: ${outcomes[0]}`)
} else {
  // Nie błąd: statystyka drgnęła o punkt na granicy zaokrąglenia, a walka
  // liczy się z tych statystyk. Snapshot pozwala odtworzyć każdy z wyników.
  console.log(`     wynik walki poszedł za dryfem statystyk: ${outcomes.join(' | ')}`)
}
for (const token of TOKENS) {
  const symbol = first[token].symbol
  for (const field of ['liquidityUsd', 'volume24hUsd', 'priceUsd', 'marketCapUsd'] as const) {
    const nums = runs.map((r) => r[token].snapshot[field])
    const spread = ((Math.max(...nums) - Math.min(...nums)) / nums[0]) * 100
    console.log(`     ${symbol}.${field}: ${spread.toFixed(4)}% rozrzutu`)
  }
  const statsAcross = runs.map((r) => JSON.stringify(r[token].stats))
  if (!statsAcross.every((s) => s === statsAcross[0])) {
    const keys = Object.keys(first[token].stats)
    const diffs = keys
      .filter((k) => new Set(runs.map((r) => r[token].stats[k])).size > 1)
      .map((k) => `${k}: ${runs.map((r) => r[token].stats[k]).join(' → ')}`)
    console.log(`     ${symbol}: statystyka na granicy zaokrąglenia — ${diffs.join(', ')}`)
  }
}

console.log(
  failed === 0
    ? '\nPowtarzalne: wybór pary niezmienny, statystyki odtwarzalne ze snapshotu.\n'
    : `\n${failed} sprawdzeń nie przeszło.\n`,
)
process.exit(failed === 0 ? 0 : 1)
