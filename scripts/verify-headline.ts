/**
 * Kontrola zdania porównawczego pod panelem — bez sieci i bez modelu.
 * Uruchomienie: npm run verify:headline
 *
 * Zdanie wybiera najostrzejszą różnicę z trzech (koncentracja podaży, rotacja przy
 * płynności, liczba GOAT WALLETS) albo wraca do wyjścia z pozycji. Sprawdzamy, że
 * wybór jest arytmetyką i progami, że brak koncentracji po cichu wyłącza wariant
 * (a tak jest dziś: salda holderów wymagają planu Growth), że zdania o portfelach
 * podają same liczby, i że żadne zdanie nie ocenia ani nie doradza.
 */
import {
  HEADLINE_THRESHOLDS,
  comparisonHeadline,
  headlineToken,
  turnover,
  type HeadlineToken,
} from '../src/lib/ringside.ts'

let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? ` = ${a.length > 90 ? `${a.slice(0, 87)}...` : a}` : `\n       oczekiwano ${e}\n       otrzymano  ${a}`}`,
  )
}

/** Token o zadanych rotacji i płynności; pozostałe pola do nadpisania. */
const token = (symbol: string, over: Partial<HeadlineToken> = {}): HeadlineToken => ({
  symbol,
  liquidityUsd: 1_000_000,
  volume24hUsd: 200_000, // rotacja 0,20
  concentrationPercent: null,
  walletsHolding: null,
  ...over,
})
const kind = (a: HeadlineToken, b: HeadlineToken, watched: number | null) => comparisonHeadline(a, b, watched).kind

console.log('\n== Zdanie o portfelach: sama liczba ==')
{
  const h = comparisonHeadline(token('AI', { walletsHolding: 27 }), token('WETH', { walletsHolding: 18 }), 67)
  check('27 vs 18 z 67 → wariant portfeli', h.kind, 'wallets')
  check('zdanie podaje same liczby, czerwony pierwszy', h.text, '27 of 67 GOAT WALLETS hold $AI, 18 hold $WETH.')
  const flipped = comparisonHeadline(token('AI', { walletsHolding: 18 }), token('WETH', { walletsHolding: 27 }), 67)
  check('odwrotna strona: te same liczby, ta sama forma, bez „więcej znaczy lepiej"', flipped.text, '18 of 67 GOAT WALLETS hold $AI, 27 hold $WETH.')
  check('wynik symetryczny względem strony', flipped.scores.wallets, h.scores.wallets)
}

console.log('\n== Progi portfeli ==')
check('różnica 6 z 67 (poniżej 10% listy) nie różnicuje', kind(token('A', { walletsHolding: 24 }), token('B', { walletsHolding: 18 }), 67), 'exit')
check('różnica 7 z 67 (≥ 6,7) różnicuje', kind(token('A', { walletsHolding: 25 }), token('B', { walletsHolding: 18 }), 67), 'wallets')
check('krótka lista: różnica 2 z 10 to szum (minimum 3 portfele)', kind(token('A', { walletsHolding: 4 }), token('B', { walletsHolding: 2 }), 10), 'exit')
check('krótka lista: różnica 3 z 10 różnicuje', kind(token('A', { walletsHolding: 5 }), token('B', { walletsHolding: 2 }), 10), 'wallets')
check('po równo → nie różnicuje', kind(token('A', { walletsHolding: 18 }), token('B', { walletsHolding: 18 }), 67), 'exit')
check('lista nieustawiona (null) → wariantu nie ma', kind(token('A'), token('B'), null), 'exit')
check('jedna strona bez liczby → wariantu nie ma', kind(token('A', { walletsHolding: 27 }), token('B', { walletsHolding: null }), 67), 'exit')
check('pusta lista (0 portfeli) → wariantu nie ma', kind(token('A', { walletsHolding: 0 }), token('B', { walletsHolding: 0 }), 0), 'exit')

console.log('\n== Rotacja przy płynności ==')
{
  const h = comparisonHeadline(token('AI', { volume24hUsd: 190_000 }), token('WETH', { volume24hUsd: 500_000 }), null)
  check('19% vs 50% (2,6×) → rotacja', h.kind, 'turnover')
  check('zdanie ma „about" i same liczby', h.text, '$AI turned over about 19% of its liquidity in the last 24 hours; $WETH about 50%.')
}
check('rotacja dokładnie 2× → na progu, różnicuje', kind(token('A', { volume24hUsd: 100_000 }), token('B', { volume24hUsd: 200_000 }), null), 'turnover')
check('rotacja 1,9× → poniżej progu', kind(token('A', { volume24hUsd: 100_000 }), token('B', { volume24hUsd: 190_000 }), null), 'exit')
check('0,1% vs 0,4% (oba pod podłogą 1%) → nie „4×"', kind(token('A', { volume24hUsd: 1_000 }), token('B', { volume24hUsd: 4_000 }), null), 'exit')
check('0% vs 30% → różnicuje', kind(token('A', { volume24hUsd: 0 }), token('B', { volume24hUsd: 300_000 }), null), 'turnover')
check('brak płynności → rotacji nie da się policzyć, wariantu nie ma', kind(token('A', { liquidityUsd: 0 }), token('B', { volume24hUsd: 900_000 }), null), 'exit')
check('turnover() bez płynności → null', turnover(1000, 0), null)
{
  const pct = (v: number, other = 0.2) => comparisonHeadline(token('A', { volume24hUsd: v * 1e6 }), token('B', { volume24hUsd: other * 1e6 }), null).text
  check('poniżej 1% pisze „<1%"', pct(0.004, 0.5).includes('about <1%'), true)
  check('powyżej 100% pisze pełną liczbę', pct(1.5, 0.2).includes('about 150%'), true)
  check('tysiące z separatorem', pct(12.34, 0.2).includes('about 1,234%'), true)
}

console.log('\n== Koncentracja podaży ==')
{
  const h = comparisonHeadline(token('AI', { concentrationPercent: 38 }), token('WETH', { concentrationPercent: 12 }), null)
  check('38% vs 12% → koncentracja', h.kind, 'concentration')
  check('zdanie podaje liczby po odsiewie', h.text, "The ten largest wallets hold about 38% of $AI's holder-held supply and about 12% of $WETH's.")
}
check('różnica 9,9 pp → poniżej progu', kind(token('A', { concentrationPercent: 19.9 }), token('B', { concentrationPercent: 10 }), null), 'exit')
check('różnica 10 pp → na progu', kind(token('A', { concentrationPercent: 20 }), token('B', { concentrationPercent: 10 }), null), 'concentration')
check('jedna strona bez liczby → wariant po cichu znika', kind(token('A', { concentrationPercent: 60 }), token('B', { concentrationPercent: null }), null), 'exit')
{
  const h = comparisonHeadline(token('A', { concentrationPercent: 60 }), token('B'), null)
  check('bez koncentracji nie ma śladu po niej w wyniku', [h.scores.concentration, /largest wallets/.test(h.text)], [undefined, false])
}

console.log('\n== Koncentracja: co uznajemy za dostępną (snapshot z Codexu) ==')
const snap = (concentration: { status: string; top10Percent: number | null } | null | undefined) => ({ liquidityUsd: 1e6, volume24hUsd: 2e5, concentration })
// Tak wygląda snapshot dziś: `unavailable`, z surowym top10 obok, ale bez liczby po odsiewie.
check('status unavailable (plan Growth) → brak koncentracji', headlineToken('AI', snap({ status: 'unavailable', top10Percent: null }), null).concentrationPercent, null)
check('status insufficient → brak koncentracji', headlineToken('AI', snap({ status: 'insufficient', top10Percent: 55 }), null).concentrationPercent, null)
check('status ok → liczba po odsiewie', headlineToken('AI', snap({ status: 'ok', top10Percent: 41.2 }), null).concentrationPercent, 41.2)
check('brak pola concentration → null', headlineToken('AI', snap(undefined), null).concentrationPercent, null)
check('surowy top10HoldersPercent nie przecieka do zdania', 'rawTop10Percent' in headlineToken('AI', { ...snap({ status: 'unavailable', top10Percent: null }), rawTop10Percent: 15.7 } as never, null), false)
{
  // Dzisiejsza walka AI vs WETH: koncentracji nie ma, portfele i rotacja jak w odpowiedzi API.
  const a = headlineToken('AI', { liquidityUsd: 3_709_879, volume24hUsd: 692_647, concentration: { status: 'unavailable', top10Percent: null } }, 26)
  const b = headlineToken('WETH', { liquidityUsd: 7_024_552, volume24hUsd: 1_731_353, concentration: { status: 'unavailable', top10Percent: null } }, 18)
  const h = comparisonHeadline(a, b, 67)
  check('AI vs WETH dziś: koncentracji nie ma, wygrywa ostrzejsza z pozostałych', ['concentration' in h.scores, h.kind], [false, 'wallets'])
  check('AI vs WETH dziś: wyniki wariantów', { turnover: Number(h.scores.turnover?.toFixed(2)), wallets: Number(h.scores.wallets?.toFixed(2)) }, { turnover: 0.4, wallets: 1.19 })
}

console.log('\n== Najostrzejsza wygrywa ==')
check('koncentracja 15 pp (1,5) vs rotacja 4× (2,0) → rotacja',
  kind(token('A', { concentrationPercent: 30, volume24hUsd: 100_000 }), token('B', { concentrationPercent: 15, volume24hUsd: 400_000 }), null), 'turnover')
check('koncentracja 30 pp (3,0) vs rotacja 2× (1,0) → koncentracja',
  kind(token('A', { concentrationPercent: 45, volume24hUsd: 100_000 }), token('B', { concentrationPercent: 15, volume24hUsd: 200_000 }), null), 'concentration')
check('rotacja 2× (1,0) vs portfele 27/18 z 67 (1,19) → portfele',
  kind(token('A', { volume24hUsd: 100_000, walletsHolding: 27 }), token('B', { volume24hUsd: 200_000, walletsHolding: 18 }), 67), 'wallets')
check('portfele 27/18 (1,19) vs rotacja 4× (2,0) → rotacja',
  kind(token('A', { volume24hUsd: 100_000, walletsHolding: 27 }), token('B', { volume24hUsd: 400_000, walletsHolding: 18 }), 67), 'turnover')
{
  // Remis wyniku: koncentracja 10 pp = 1,0 i rotacja 2× = 1,0 → rozstrzyga kolejność ze specyfikacji.
  const h = comparisonHeadline(token('A', { concentrationPercent: 30, volume24hUsd: 100_000 }), token('B', { concentrationPercent: 20, volume24hUsd: 200_000 }), null)
  check('remis 1,0 vs 1,0 → koncentracja (pierwsza w kolejności)', [h.scores.concentration, h.scores.turnover, h.kind], [1, 1, 'concentration'])
}

console.log('\n== Wyjście z pozycji: dotychczasowe zdanie ==')
{
  const a = token('AI', { liquidityUsd: 3_709_879 })
  const b = token('WETH', { liquidityUsd: 7_024_552, volume24hUsd: 1_404_910 }) // rotacja 0,20 jak u AI
  const h = comparisonHeadline({ ...a, volume24hUsd: 741_976 }, b, null)
  check('bez różnicy wraca do wyjścia z pozycji', h.kind, 'exit')
  check('to samo zdanie co dotąd: kwoty i krotność', h.text, 'You can move about $190K out of $WETH before the price drops 10%, and only about $100K out of $AI — roughly a 2× difference in how easily you get your money back.')
  const same = comparisonHeadline(token('A', { liquidityUsd: 2_000_000, volume24hUsd: 400_000 }), token('B', { liquidityUsd: 2_100_000, volume24hUsd: 420_000 }), null)
  check('płynność prawie taka sama → zdanie „about the same"', same.text.startsWith('Exiting either token costs about the same'), true)
}

console.log('\n== Żadnych ocen, porad ani prognoz ==')
const FORBIDDEN = /\b(safe|safer|smart|alpha|bullish|bearish|invest\w*|buy|better|worse|best|good|bad|strong\w*|weak\w*|more|less|only|risky|opportunity|upside|pump\w*|moon\w*|gem)\b/i
{
  const samples = [
    comparisonHeadline(token('AI', { concentrationPercent: 38 }), token('WETH', { concentrationPercent: 12 }), 67).text,
    comparisonHeadline(token('AI', { volume24hUsd: 190_000 }), token('WETH', { volume24hUsd: 500_000 }), null).text,
    comparisonHeadline(token('AI', { walletsHolding: 27 }), token('WETH', { walletsHolding: 18 }), 67).text,
    comparisonHeadline(token('AI', { walletsHolding: 3 }), token('WETH', { walletsHolding: 40 }), 67).text,
  ]
  check('trzy warianty i skrajne portfele: żaden nie zawiera słów oceny ani porady', samples.map((t) => FORBIDDEN.test(t)), [false, false, false, false])
}

console.log('\n== Losowo: zawsze poprawne i powtarzalne ==')
{
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  let bad = 0
  let unstable = 0
  const seen = new Set<string>()
  for (let i = 0; i < 4000; i++) {
    const mk = (s: string): HeadlineToken => ({
      symbol: s,
      liquidityUsd: pick([0, 500, 12_000, 1e6, 3.7e6, 5e8]),
      volume24hUsd: pick([0, 40, 1e4, 7e5, 1.7e6, 9e9]),
      concentrationPercent: pick([null, null, 0, 8.5, 20, 55, 92]),
      walletsHolding: pick([null, 0, 3, 18, 27, 67]),
    })
    const a = mk('A')
    const b = mk('B')
    const watched = pick([null, 0, 10, 67])
    const h = comparisonHeadline(a, b, watched)
    seen.add(h.kind)
    if (/NaN|Infinity|undefined|null/.test(h.text) || !['concentration', 'turnover', 'wallets', 'exit'].includes(h.kind)) bad++
    if (JSON.stringify(h) !== JSON.stringify(comparisonHeadline(a, b, watched))) unstable++
  }
  check('4000 losowych par: żadne zdanie nie ma NaN/Infinity/undefined', bad, 0)
  check('to samo wejście daje to samo zdanie', unstable, 0)
  check('losowanie dotyka każdego wariantu (test nie jest pusty)', [...seen].sort(), ['concentration', 'exit', 'turnover', 'wallets'])
}

check('progi są tymi, które opisuje komentarz', HEADLINE_THRESHOLDS, { concentrationPoints: 10, turnoverRatio: 2, turnoverFloor: 0.01, walletShare: 0.1, walletMin: 3, exitRatio: 1.2 })

console.log(failed === 0 ? '\nWszystko przeszło.\n' : `\n${failed} nie przeszło.\n`)
process.exit(failed === 0 ? 0 : 1)
