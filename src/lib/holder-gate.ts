/**
 * Bramka na liczbie holderów: badania lekarskie, których nie da się kupić.
 *
 * Czysta arytmetyka — bez sieci, bez env, bez modelu językowego. Model nie
 * dotyka tej liczby ani nie ocenia, czy token „ma społeczność"; dostaje
 * policzony wynik i go opisuje (CLAUDE.md § Zasada nadrzędna).
 *
 * Powód, dla którego jest osobno od `concentration.ts`: koncentracja podaży
 * potrzebuje sald portfeli, a te siedzą za planem Growth. Liczba holderów
 * przychodzi z `filterTokens` na darmowym kluczu, więc ta bramka działa zawsze.
 * Bez niej token z pięćdziesięcioma portfelami — bez odsiewu koncentracji —
 * wchodzi do ringu jak każdy inny.
 */

/**
 * Poniżej tej liczby zawodnik nie przechodzi badań i przegrywa walkowerem.
 *
 * Próg sztywny i niezależny od przeciwnika: ten sam token dostaje ten sam
 * wynik w każdej walce (CLAUDE.md § Mapowanie danych na statystyki). Dokładnie
 * 200 holderów przechodzi — granica należy do strony zaliczonej, bo „poniżej
 * 200" to mniej niż 200.
 */
export const MIN_HOLDERS = 200

export interface HolderGate {
  /** Liczba holderów, z której wyszła bramka. */
  holders: number
  minHolders: number
  passed: boolean
}

export function holderGate(holders: number): HolderGate {
  return {
    holders,
    minHolders: MIN_HOLDERS,
    // `NaN >= 200` jest fałszem, więc brak liczby nie przechodzi po cichu.
    passed: holders >= MIN_HOLDERS,
  }
}
