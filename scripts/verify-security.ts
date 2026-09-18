/**
 * Kontrola skanu GoPlus i bramki na honeypocie — bez sieci.
 * Uruchomienie: npm run verify:security
 *
 * Fixtury to kształty prawdziwych odpowiedzi GoPlus dla sieci 4663, pobrane
 * z żywego API: AI i PONS (wszystkie pięć flag `"0"`), skam 0x9da1… (cztery `"0"`
 * i `transfer_pausable: "1"`), WETH (adres znany, pola nieobecne), adres nieznany
 * (`result: {}`) i sieć nieobsługiwana (kod 2022). Sieć w `fetchContractSecurity`
 * podmieniamy atrapą, żeby sprawdzić, że funkcja nigdy nie rzuca.
 */
import { simulateFight, type FighterInput, type FightEvent } from '../src/lib/fight.ts'
import { concentrationUnavailable, concentrationVerdict } from '../src/lib/concentration.ts'
import { holderGate } from '../src/lib/holder-gate.ts'
import {
  fetchContractSecurity,
  honeypotGate,
  parseGoPlus,
  securityUnavailable,
  type ContractSecurity,
  type SecurityChecks,
} from '../src/lib/security.ts'
import { computeStats, computeVulnerability, type ChartModifiers } from '../src/lib/stats.ts'

