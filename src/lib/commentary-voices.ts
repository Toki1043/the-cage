/**
 * Dwa głosy komentarza. Plik bez env i bez sieci: importuje go i front (typ
 * głosu), i trasa, i `orbio-stack.ts` (liczba modeli w nagłówku).
 *
 * Każdy głos to osobny model u osobnego dostawcy, wołany osobnym zapytaniem
 * przez Orbio. Który model — patrz `VOICE_MODELS` w `openrouter.ts` (tam żyją
 * zmienne środowiskowe, a tego pliku nie wolno ciągnąć razem z kluczem).
 */
export type CommentaryVoice = 'call' | 'colour'

/** Kolejność ma znaczenie tylko dla wyświetlania; głosy lecą równolegle. */
export const COMMENTARY_VOICES: readonly CommentaryVoice[] = ['call', 'colour']

/** Nazwy dla człowieka: do komunikatów na froncie. */
export const VOICE_NAMES: Record<CommentaryVoice, string> = {
  call: 'ringside commentator',
  colour: 'colour commentator',
}

/**
 * Domyślne modele głosów: dwa różne, u dwóch dostawców. Env (`OPENROUTER_MODEL`,
 * `OPENROUTER_MODEL_COLOUR`) je nadpisuje w `openrouter.ts`; tu leżą, żeby
 * `verify:commentary` mógł sprawdzić bez klucza, że nie są tym samym modelem.
 * Uzasadnienie wyboru: komentarz przy `VOICE_MODELS` w `openrouter.ts`.
 */
export const DEFAULT_VOICE_MODELS: Record<CommentaryVoice, string> = {
  call: 'anthropic/claude-sonnet-4.5',
  colour: 'google/gemini-3.5-flash',
}
