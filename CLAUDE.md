# Projekt: walka dwóch kontraktów

Wklejasz dwa adresy tokenów → aplikacja ciągnie dane on-chain → zamienia je na statystyki
bokserskie → rozgrywa animowaną walkę → wynik trafia do rankingu.

Projekt na Orbio Build Week (7 dni). Cel: wejść do top 10.

## Zasada nadrzędna

**Matematyka decyduje, modele komentują.**

Wynik walki liczy deterministyczna symulacja na podstawie liczb z API. Model językowy
dostaje wyłącznie policzone statystyki i zwraca wyłącznie tekst komentarza. Model nigdy
nie widzi, kto wygrał, i nigdy nie wpływa na wynik.

Powód: ten sam wynik musi być powtarzalny i weryfikowalny. Jeśli model decyduje o wyniku,
całość jest losowym generatorem z ładną oprawą.

Nie łam tej zasady, nawet jeśli wydaje się to wygodniejsze.

## Determinizm

Seed symulacji powstaje z hashu dwóch adresów. Ta sama para adresów = zawsze ta sama walka.
Nie używaj `Math.random()` bez seeda w logice walki.

Uwaga: dane z Codexu zmieniają się w czasie (liczba holderów potrafi się ruszyć między
dwoma zapytaniami pod rząd). Dlatego każdy wynik zapisywany do rankingu idzie razem ze
**snapshotem danych wejściowych**, na podstawie których został policzony. Bez tego
wyniku nie da się później odtworzyć ani zweryfikować.

## Źródło danych

Codex (API Defined.fi). Jeden endpoint GraphQL:

```
POST https://graph.codex.io/graphql
Authorization: <klucz>
```

Klucz z codex.io. Darmowy próg: 10 000 zapytań miesięcznie.
Daje ceny, płynność, kapitalizację, agregaty czasowe, holderów i balanse portfeli.

Zapytania buduj i testuj w GraphQL Explorerze Codexu, zanim wkleisz je do kodu.
Schemat: docs.codex.io.

Klucz żyje wyłącznie po stronie serwera. Nigdy w przeglądarce, nigdy w kodzie frontu.

Fallback: jeśli Codex nie obsługuje którejś sieci, DexScreener
(`https://api.dexscreener.com/latest/dex/tokens/{adres}`, bez klucza) — ale bez holderów.

## Mapowanie danych na statystyki

Wszystkie cztery statystyki są normalizowane do skali **0–100**, na **sztywnych progach**.

Nigdy nie normalizuj względem przeciwnika. Ten sam token musi mieć te same statystyki
w każdej walce — inaczej ranking traci sens.

Skala jest logarytmiczna, bo te wielkości chodzą w rzędach wielkości (płynność od
kilkunastu tysięcy do setek milionów). Każdy wynik obetnij do przedziału 0–100.

```
wytrzymałość = (log10(płynnośćUSD) - 3) / 5 * 100          // $1k → 0, $100M → 100
siła         = log10(kapitalizacja / płynność) / 3 * 100    // 1x → 0, 1000x → 100
garda        = (log10(holderzy) - 1) / 5 * 100              // 10 → 0, 1M → 100
szybkość     = 100 - (log10(dni + 1) / log10(731)) * 100    // dziś → 100, 2 lata → 0
```

Kontrola poprawności — token AI (Artificial Inu), płynność $2,13M, kapitalizacja
$273,4M, 46 755 holderów, 56 dni: wytrzymałość 67, siła 70, garda 73, szybkość 39.

Jeśli przeliczenie daje inne liczby, wzór został źle zaimplementowany.

## Kategorie wagowe

Kapitalizacja nie jest statystyką bojową — wyznacza **kategorię wagową**.
Po to, żeby nie twierdzić, że token za $500 mln jest "lepszy" od tego za $2 mln.
To inne półki, tak jak waga musza i ciężka.

| Kategoria   | Kapitalizacja      |
|-------------|--------------------|
| Musza       | do $3 mln          |
| Lekka       | $3–20 mln          |
| Średnia     | $20–100 mln        |
| Półciężka   | $100–500 mln       |
| Ciężka      | powyżej $500 mln   |

Progi muszą się stykać bez dziur — token z każdą kapitalizacją musi wpaść dokładnie
w jedną kategorię.

Walka w obrębie jednej kategorii to uczciwe porównanie. Walka między kategoriami
dostaje widoczne oznaczenie, że lżejszy bije powyżej swojej wagi.

**Ranking jest osobny dla każdej kategorii** — pięć list zamiast jednej.

Czego NIE robić: nie twierdź, że niższa kapitalizacja oznacza większy potencjał
wzrostu. Niższy mcap to większa zmienność w obie strony, nie wyższy oczekiwany zysk.
Większość małych tokenów idzie do zera i nikt o nich nie pamięta — widoczne są
tylko te, które urosły. To błąd przeżywalności, ten sam co przy portfelach.

## Modyfikatory z wykresu

Liczone arytmetycznie z danych Codexu, nigdy interpretowane przez model:

- zmiana ceny w oknach 1h / 24h / 7d
- spadek od szczytu (drawdown) — token daleko od ATH wchodzi do ringu poobijany
- zmienność — wysoka oznacza mocniejsze, ale mniej celne ciosy

