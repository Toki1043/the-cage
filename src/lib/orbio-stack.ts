import { COMMENTARY_VOICES } from './commentary-voices.ts'

/**
 * Ile różnych modeli aplikacja woła przez Orbio w czasie działania. Liczba
 * trafia do linijki „na czym projekt stoi" w nagłówku, więc musi być prawdziwa.
 *
 * Stan na dziś (sprawdzone w kodzie):
 * - komentatorzy: `/api/commentary` woła równolegle dwa modele u dwóch
 *   dostawców, po jednym na głos (`COMMENTARY_VOICES`; modele w `VOICE_MODELS`
 *   w `openrouter.ts`: `anthropic/claude-sonnet-4.5` przy ringu i
 *   `google/gemini-3.5-flash` jako barwny);
 * - sędzia: bez modelu, szablony z `referee.ts` liczone z wyniku symulacji;
 * - walka, statystyki, WHY, ringside read: czysta arytmetyka.
 *
 * Liczba wynika z liczby głosów, bo każdy głos to osobny model. To zakłada, że
 * modele są różne: trasa ostrzega w logu, gdy env sprowadzi oba głosy do tego
 * samego modelu, a `verify:commentary` pilnuje domyślnych.
 *
 * Nie liczą się modele obrazkowe z `scripts/generate-art.ts`: działają raz,
 * przy generowaniu grafik, a nie w aplikacji.
 *
 * Dodajesz nowy głos albo nowe wywołanie modelu gdziekolwiek indziej — ta liczba
 * musi to odzwierciedlić.
 */
export const ORBIO_MODELS_IN_USE = COMMENTARY_VOICES.length

/** „1 model" / „2 models" — bez „1 models". */
export function modelsLabel(n: number = ORBIO_MODELS_IN_USE): string {
  return `${n} ${n === 1 ? 'model' : 'models'}`
}
