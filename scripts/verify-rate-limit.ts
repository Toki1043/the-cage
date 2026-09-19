/**
 * Kontrola limitu zapytań na IP — na magazynie w pamięci procesu, bez sieci.
 * Uruchomienie: npm run verify:rate-limit
 *
 * Limit chroni kredyt modelu (`/api/commentary`) i darmowy budżet Codexu
 * (`/api/fight`), więc sprawdzane jest to, na czym ta ochrona stoi: że
 * jedenaste zapytanie w oknie dostaje odmowę, że okno się otwiera na nowo,
 * i że dwie trasy nie zjadają sobie nawzajem limitu.
 */
import { PER_IP_LIMIT, clientIp, rateLimit, rateLimitHeaders } from '../src/lib/rate-limit.ts'

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

// Unikalne IP na test: magazyn jest wspólny w procesie i liczniki się nie czyszczą.
const T0 = 1_800_000_000_000
const hit = (bucket: string, ip: string, nowMs = T0) => rateLimit(bucket, ip, { ...PER_IP_LIMIT, nowMs })

console.log('\n== Limit: dziesięć na minutę ==')
check('wspólna stała: 10 zapytań na 60 s', PER_IP_LIMIT, { limit: 10, windowSeconds: 60 })

const results = []
for (let i = 0; i < 12; i++) results.push((await hit('commentary', '10.0.0.1')).ok)
check('pierwsze dziesięć przechodzi, jedenaste i dwunaste nie', results, [...Array(10).fill(true), false, false])

const denied = await hit('commentary', '10.0.0.1')
check('odmowa mówi, że zostało zero', denied.remaining, 0)
check('Retry-After tylko przy odmowie', 'Retry-After' in rateLimitHeaders(denied), true)
const allowed = await hit('commentary', '10.0.0.2')
check('przepuszczone zapytanie nie niesie Retry-After', 'Retry-After' in rateLimitHeaders(allowed), false)
check('licznik pokazuje ile zostało (9 po pierwszym)', allowed.remaining, 9)

console.log('\n== Okno otwiera się na nowo ==')
const later = await hit('commentary', '10.0.0.1', T0 + 61_000)
check('po upływie okna to samo IP znów przechodzi', later.ok, true)
check('a licznik zaczyna od nowa', later.remaining, 9)

console.log('\n== Wiadra są osobne ==')
for (let i = 0; i < 10; i++) await hit('commentary', '10.0.0.3')
check('wiadro komentarza wyczerpane', (await hit('commentary', '10.0.0.3')).ok, false)
check('to samo IP w wiadrze walki nadal przechodzi', (await hit('fight', '10.0.0.3')).ok, true)
check('inne IP w tym samym wiadrze nie jest ruszone', (await hit('commentary', '10.0.0.4')).ok, true)

console.log('\n== Adres klienta ==')
check('pierwszy wpis x-forwarded-for', clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.1.1.1' })), '203.0.113.7')
check('bez nagłówków: wspólne wiadro lokalne', clientIp(new Headers()), 'local')
check('śmieci z nagłówka są czyszczone do znaków adresu', clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4<script>' })), '1.2.3.4c')
check('długi ciąg jest ucinany do 45 znaków', clientIp(new Headers({ 'x-forwarded-for': 'a'.repeat(200) })).length, 45)

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
