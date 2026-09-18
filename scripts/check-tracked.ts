/**
 * Licznik obserwowanych portfeli — z żywego RPC, bez Codexu.
 * Uruchomienie: npm run check:tracked -- <adresKontraktu> [adresKontraktu]
 *
 * Po to, żeby dało się sprawdzić listę i RPC osobno od walki: Codex tu nie
 * uczestniczy, więc sprawdzenie nie zjada darmowego progu 10 000 zapytań.
 *
 * Wypisuje wyłącznie liczby — tyle samo, ile widzi front. Gdyby ten skrypt
 * wypisywał adresy z listy, to samo wyszłoby potem w logu wdrożenia, a lista
 * jest prywatna właśnie po to, żeby nigdzie nie wychodziła.
 */
import { MAX_TRACKED_WALLETS, parseTrackedWallets, rpcUrlEnvName, trackedWallets } from '../src/lib/tracked.ts'

const DEFAULTS = [
  '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', // AI — Artificial Inu
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
]
const NETWORK_ID = Number(process.env.NETWORK_ID ?? 4663)

const given = process.argv.slice(2).filter((a) => a.startsWith('0x'))
const [a, b] = given.length >= 2 ? given : given.length === 1 ? [given[0], DEFAULTS[1]] : DEFAULTS

const list = parseTrackedWallets(process.env.TRACKED_WALLETS)
console.log(`\nlista           ${list.wallets.length} adresów w użyciu`)
if (list.dropped > 0) console.log(`                ${list.dropped} wpisów nie jest adresem`)
if (list.truncated > 0) console.log(`                ${list.truncated} uciętych ponad limit ${MAX_TRACKED_WALLETS}`)
console.log(`sieć            ${NETWORK_ID}`)
console.log(`RPC             ${process.env[rpcUrlEnvName(NETWORK_ID)] ? 'ustawiony' : `brak ${rpcUrlEnvName(NETWORK_ID)}`}`)

const result = await trackedWallets(
  { address: a, networkId: NETWORK_ID },
  { address: b, networkId: NETWORK_ID },
)

const held = (n: number | null) => (n === null ? '— (nie udało się sprawdzić)' : `${n} z ${result.watched}`)
console.log(`\n${a}\n  trzyma        ${held(result.a)}`)
console.log(`\n${b}\n  trzyma        ${held(result.b)}`)
if (result.note) console.log(`\nnotatka         ${result.note}`)
if (!result.configured) console.log('\nBez TRACKED_WALLETS narożnik nie pokazuje tego wiersza.')
console.log()
