/**
 * Testowa wersja z przepisanymi formułami:
 * 1. Szybkość → aktywność (obrót 24h / płynność)
 * 2. Wiek → bonus do HP dla starszych tokenów
 */

// Dane ze snapshotu z poprzedniej walki
const ASKR = {
  address: '0xa92768863a55d8a0591709f7f5e594a249d36ea3',
  symbol: 'ASKR',
  liquidityUsd: 113619,
  volume24hUsd: 3805697,
  marketCapUsd: 5709168,
  holders: 2354,
  ageDays: 0.78,
}

const SHROOM = {
  address: '0xab093def657f15df31b33922a95e047add645b29',
  symbol: 'SHROOM',
  liquidityUsd: 645507,
  volume24hUsd: 3186274,
  marketCapUsd: 17364011,
  holders: 11103,
  ageDays: 15.97,
}

// Oryginalne progi z CLAUDE.md
const STAT_SCALE = {
  wytrzymalosc: { minLog: 3, decades: 5 },
  sila: { minLog: 3, decades: 5 },
  garda: { minLog: 1, decades: 5 },
  vulnerability: { decades: 3 },
}

function clampStat(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)))
}

// === ZMIANA 1: Szybkość oparta na aktywności ===

/**
 * Nowa szybkość: rotacja płynności (velocity).
 *
 * Obrót 24h / płynność pokazuje, ile razy dziennie płynność "obraca się".
 * Wysoka rotacja = aktywny token = wysokie tempo.
 *
 * Skala: 1x → 0, 100x → 100 (logarytmiczna)
 */
function computeSpeedNew(volume24hUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0 || volume24hUsd <= 0) return 0
  const velocity = volume24hUsd / liquidityUsd
  // log10(velocity): 1x → 0, 10x → 1, 100x → 2
  // (log10(velocity) / 2) * 100: 1x → 0, 100x → 100
  const speed = (Math.log10(velocity) / 2) * 100
  return clampStat(speed)
}

// === ZMIANA 2: Wiek jako bonus do HP ===

/**
 * Bonus do puli życia za przetrwanie.
 *
 * - 0–7 dni: brak bonusu (świeży token nie dostaje premii)
 * - 7–30 dni: bonus rośnie liniowo od 0% do +10%
 * - 30+ dni: bonus +10% (sufit)
 *
 * Przetrwanie miesiąca to sygnał jakości. Świeżość nie jest.
 */
function computeSurvivalBonus(ageDays: number): number {
  if (ageDays < 7) return 0
  if (ageDays >= 30) return 0.1
  // Liniowy wzrost od 7 do 30 dni: 0% → 10%
  return ((ageDays - 7) / (30 - 7)) * 0.1
}

// === Pozostałe statystyki bez zmian ===

function computeStats(token: typeof ASKR) {
  const { liquidityUsd, volume24hUsd, holders, ageDays, marketCapUsd } = token

  const wytrzymalosc =
    ((Math.log10(liquidityUsd) - STAT_SCALE.wytrzymalosc.minLog) /
      STAT_SCALE.wytrzymalosc.decades) * 100

  const sila =
    ((Math.log10(volume24hUsd) - STAT_SCALE.sila.minLog) /
      STAT_SCALE.sila.decades) * 100

  const garda =
    ((Math.log10(holders) - STAT_SCALE.garda.minLog) /
      STAT_SCALE.garda.decades) * 100

  // NOWA szybkość: rotacja płynności
  const szybkosc = computeSpeedNew(volume24hUsd, liquidityUsd)

  const vulnerability = clampStat(
    (Math.log10(marketCapUsd / liquidityUsd) / STAT_SCALE.vulnerability.decades) * 100
  )

  // NOWY bonus: wiek → pula życia
  const survivalBonus = computeSurvivalBonus(ageDays)

  return {
    wytrzymalosc: clampStat(wytrzymalosc),
    sila: clampStat(sila),
    garda: clampStat(garda),
    szybkosc,
    vulnerability,
    survivalBonus,
  }
}

// === Parametry bojowe (uproszczona wersja z fight.ts) ===

const BALANCE = {
  hpBase: 180,
  tempoBase: 8,
  tempoFromSpeed: 8,
  powerBase: 6,
  powerFromStrength: 6,
  guardSoakMax: 0.3,
  vulnerabilityHpPenalty: 0.15,
  vulnerabilityDamageTaken: 0.15,
}

