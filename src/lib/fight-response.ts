/**
 * Kształt odpowiedzi `GET /api/fight`, w jednym miejscu dla obu stron.
 *
 * Front importuje to wyłącznie jako typ (`import type`), więc nic z `codex.ts`
 * ani `fight.ts` nie wchodzi do paczki przeglądarki — a nie może, bo `codex.ts`
 * czyta `CODEX_API_KEY` już przy wczytaniu modułu. Klucz żyje po stronie
 * serwera, patrz CLAUDE.md § Źródło danych.
 */
import type { Standings } from '../app/api/fight/route'
import type { TokenFightData } from './codex'
import type { FightResult } from './fight'
import type { Matchup } from './stats'
import type { TrackedWallets } from './tracked'

export interface FightApiResponse {
  network: { id: number }
  tokenA: TokenFightData
  tokenB: TokenFightData
  /** Walka między kategoriami dostaje widoczne oznaczenie (CLAUDE.md). */
  matchup: Matchup
  fight: FightResult
  /** Bilans obu kontraktów po tej walce; `null`, gdy rankingu nie było. */
  standings: Standings | null
  /**
   * Ile adresów z serwerowej listy obserwowanych portfeli trzyma każdego
   * z tokenów. Same liczby — lista nigdy nie wychodzi z serwera, a `tracked.ts`
   * nie jest tu importowany inaczej niż jako typ (patrz nagłówek pliku).
   */
  tracked: TrackedWallets
}

export interface FightApiError {
  error: string
}
