/**
 * Skan GoPlus na żywo — bez Codexu i bez klucza.
 * Uruchomienie: npm run check:security -- [adres ...]
 *
 * Bez argumentów sprawdza AI, PONS i adres skamu z zadania. Nie zjada darmowego
 * progu Codexu: GoPlus jest publiczny, a Codex tu nie uczestniczy.
 *
 * Wypisuje to, co widzi front: pięć flag w trzech stanach i wynik bramki.
 * „not detected" znaczy tyle, że skan niczego nie znalazł — skrypt nigdzie nie
 * twierdzi, że kontrakt jest bezpieczny.
 */
import { fetchContractSecurity, honeypotGate } from '../src/lib/security.ts'

const NETWORK_ID = Number(process.env.NETWORK_ID ?? 4663)

const DEFAULTS: [string, string][] = [
  ['0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', 'AI — Artificial Inu'],
  ['0x39dbed3a2bd333467115de45665cc57f813c4571', 'PONS'],
  ['0x9da155f128a7f9319a66d2bc35a5255ca46bfa3e', 'scam z zadania'],
]

const given = process.argv.slice(2).filter((a) => a.startsWith('0x'))
const targets: [string, string][] = given.length > 0 ? given.map((a) => [a, '']) : DEFAULTS

const text = { detected: 'DETECTED', not_detected: 'not detected', unknown: 'no data' } as const
const row = (label: string, value: string) => console.log(`   ${label.padEnd(24)} ${value}`)

console.log(`\nsieć ${NETWORK_ID}`)
for (const [address, label] of targets) {
  const security = await fetchContractSecurity(address, NETWORK_ID)
  const gate = honeypotGate(security)

  console.log(`\n${address}${label ? `  (${label})` : ''}`)
  if (security.checks === null) {
    row('skan', 'null — brak danych, walka idzie normalnie')
  } else {
    row('honeypot', text[security.checks.honeypot])
    row('mintable', text[security.checks.mintable])
    row('blacklist', text[security.checks.blacklist])
    row('owner can edit balances', text[security.checks.ownerCanChangeBalances])
    row('transfers pausable', text[security.checks.transferPausable])
  }
  row('bramka', gate.passed ? `przechodzi (honeypot: ${text[gate.status]})` : 'NIE PRZECHODZI — walkower')
  if (security.note) row('notatka', security.note)
}
console.log()