function combatProfile(stats: ReturnType<typeof computeStats>) {
  const { wytrzymalosc, sila, garda, szybkosc, vulnerability, survivalBonus } = stats

  const vulnerabilityNorm = vulnerability / 100

  // Pula życia: wytrzymałość + NOWY bonus za przetrwanie - kara za podatność
  const hpStart =
    (BALANCE.hpBase + wytrzymalosc) *
    (1 + survivalBonus) * // NOWY: bonus za wiek
    (1 - BALANCE.vulnerabilityHpPenalty * vulnerabilityNorm)

  return {
    hpStart,
    tempo: BALANCE.tempoBase + Math.round((szybkosc / 100) * BALANCE.tempoFromSpeed),
    power: BALANCE.powerBase + (sila / 100) * BALANCE.powerFromStrength,
    guardSoak: 1 - (garda / 100) * BALANCE.guardSoakMax,
    damageTaken: 1 + vulnerabilityNorm * BALANCE.vulnerabilityDamageTaken,
  }
}

// === Kalkulacja ===

console.log('='.repeat(70))
console.log('PORÓWNANIE: Oryginalne formuły vs Przepisane')
console.log('='.repeat(70))
console.log()

// Oryginalna formuła szybkości (z CLAUDE.md)
function computeSpeedOld(ageDays: number): number {
  const szybkosc =
    100 - (Math.log10(ageDays + 1) / Math.log10(731)) * 100
  return clampStat(szybkosc)
}

console.log('--- ASKR ---')
console.log(`Płynność: $${ASKR.liquidityUsd.toLocaleString()}`)
console.log(`Obrót 24h: $${ASKR.volume24hUsd.toLocaleString()}`)
console.log(`Rotacja: ${(ASKR.volume24hUsd / ASKR.liquidityUsd).toFixed(1)}x`)
console.log(`Wiek: ${ASKR.ageDays.toFixed(2)} dni`)
console.log()

const askrStatsNew = computeStats(ASKR)
const askrProfileNew = combatProfile(askrStatsNew)

console.log('STARE formuły:')
console.log(`  Szybkość (z wieku): ${computeSpeedOld(ASKR.ageDays)}`)
console.log(`  Bonus z wieku: 0% (nie było)`)
console.log()
console.log('NOWE formuły:')
console.log(`  Szybkość (rotacja): ${askrStatsNew.szybkosc}`)
console.log(`  Bonus z wieku: +${(askrStatsNew.survivalBonus * 100).toFixed(1)}%`)
console.log()
console.log(`Parametry bojowe (NOWE):`)
console.log(`  HP start: ${askrProfileNew.hpStart.toFixed(1)}`)
console.log(`  Tempo: ${askrProfileNew.tempo} ciosów/rundę`)
console.log(`  Siła: ${askrProfileNew.power.toFixed(2)}`)
console.log()
console.log()

console.log('--- SHROOM ---')
console.log(`Płynność: $${SHROOM.liquidityUsd.toLocaleString()}`)
console.log(`Obrót 24h: $${SHROOM.volume24hUsd.toLocaleString()}`)
console.log(`Rotacja: ${(SHROOM.volume24hUsd / SHROOM.liquidityUsd).toFixed(1)}x`)
console.log(`Wiek: ${SHROOM.ageDays.toFixed(2)} dni`)
console.log()

const shroomStatsNew = computeStats(SHROOM)
const shroomProfileNew = combatProfile(shroomStatsNew)

console.log('STARE formuły:')
console.log(`  Szybkość (z wieku): ${computeSpeedOld(SHROOM.ageDays)}`)
console.log(`  Bonus z wieku: 0% (nie było)`)
console.log()
console.log('NOWE formuły:')
console.log(`  Szybkość (rotacja): ${shroomStatsNew.szybkosc}`)
console.log(`  Bonus z wieku: +${(shroomStatsNew.survivalBonus * 100).toFixed(1)}%`)
console.log()
console.log(`Parametry bojowe (NOWE):`)
console.log(`  HP start: ${shroomProfileNew.hpStart.toFixed(1)}`)
console.log(`  Tempo: ${shroomProfileNew.tempo} ciosów/rundę`)
console.log(`  Siła: ${shroomProfileNew.power.toFixed(2)}`)
console.log()
console.log()

console.log('='.repeat(70))
console.log('WPŁYW NA WYNIK')
console.log('='.repeat(70))
console.log()

// Różnice
const tempoDiff = askrProfileNew.tempo - shroomProfileNew.tempo
const hpDiff = askrProfileNew.hpStart - shroomProfileNew.hpStart

console.log('Przewaga ASKR w tempie:')
console.log(`  STARE: 15 vs 12 ciosów = +3 (+25%)`)
console.log(`  NOWE: ${askrProfileNew.tempo} vs ${shroomProfileNew.tempo} ciosów = ${tempoDiff > 0 ? '+' : ''}${tempoDiff} (${tempoDiff > 0 ? '+' : ''}${((tempoDiff / shroomProfileNew.tempo) * 100).toFixed(0)}%)`)
console.log()

