/**
 * Kontrola obserwowanych portfeli i limitu zapytań — bez sieci.
 * Uruchomienie: npm run verify:tracked
 *
 * Sprawdzane jest to, na czym stoi cała rzecz: że lista nigdy nie wychodzi
 * z serwera, że nieznane saldo nie udaje zera, i że limit na IP naprawdę
 * odmawia po przekroczeniu progu, a po granicy okna otwiera się z powrotem.
 */
import { clientIp, rateLimit, rateLimitHeaders } from '../src/lib/rate-limit.ts'
import {
  MAX_TRACKED_WALLETS,
  balanceOfCallData,
  holdsBalance,
  parseTrackedWallets,
  rpcUrlEnvName,
  trackedWallets,
} from '../src/lib/tracked.ts'

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

const W1 = '0x1111111111111111111111111111111111111111'
const W2 = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18'

console.log('\n== Parsowanie listy ==')
check('przecinki', parseTrackedWallets(`${W1},${W2}`).wallets, [W1, W2])
check('nowe linie', parseTrackedWallets(`${W1}\n${W2}`).wallets, [W1, W2])
check('spacje i średniki', parseTrackedWallets(`${W1} ; ${W2}`).wallets, [W1, W2])
check('wielkie litery na małe', parseTrackedWallets(W1.toUpperCase()).wallets, [W1])
check('powtórzenia raz', parseTrackedWallets(`${W1},${W1.toUpperCase()}`).wallets, [W1])
check('brak zmiennej', parseTrackedWallets(undefined).wallets, [])
check('same przecinki', parseTrackedWallets(' , , ').wallets, [])

const bad = parseTrackedWallets(`${W1}, 0xnope, 0x1234, ${W2}`)
check('śmieci odsiane', bad.wallets, [W1, W2])
check('i tylko zliczone', bad.dropped, 2)

// Wpis, który nie przeszedł walidacji, bywa adresem z literówką. Gdyby
// parser go gdziekolwiek przepisywał, wynosiłby kawałek listy na zewnątrz.
check('odrzucony wpis nie wraca', JSON.stringify(bad).includes('0xnope'), false)

const many = Array.from(
  { length: MAX_TRACKED_WALLETS + 5 },
  (_, i) => '0x' + String(i + 1).padStart(40, '0'),
)
const capped = parseTrackedWallets(many.join(','))
check('lista ucięta do limitu', capped.wallets.length, MAX_TRACKED_WALLETS)
check('nadmiar zliczony', capped.truncated, 5)

console.log('\n== Wywołanie balanceOf ==')
const data = balanceOfCallData(W1)
check('selektor balanceOf', data.slice(0, 10), '0x70a08231')
check('adres dopełniony do 32 bajtów', data.length, 10 + 64)
check(
  'adres na końcu słowa',
  data,
  '0x70a08231' + '0'.repeat(24) + '1111111111111111111111111111111111111111',
)
check('wielkie litery znoszone', balanceOfCallData(W1.toUpperCase()), data)

console.log('\n== Odczyt salda ==')
check('zero to brak salda', holdsBalance('0x' + '0'.repeat(64)), false)
check('jedynka to saldo', holdsBalance('0x' + '0'.repeat(63) + '1'), true)
check('cyfra na początku też', holdsBalance('0x9' + '0'.repeat(63)), true)
check('litera szesnastkowa liczy się', holdsBalance('0x' + '0'.repeat(63) + 'a'), true)
check('duże saldo powyżej zakresu number', holdsBalance('0x' + 'f'.repeat(64)), true)
// Puste `0x` znaczy „adres nie jest kontraktem ERC-20". Policzone jako zero
// byłoby twierdzeniem o saldzie, którego nie znamy.
check('puste 0x to nie wiem', holdsBalance('0x'), null)
check('śmieci to nie wiem', holdsBalance('nie'), null)
check('brak wyniku to nie wiem', holdsBalance(undefined), null)
check('zero jako liczba to nie wiem', holdsBalance(0), null)

console.log('\n== Nazwa zmiennej z RPC ==')
check('nazwa per sieć', rpcUrlEnvName(4663), 'ALCHEMY_RPC_URL_4663')