let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? ` = ${a.length > 70 ? `${a.slice(0, 67)}...` : a}` : `\n       oczekiwano ${e}\n       otrzymano  ${a}`}`,
  )
}

const CHAIN = 4663
const AI = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18'
const SCAM = '0x9da155f128a7f9319a66d2bc35a5255ca46bfa3e'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

const ok = (result: unknown) => ({ code: 1, message: 'OK', result })
const allZero = {
  is_honeypot: '0',
  is_mintable: '0',
  is_blacklisted: '0',
  owner_change_balance: '0',
  transfer_pausable: '0',
}

console.log('\n== Parsowanie: trzy stany, nie dwa ==')
const clean = parseGoPlus(ok({ [AI]: allZero }), AI, CHAIN)
check('pięć "0" → pięć not_detected', clean.checks, {
  honeypot: 'not_detected',
  mintable: 'not_detected',
  blacklist: 'not_detected',
  ownerCanChangeBalances: 'not_detected',
  transferPausable: 'not_detected',
})
check('bez notatki, gdy wszystko odpowiedziało', clean.note, null)

const dirty = parseGoPlus(
  ok({
    [AI]: {
      is_honeypot: '1',
      is_mintable: '1',
      is_blacklisted: '1',
      owner_change_balance: '1',
      transfer_pausable: '1',
    },
  }),
  AI,
  CHAIN,
)
check('pięć "1" → pięć detected', Object.values(dirty.checks ?? {}), ['detected', 'detected', 'detected', 'detected', 'detected'])

// Każda flaga osobno — pomylenie pól między sobą przeszłoby test na samych "1".
for (const [field, key] of [
  ['is_honeypot', 'honeypot'],
  ['is_mintable', 'mintable'],
  ['is_blacklisted', 'blacklist'],
  ['owner_change_balance', 'ownerCanChangeBalances'],
  ['transfer_pausable', 'transferPausable'],
] as const) {
  const one = parseGoPlus(ok({ [AI]: { ...allZero, [field]: '1' } }), AI, CHAIN)
  const detected = Object.entries(one.checks ?? {}).filter(([, v]) => v === 'detected').map(([k]) => k)
  check(`tylko ${field}="1" zapala tylko ${key}`, detected, [key])
}

console.log('\n== Brak pola to nie czysty kontrakt ==')
const partial = parseGoPlus(ok({ [AI]: { is_honeypot: '0' } }), AI, CHAIN)
check('pola nieobecne → unknown, nie not_detected', partial.checks, {
  honeypot: 'not_detected',
  mintable: 'unknown',
  blacklist: 'unknown',
  ownerCanChangeBalances: 'unknown',
  transferPausable: 'unknown',
})
check(
  'notatka wymienia, czego brakuje',
  partial.note,
  'GoPlus returned no data for: mintable, blacklist, owner can change balances, transfer pausable.',
)

for (const [label, value] of [
  ['pusty łańcuch', ''],
  ['null', null],
  ['liczba spoza 0/1', 2],
  ['dziwny tekst', 'yes'],
] as const) {
  const r = parseGoPlus(ok({ [AI]: { ...allZero, is_honeypot: value } }), AI, CHAIN)
  check(`honeypot = ${label} → unknown`, r.checks?.honeypot, 'unknown')
}
check('liczba 1 (nie tekst) też liczy się jako detected', parseGoPlus(ok({ [AI]: { ...allZero, is_honeypot: 1 } }), AI, CHAIN).checks?.honeypot, 'detected')

// Skam z żywego API: cztery `"0"` i jedno `"1"` — dokładnie ta flaga, której
// dotąd nikt nie czytał. Honeypota nie ma, więc bramka go przepuszcza.
const scam = parseGoPlus(ok({ [SCAM]: { ...allZero, transfer_pausable: '1' } }), SCAM, CHAIN)
check('skam: transfer_pausable wykryte', scam.checks?.transferPausable, 'detected')
check('skam: honeypot nadal nie wykryty', scam.checks?.honeypot, 'not_detected')
check('skam: bramka na honeypocie go przepuszcza', honeypotGate(scam).passed, true)

// WETH z żywego API: adres jest, czterech pól nie ma.
const weth = parseGoPlus(ok({ [WETH]: { token_symbol: 'WETH', cannot_sell_all: '0', is_open_source: '1', is_proxy: '1' } }), WETH, CHAIN)
check('WETH: brakujące pola → null, nie pięć unknown', weth.checks, null)
check('WETH: notatka mówi wprost, czemu', weth.note, 'GoPlus knows this contract but returned none of the five checks.')

console.log('\n== Brak danych → null z notatką ==')
const unknownAddr = parseGoPlus(ok({}), '0x1111111111111111111111111111111111111111', CHAIN)
check('adres nieznany (result: {}) → null', unknownAddr.checks, null)
check('adres nieznany → notatka', unknownAddr.note, 'GoPlus has no record of this contract on chain 4663.')

const badChain = parseGoPlus({ code: 2022, message: 'The main chain is not supported', result: null }, AI, 999999)
check('sieć nieobsługiwana (2022) → null', badChain.checks, null)
check('sieć nieobsługiwana → notatka niesie komunikat GoPlus', badChain.note?.includes('The main chain is not supported'), true)
check('nie-JSON → null', parseGoPlus('<html>', AI, CHAIN).checks, null)
check('null → null', parseGoPlus(null, AI, CHAIN).checks, null)

// GoPlus zwraca klucz małymi literami, ale nie polegamy na tym.
const checksummed = parseGoPlus(ok({ '0x2E8C31162B855A2FFA90F6F8634643AD6F111E18': allZero }), AI, CHAIN)
check('klucz w innej wielkości liter też znaleziony', checksummed.checks?.honeypot, 'not_detected')
// Wynik dla innego adresu nie może przypaść temu, o który pytaliśmy.
check('cudzy adres w odpowiedzi nie jest naszym', parseGoPlus(ok({ [SCAM]: allZero }), AI, CHAIN).checks, null)

console.log('\n== fetchContractSecurity nigdy nie rzuca ==')
const realFetch = globalThis.fetch
const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
  globalThis.fetch = impl
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

let requested = ''
await withFetch(
  async (input) => {
    requested = String(input)
    return json(ok({ [AI]: allZero }))
  },
  async () => {
    const r = await fetchContractSecurity(AI, CHAIN)
    check('adres pod właściwą siecią', requested, `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${AI}`)
    check('poprawna odpowiedź → skan', r.checks?.honeypot, 'not_detected')
  },
)
await withFetch(
  async () => {
    throw new TypeError('fetch failed')
  },
  async () => {
    const r = await fetchContractSecurity(AI, CHAIN)
    check('awaria sieci → null', r.checks, null)
    check('awaria sieci → notatka', r.note, 'GoPlus unreachable: fetch failed.')
  },
)
await withFetch(
  async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  },
  async () => {
    const r = await fetchContractSecurity(AI, CHAIN)
    check('timeout → null', r.checks, null)
    check('timeout → notatka o czasie', r.note, 'GoPlus did not answer within 6s.')
  },
)
await withFetch(
  async () => json({ message: 'rate limited' }, 429),
  async () => {
    const r = await fetchContractSecurity(AI, CHAIN)
    check('HTTP 429 → null', r.checks, null)
    check('HTTP 429 → notatka', r.note, 'GoPlus did not answer: HTTP 429.')
  },
)
await withFetch(
  async () => new Response('<html>oops</html>', { status: 200 }),
  async () => {
    const r = await fetchContractSecurity(AI, CHAIN)
    check('200 z ciałem, które nie jest JSON → null, bez wyjątku', r.checks, null)
  },
)

console.log('\n== Bramka ==')
const scan = (over: Partial<SecurityChecks>): ContractSecurity => ({
  source: 'goplus',
  chainId: CHAIN,
  checks: { honeypot: 'not_detected', mintable: 'not_detected', blacklist: 'not_detected', ownerCanChangeBalances: 'not_detected', transferPausable: 'not_detected', ...over },
  note: null,
})
check('honeypot wykryty → nie przechodzi', honeypotGate(scan({ honeypot: 'detected' })), { status: 'detected', passed: false })
check('honeypot nie wykryty → przechodzi', honeypotGate(scan({})), { status: 'not_detected', passed: true })
check('honeypot unknown → przechodzi, ale status mówi, że nie sprawdzono', honeypotGate(scan({ honeypot: 'unknown' })), { status: 'unknown', passed: true })
check('brak skanu (null) → przechodzi ze statusem unknown', honeypotGate(securityUnavailable(CHAIN, 'x')), { status: 'unknown', passed: true })
check(
  'mintable + blacklist + owner + transfer pausable wykryte, honeypot nie → bramka przechodzi',
  honeypotGate(scan({ mintable: 'detected', blacklist: 'detected', ownerCanChangeBalances: 'detected', transferPausable: 'detected' })).passed,
  true,
)

console.log('\n== Walkower za honeypota ==')
const modifiers: ChartModifiers = {
  priceChange1h: 0,
  priceChange24h: 0,
  priceChange7d: 0,
  priceChange7dWindowDays: 7,
  peakCloseUsd: 1,
  peakAt: 0,
  drawdownFromPeakClose: 0,
  volatility: 1,
  volatilityBasisDays: 30,
  barCount: 30,
  windowDays: 30,
}
const HEALTHY = { liquidityUsd: 2_000_000, marketCapUsd: 20_000_000, volume24hUsd: 500_000, holders: 8_572, ageDays: 30 }
const BEST = { liquidityUsd: 90_000_000, marketCapUsd: 90_000_000, volume24hUsd: 90_000_000, holders: 90_000, ageDays: 0 }

function fighter(address: string, symbol: string, raw = HEALTHY, security: ContractSecurity = scan({})): FighterInput {
  return {
    address,
    symbol,
    stats: computeStats(raw),
    modifiers,
    vulnerability: computeVulnerability(raw),
    holderGate: holderGate(raw.holders),
    honeypotGate: honeypotGate(security),
    concentration: concentrationVerdict(concentrationUnavailable(null, 'test')),
  }
}

const HONEY = '0x5555555555555555555555555555555555555555'
const REAL = '0x91a2dae9699f0b82540b5886b0d8759c22820ba3'
// Honeypot z najlepszymi możliwymi statystykami: bramka nie może zależeć od siły.
const honey = fighter(HONEY, 'HONEY', BEST, scan({ honeypot: 'detected' }))
const real = fighter(REAL, 'REAL')

const w = simulateFight(honey, real)
check('sposób to walkower', w.method, 'walkover')
check('wygrywa uczciwy (b)', w.winner, 'b')
check('bez rund', w.rounds.length, 0)
check('karta pusta', [w.scorecard.a, w.scorecard.b], [0, 0])
check('zero obrażeń', [w.damageDealt.a, w.damageDealt.b], [0, 0])
check('pierwsze zdarzenie: oblane badania z powodem honeypot', w.events[0], { type: 'medicalsFailed', fighter: 'a', reason: 'honeypot' })
check('ostatnie zdarzenie: walkower', w.events.at(-1), { type: 'walkover', winner: 'b', loser: 'a' })
check('bez żadnego ciosu w zdarzeniach', w.events.some((e: FightEvent) => e.type === 'punch'), false)
check('bramka widoczna w wyniku', [w.honeypotGates.a.passed, w.honeypotGates.b.passed], [false, true])
check('status skanu niesiony w wyniku', [w.honeypotGates.a.status, w.honeypotGates.b.status], ['detected', 'not_detected'])

const flipped = simulateFight(real, honey)
check('odwrócona kolejność: nadal wygrywa uczciwy', flipped.winner, 'a')
check('odwrócona kolejność: to samo ziarno', flipped.seed, w.seed)
check('powtórzenie: ten sam wynik bit w bit', JSON.stringify(simulateFight(honey, real)), JSON.stringify(w))

console.log('\n== Brak danych i ostrzeżenia nie ruszają walki ==')
const noScan = fighter(HONEY, 'HONEY', BEST, securityUnavailable(CHAIN, 'GoPlus did not answer'))
const unknownFight = simulateFight(noScan, real)
check('brak skanu → walka rozgrywana normalnie', ['KO', 'TKO', 'decision', 'draw'].includes(unknownFight.method), true)
check('brak skanu → są rundy', unknownFight.rounds.length > 0, true)

const warned = fighter(
  HONEY,
  'HONEY',
  BEST,
  scan({ mintable: 'detected', blacklist: 'detected', ownerCanChangeBalances: 'detected', transferPausable: 'detected' }),
)
const cleanScan = fighter(HONEY, 'HONEY', BEST, scan({}))
check(
  'cztery ostrzeżenia dają walkę bit w bit taką jak czysty skan',
  JSON.stringify(simulateFight(warned, real)),
  JSON.stringify(simulateFight(cleanScan, real)),
)

console.log('\n== Kilka wad naraz ==')
const honey2 = fighter('0x6666666666666666666666666666666666666666', 'HONEY2', HEALTHY, scan({ honeypot: 'detected' }))
const cancelled = simulateFight(honey, honey2)
check('dwa honeypoty → walka odwołana', cancelled.method, 'cancelled')
check('bez zwycięzcy', cancelled.winner, null)
const cancelEvent = cancelled.events.at(-1) as Extract<FightEvent, { type: 'fightCancelled' }>
check('powody obu stron w zdarzeniu', [cancelEvent.reasons.a, cancelEvent.reasons.b], ['honeypot', 'honeypot'])

// Holderzy przed honeypotem: zapisana reguła „jeden powód na osobę" zostaje.
const fewHolders = fighter(HONEY, 'FEW', { ...BEST, holders: 51 }, scan({ honeypot: 'detected' }))
const both = simulateFight(fewHolders, real)
check('jeden powód na osobę', both.events.filter((e: FightEvent) => e.type === 'medicalsFailed').length, 1)
check('holderzy mają pierwszeństwo przed honeypotem', (both.events[0] as { reason?: string }).reason, 'holders')

// Honeypot przed koncentracją.
const failedConcentration = { band: 'failed' as const, label: 'Failed the medical', percent: 80, staminaPenalty: 0, enforced: true }
const honeyAndConc = simulateFight({ ...honey, concentration: failedConcentration }, real)
check('honeypot ma pierwszeństwo przed koncentracją', (honeyAndConc.events[0] as { reason?: string }).reason, 'honeypot')

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