Model językowy **nie analizuje wykresu**. Nie ocenia trendu, nie mówi "bycze" ani
"niedźwiedzie", nie prognozuje ceny. Dostaje policzone liczby i je opisuje.

## Narożnik: holderzy

Top 10 holderów każdego tokena jako postacie za plecami zawodnika.
Do tego przecięcie zbiorów: ile portfeli trzyma obu zawodników.

Skuteczność portfela (opcjonalnie, tylko na zamkniętych pozycjach) pokazuj
**surowo**: "trafił 4 z 19". Nigdy jako etykietę "smart money", "alfa" ani
podobną. Portfel z serią trafień to najczęściej szczęściarz widoczny właśnie
dlatego, że trafił — pozostałych nikt nie zindeksował. To błąd przeżywalności.

Budżet zapytań: darmowy próg Codexu to 10 000 miesięcznie. Historia handlu
50 holderów × 2 tokeny to ponad 100 zapytań na walkę. Dlatego: top 10, wyniki
w cache per portfel, liczone po walce a nie przed.

Zmiana ceny 24h jako modyfikator obrażeń — opcjonalnie, jeśli zostanie czas.

## Panel "Ringside read"

Po walce, te same liczby podane w dolarach, **bez udziału modelu** — czysta arytmetyka:

- ile sprzedasz, zanim cena spadnie o 10% (ok. 2,7% płynności, pula o stałym iloczynie)
- ile papieru przypada na $1 wyjścia (kapitalizacja / płynność)

Przy pierwszej wartości pisz "około". Przy skoncentrowanej płynności (Uniswap v3/v4)
wynik bywa inny w obie strony — nie udawaj precyzji, której nie ma.

## Konfiguracja API

Klucz Orbio idzie przez pośrednika Orbio, nie wprost na OpenRouter:

```
OPENAI_BASE_URL=https://api.orbio.so/api/v1
OPENAI_API_KEY=sk-orbio-…
CODEX_API_KEY=…
```

Klient: OpenAI SDK z podmienionym `baseURL`. Potwierdzony działający model:
`anthropic/claude-sonnet-4.5`. Inne slugi weryfikuj przez `GET /api/v1/models`,
nie zgaduj.

Ustaw nagłówki `HTTP-Referer` i `X-Title` — OpenRouter przypisuje po nich zużycie
do aplikacji na swoim publicznym rankingu.

Klucz żyje wyłącznie w `.env.local`. Nigdy nie wpisuj go w kod ani w commit.

## Stack docelowy

Next.js na Vercelu. Trasa `/api/fight`: przyjmuje dwa adresy, ciąga DexScreenera,
liczy statystyki, rozgrywa symulację, zwraca wynik + komentarz.

Ranking per kontrakt (nie per walka) — to on daje powód, żeby wrócić drugi raz.
Osobna lista dla każdej kategorii wagowej. Potrzebna baza: Vercel KV albo Upstash.

## Uwaga o prototypie

Istniejący prototyp HTML używa `claude.use("sample")` i `db`. To są funkcje środowiska
artefaktów claude.ai i **na Vercelu nie istnieją**. Przy przenoszeniu:

- `claude.use("sample")` → własna trasa API wołająca Orbio
- `db` → realna baza

## Czego nie robić

- Model nie wymyśla faktów o tokenach — dostaje liczby, opisuje liczby.
- Żadnych porad inwestycyjnych, żadnego "kupuj" ani "sprzedawaj".
- Liczby, na których ktoś może stracić pieniądze, muszą być czystą arytmetyką,
  nie wyjściem z modelu.
- Bez emoji w komentarzu.

## Sędzia

W ringu jest trzecia postać: sędzia. Prowadzi walkę i nadaje jej charakter.

Co robi:
- instrukcje przed pierwszą rundą
- odliczanie przy nokaucie
- ogłoszenie werdyktu na końcu

Sędzia **nie decyduje o wyniku** — ogłasza wynik, który policzyła symulacja.
Tak samo jak komentatorzy: dostaje gotowy rezultat i ubiera go w słowa.
Odliczanie jest animacją, nie losowaniem — jeśli symulacja dała nokaut, odliczanie
zawsze kończy się na dziesięciu.

Sędzia jest rysowany proceduralnie jako SVG, tak samo jak zawodnicy — nie jako
wygenerowany obrazek. Obrazek jest statyczny i nie umie się ruszać.

Postać: **Tung Tung Tung Sahur** — kłoda z rękami i pałką, z włoskiego brainrotu.
Proste kształty, więc rysuje się jako SVG i animuje: wymach pałką przy odliczaniu,
uderzenie w gong na start rundy.

## Kolejność prac

0. Potwierdzić, że Codex wystawia Robinhood Chain: zapytanie `{ getNetworks { name id } }`.
1. Trasa `/api/fight` z Codexem i mapowaniem na statystyki.
2. Podpięcie istniejącego frontu.
3. Online na Vercelu (dzień trzeci).
4. Ranking w bazie.
5. Narożniki z portfelami: top holderzy jako postacie za plecami zawodnika, oraz
   przecięcie zbiorów holderów obu tokenów ("ile portfeli trzyma obu zawodników").
   Ramuj to jako ostrzeżenie o koncentracji podaży, nigdy jako sygnał do kupna.
   Nie oznaczaj portfeli jako "smart money" — to błąd przeżywalności. Jeśli już
   pokazujesz skuteczność, to jako surowe "trafił 4 z 19".