console.log('Przewaga wHP start:')
console.log(`  STARE: ASKR 202.1 vs SHROOM 188.35 = +13.8 (+7.3%)`)
console.log(`  NOWE: ASKR ${askrProfileNew.hpStart.toFixed(1)} vs SHROOM ${shroomProfileNew.hpStart.toFixed(1)} = ${hpDiff > 0 ? '+' : ''}${hpDiff.toFixed(1)} (${((hpDiff / shroomProfileNew.hpStart) * 100).toFixed(1)}%)`)
console.log()

console.log('='.repeat(70))
console.log('PROGNOZA')
console.log('='.repeat(70))
console.log()

// Prosta heurystyka: tempo × siła × HP
const askrPower = askrProfileNew.tempo * askrProfileNew.power * askrProfileNew.hpStart
const shroomPower = shroomProfileNew.tempo * shroomProfileNew.power * shroomProfileNew.hpStart

console.log('Łączna "moc bojowa" (tempo × siła × HP):')
console.log(`  ASKR: ${askrPower.toFixed(0)}`)
console.log(`  SHROOM: ${shroomPower.toFixed(0)}`)
console.log()

if (askrPower > shroomPower) {
  const advantage = ((askrPower / shroomPower - 1) * 100).toFixed(1)
  console.log(`❌ ASKR nadal wygra (przewaga ${advantage}%)`)
  console.log()
  console.log('Dlaczego? Rotacja ASKR to 33.5x vs 4.9x SHROOM.')
  console.log('Mimo że szybkość już nie jest "premią za świeżość",')
  console.log('ASKR jest realnie bardziej aktywny — to nie artefakt wieku.')
} else {
  const advantage = ((shroomPower / askrPower - 1) * 100).toFixed(1)
  console.log(`✅ SHROOM teraz wygrywa (przewaga ${advantage}%)`)
  console.log()
  console.log('Bonus za przetrwanie i zmniejszona przewaga tempa odwróciły wynik.')
}
console.log()

// Statystyki finalne
console.log('='.repeat(70))
console.log('STATYSTYKI FINALNE (NOWE formuły)')
console.log('='.repeat(70))
console.log()
console.log('         | ASKR | SHROOM | Przewaga')
console.log('---------+------+--------+---------')
console.log(`Wytrzym. | ${String(askrStatsNew.wytrzymalosc).padStart(4)} | ${String(shroomStatsNew.wytrzymalosc).padStart(6)} | ${shroomStatsNew.wytrzymalosc > askrStatsNew.wytrzymalosc ? 'SHROOM' : 'ASKR'} +${Math.abs(shroomStatsNew.wytrzymalosc - askrStatsNew.wytrzymalosc)}`)
console.log(`Siła     | ${String(askrStatsNew.sila).padStart(4)} | ${String(shroomStatsNew.sila).padStart(6)} | ${askrStatsNew.sila > shroomStatsNew.sila ? 'ASKR' : 'SHROOM'} +${Math.abs(askrStatsNew.sila - shroomStatsNew.sila)}`)
console.log(`Garda    | ${String(askrStatsNew.garda).padStart(4)} | ${String(shroomStatsNew.garda).padStart(6)} | ${shroomStatsNew.garda > askrStatsNew.garda ? 'SHROOM' : 'ASKR'} +${Math.abs(shroomStatsNew.garda - askrStatsNew.garda)}`)
console.log(`Szybkość | ${String(askrStatsNew.szybkosc).padStart(4)} | ${String(shroomStatsNew.szybkosc).padStart(6)} | ${askrStatsNew.szybkosc > shroomStatsNew.szybkosc ? 'ASKR' : 'SHROOM'} +${Math.abs(askrStatsNew.szybkosc - shroomStatsNew.szybkosc)}`)
console.log(`Podatn.  | ${String(askrStatsNew.vulnerability).padStart(4)} | ${String(shroomStatsNew.vulnerability).padStart(6)} | ${askrStatsNew.vulnerability < shroomStatsNew.vulnerability ? 'ASKR' : 'SHROOM'} -${Math.abs(askrStatsNew.vulnerability - shroomStatsNew.vulnerability)}`)
console.log()
console.log(`Bonus wieku: ASKR +${(askrStatsNew.survivalBonus * 100).toFixed(1)}% | SHROOM +${(shroomStatsNew.survivalBonus * 100).toFixed(1)}%`)