console.log('\n== Co wychodzi z serwera ==')
delete process.env.TRACKED_WALLETS
const off = await trackedWallets({ address: TOKEN, networkId: 4663 }, { address: W2, networkId: 4663 })
check('bez listy nic nie pokazujemy', off, {
  configured: false,
  watched: 0,
  a: null,
  b: null,
  note: null,
})

// Lista jest, RPC nie ma: liczby nie da się policzyć, ale lista i tak nie
// może wyjść — ani w notatce, ani nigdzie indziej.
process.env.TRACKED_WALLETS = `${W1},${W2}`
delete process.env.ALCHEMY_RPC_URL_4663
const noRpc = await trackedWallets(
  { address: TOKEN, networkId: 4663 },
  { address: W2, networkId: 4663 },
)
check('lista widziana', noRpc.configured, true)
check('rozmiar listy owszem', noRpc.watched, 2)
check('liczby bez RPC nie ma', [noRpc.a, noRpc.b], [null, null])
check('notatka mówi, czego brakuje', noRpc.note, 'Set ALCHEMY_RPC_URL_4663 to check balances.')
check('ani jednego adresu z listy', JSON.stringify(noRpc).includes(W1.slice(2, 10)), false)
check('ani drugiego', JSON.stringify(noRpc).includes(W2.slice(2, 10)), false)

const twoNetworks = await trackedWallets(
  { address: TOKEN, networkId: 4663 },
  { address: W2, networkId: 1 },
)
check(
  'brak RPC dla obu sieci wymieniony',
  twoNetworks.note,
  'Set ALCHEMY_RPC_URL_4663 and ALCHEMY_RPC_URL_1 to check balances.',
)
delete process.env.TRACKED_WALLETS

console.log('\n== RPC: kolejność i nazwany błąd ==')
{
  const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571'
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  console.warn = () => {}
  process.env.TRACKED_WALLETS = `${W1},${W2}`
  process.env.ALCHEMY_RPC_URL_4663 = 'http://rpc.test/key-that-must-not-leak'

  // Podstawiony RPC. `plan` mówi, jakim statusem odpowiada na kolejne
  // wywołania dla danego tokena; po wyczerpaniu planu odpowiada 200
  // z niezerowym saldem. Liczy też, ile wywołań leciało naraz.
  const stub = (plan: Record<string, number[]>) => {
    const calls: Record<string, number> = {}
    let inFlight = 0
    let maxInFlight = 0
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: [{ to: string }] }[]
      const token = body[0].params[0].to
      const n = (calls[token] = (calls[token] ?? 0) + 1)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      const status = plan[token]?.[n - 1] ?? 200
      if (status !== 200) return new Response('nope', { status })
      const result = '0x' + '0'.repeat(63) + '1'
      return Response.json(body.map((_, id) => ({ jsonrpc: '2.0', id, result })))
    }) as typeof fetch
    return { calls, maxInFlight: () => maxInFlight }
  }
  const run = (a: string, b: string) =>
    trackedWallets(
      { address: a, networkId: 4663, symbol: 'AI' },
      { address: b, networkId: 4663, symbol: 'PONS' },
    )

  let rpc = stub({})
  let out = await run(TOKEN, PONS)
  check('bez błędów: obie liczby', [out.a, out.b, out.note], [2, 2, null])
  check('tokeny po kolei, nigdy dwa wywołania naraz', rpc.maxInFlight(), 1)

  // 429 nie jest ponawiane: to jedna próba, a `null` z nazwanym zawodnikiem.
  rpc = stub({ [PONS]: [429] })
  out = await run(TOKEN, PONS)
  check('429: null, nie zero', [out.a, out.b], [2, null])
  check('jedna próba, bez ponowień', rpc.calls[PONS], 1)
  check('notatka nazywa zawodnika', out.note, 'Blue corner (PONS): RPC returned 429.')

  rpc = stub({ [TOKEN]: [500] })
  out = await run(TOKEN, PONS)
  check('czerwony nazwany, niebieski policzony', [out.a, out.b, out.note], [null, 2, 'Red corner (AI): RPC returned 500.'])

  rpc = stub({ [TOKEN]: [429], [PONS]: [429] })
  out = await run(TOKEN, PONS)
  check('oba zawiodły: oba w notatce', out.note, 'Red corner (AI): RPC returned 429. Blue corner (PONS): RPC returned 429.')
  check('adres RPC ani klucz nie wyciekają', JSON.stringify(out).includes('key-that-must-not-leak'), false)

  // Symbol wpisuje deployer — do notatki nie może wejść nic poza znakami tickera.
  rpc = stub({ [TOKEN]: [500] })
  out = await trackedWallets(
    { address: TOKEN, networkId: 4663, symbol: '<img src=x onerror=1>' },
    { address: PONS, networkId: 4663 },
  )
  check('symbol z HTML-a oczyszczony', out.note, 'Red corner (imgsrcxonerror1): RPC returned 500.')

  globalThis.fetch = realFetch
  console.warn = realWarn
  delete process.env.TRACKED_WALLETS
  delete process.env.ALCHEMY_RPC_URL_4663
}

