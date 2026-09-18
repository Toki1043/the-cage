/**
 * Koncentracja podaży dla podanych kontraktów — z żywego Codexu.
 * Uruchomienie: npm run check:concentration -- <adres> [adres...]
 *
 * Bez adresów bierze AI i PONS z Robinhood Chain. Pokazuje, co dokładnie
 * zdjęto z rachunku i jakie pasmo z tego wyszło — po to, żeby dało się
 * sprawdzić, czy odsiew faktycznie działa, a nie uwierzyć na słowo.
 */
import { fetchTokenFightData } from '../src/lib/codex.ts'
import { concentrationBand } from '../src/lib/concentration.ts'

const DEFAULTS = [
  '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', // AI — Artificial Inu
  '0x39dbed3a2bd333467115de45665cc57f813c4571', // PONS
]
const NETWORK_ID = Number(process.env.NETWORK_ID ?? 4663)

const addresses = process.argv.slice(2).filter((a) => a.startsWith('0x'))
const targets = addresses.length > 0 ? addresses : DEFAULTS

const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`)

for (const address of targets) {
  const token = await fetchTokenFightData(address, NETWORK_ID)
  const c = token.snapshot.concentration
  const v = token.concentration

  console.log(`\n== ${token.symbol} (${token.name}) ==`)
  console.log(`   ${address}`)
  console.log(`   status odsiewu        ${c.status}`)
  console.log(`   surowo z Codexu       ${pct(c.rawTop10Percent)}  (top10HoldersPercent, bez odsiewu)`)
  console.log(`   po odsiewie           ${pct(c.top10Percent)}`)
  // Podaż z tokena, nie z bloku koncentracji: ta druga jest pusta, dopóki nie
  // było sald do odsiania, a samą podaż znamy i tak.
  console.log(`   podaż całkowita       ${token.snapshot.totalSupply || '—'}`)
  console.log(`   podaż holderów        ${c.holderSupply ?? '—'}`)
  console.log(`   sald z API            ${c.balancesFetched}`)
  console.log(`   holderów po odsiewie  ${c.holdersConsidered}`)

  if (c.excluded.length > 0) {
    console.log('   odsiane adresy:')
    for (const e of c.excluded) {
      console.log(
        `     ${e.address}  ${e.reason.padEnd(8)} ${(e.shareOfTotalSupply * 100).toFixed(2)}% podaży`,
      )
    }
  } else {
    console.log('   odsiane adresy:       brak (nie było sald do odsiania)')
  }

  console.log(`   pasmo                 ${v.band} — ${v.label}`)
  console.log(`   wymierzone w walce    ${v.enforced ? 'tak' : 'NIE'}`)
  if (v.staminaPenalty > 0) {
    console.log(`   kara do wytrzymałości ${(v.staminaPenalty * 100).toFixed(0)}% maksymalnej`)
  }
  if (c.note) console.log(`   uwaga                 ${c.note}`)

  // Dla porównania: co by wyszło, gdyby ktoś wziął liczbę surową na progi.
  // Nie bierzemy — ale warto widzieć, czym się różni.
  if (c.rawTop10Percent !== null && c.top10Percent === null) {
    const would = concentrationBand(c.rawTop10Percent)
    console.log(
      `   gdyby liczyć z surowej  pasmo byłoby „${would.id}" (${would.label}) — nie stosujemy`,
    )
  }
}
console.log()