console.log('\n== IP klienta ==')
const headers = (entries: Record<string, string>) => new Headers(entries)
check('pierwszy wpis z x-forwarded-for', clientIp(headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4')
check('x-real-ip jako zapas', clientIp(headers({ 'x-real-ip': '9.9.9.9' })), '9.9.9.9')
check('bez nagłówków jedno wiadro', clientIp(headers({})), 'local')
check('IPv6 przechodzi', clientIp(headers({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1')
// Nagłówek wpisuje klient, więc może w nim być cokolwiek — a to leci do
// klucza w bazie.
check('spacje obok adresu wycięte', clientIp(headers({ 'x-forwarded-for': '  1.2.3.4  ' })), '1.2.3.4')
check('nagłówek bez adresu wpada do local', clientIp(headers({ 'x-forwarded-for': 'zzz' })), 'local')
check('długi nagłówek ucięty', clientIp(headers({ 'x-forwarded-for': '1'.repeat(200) })).length, 45)

console.log('\n== Limit zapytań ==')
const LIMIT = { limit: 3, windowSeconds: 60, nowMs: 1_700_000_000_000 }
const ip = '203.0.113.7'
const first = await rateLimit('test', ip, LIMIT)
check('pierwsze przechodzi', first.ok, true)
check('zostały dwa', first.remaining, 2)
check('drugie przechodzi', (await rateLimit('test', ip, LIMIT)).ok, true)
check('trzecie przechodzi', (await rateLimit('test', ip, LIMIT)).ok, true)

const over = await rateLimit('test', ip, LIMIT)
check('czwarte odmówione', over.ok, false)
check('nic nie zostało', over.remaining, 0)
check('czas do otwarcia w oknie', over.retryAfter > 0 && over.retryAfter <= 60, true)

// Limit jest na IP, nie na trasę: drugi adres ma własny licznik.
check('inne IP ma swój licznik', (await rateLimit('test', '198.51.100.1', LIMIT)).ok, true)
// I na wiadro: inna trasa nie zjada limitu tej.
check('inne wiadro ma swój licznik', (await rateLimit('other', ip, LIMIT)).ok, true)

// Granica okna. Bez tego nie wiadomo, czy odmowa kiedykolwiek się kończy.
const nextWindow = { ...LIMIT, nowMs: LIMIT.nowMs + 60_000 }
check('po granicy okna znów przechodzi', (await rateLimit('test', ip, nextWindow)).ok, true)
check('licznik zaczyna od nowa', (await rateLimit('test', ip, nextWindow)).remaining, 1)

console.log('\n== Nagłówki limitu ==')
const passHeaders = rateLimitHeaders({ ok: true, limit: 10, remaining: 7, retryAfter: 20, shared: false })
check('limit w nagłówku', passHeaders['RateLimit-Limit'], '10')
check('pozostało w nagłówku', passHeaders['RateLimit-Remaining'], '7')
// `Retry-After` przy przepuszczonym zapytaniu kazałby czekać bez powodu.
check('bez Retry-After, gdy przeszło', 'Retry-After' in passHeaders, false)
const denyHeaders = rateLimitHeaders({ ok: false, limit: 10, remaining: 0, retryAfter: 20, shared: false })
check('Retry-After przy odmowie', denyHeaders['Retry-After'], '20')

console.log(failed === 0 ? '\nWszystko przeszło.' : `\n${failed} kontrol nie przeszło.`)
if (failed > 0) process.exit(1)
