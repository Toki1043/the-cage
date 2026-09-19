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
siła         = (log10(obrót24hUSD) - 3) / 5 * 100          // $1k → 0, $100M → 100
garda        = (log10(holderzy) - 1) / 5 * 100              // 10 → 0, 1M → 100
szybkość     = 100 - (log10(dni + 1) / log10(731)) * 100    // dziś → 100, 2 lata → 0
```

Siła bierze się z **obrotu 24h** pary referencyjnej, nie z kapitalizacji ani płynności.
Kiedyś była to kapitalizacja / płynność — to miara ryzyka, nie siły: token bez płynności
dostawał maksimum i wygrywał ze zdrowym. Ten stosunek żyje teraz jako podatność (niżej).

Kontrola poprawności — token AI (Artificial Inu), płynność $2,13M, obrót 24h $1 mln
(liczba wzorcowa, nie pomiar), kapitalizacja $273,4M, 46 755 holderów, 56 dni:
wytrzymałość 67, siła 60, garda 73, szybkość 39, podatność 70.

Jeśli przeliczenie daje inne liczby, wzór został źle zaimplementowany.

### Podatność (szklana szczęka)

Kapitalizacja / płynność nie jest statystyką bojową, tylko podatnością, w skali 0–100:

```
podatność = log10(kapitalizacja / płynność) / 3 * 100       // 1x → 0, 1000x → 100
```

Wysoka podatność zmniejsza pulę życia (do −15%) i zwiększa obrażenia otrzymywane
(do +15%). Zerowa płynność przy dodatniej kapitalizacji daje sufit, czyli 100.
W kodzie nazywa się `vulnerability`, bo `glassJaw` jest już zajęte przez pasmo
koncentracji 50–70%.

### Bramka na holderach

Poniżej **200 holderów** zawodnik nie przechodzi badań lekarskich i przegrywa walkowerem —
tak samo jak przy koncentracji powyżej 70%. Liczba holderów przychodzi z `filterTokens`
za darmo, więc ta bramka działa bez planu Growth, w przeciwieństwie do koncentracji.
Dokładnie 200 przechodzi. Gdy Codex nie zwróci liczby holderów, zapytanie kończy się
błędem, a nie walkowerem: zero z braku danych byłoby wynikiem wziętym znikąd.
Zawodnik z obiema wadami dostaje jeden powód — holderów.

## Komentarz (`/api/commentary`)

Komentatorów jest dwóch i to **dwa różne modele u dwóch dostawców**, wołane równolegle
tym samym kluczem Orbio: komentator przy ringu (`call`, `anthropic/claude-sonnet-4.5`)
i komentator barwny (`colour`, `google/gemini-3.5-flash`). Każdy ma własny prompt (inny
charakter) i własny strumień; trasa skleja je w jeden. Sędzia nie jest modelem.

Walka nigdy nie czeka na komentarz. Front startuje żądanie w tej samej chwili, w której
dostaje wynik z `/api/fight`, i od razu odgrywa walkę; tekst rundy dokleja się do panelu,
gdy dojdzie. Trasa zwraca strumień NDJSON (`line` / `voice_error` / `done` / `error`),
a każda kwestia wychodzi, gdy tylko jej model domknie obiekt rundy. Głosy nie czekają
na siebie. Kod: `src/lib/commentary.ts` (prompty, skaner), `src/lib/commentary-run.ts`
(orkiestracja dwóch głosów, testowana offline), `src/lib/commentary-voices.ts`.

- Nie wracaj do `await` na komentarzu przed `ring.play()`. To było 6–7 s martwego czasu
  przed pierwszym dzwonkiem, a sam model nie był tam wąskim gardłem.
- **Padnięcie jednego głosu nie wywraca walki ani drugiego głosu.** Odmowa albo błąd
  jednego modelu to zdarzenie `voice_error`, drugi mówi dalej, a notka pod panelem
  mówi, kto odpadł. Zdarzenie `error` (i HTTP 502 przed strumieniem) jest dopiero wtedy,
  gdy nie odpowie żaden. Każdy głos ma sufit czasu (`VOICE_TOTAL_TIMEOUT_MS`).
- Modele: `OPENROUTER_MODEL` (przy ringu) i `OPENROUTER_MODEL_COLOUR` (barwny); domyślne
  w `commentary-voices.ts`. Lista z `GET /api/v1/models` nie wystarcza: potrafi zawierać
  modele, których nikt nie obsługuje (404), więc kandydata trzeba wywołać na żywo.
  Gemini 3.5 Flash dostaje `reasoning: {effort: 'minimal'}`, bo inaczej rozumowanie zjada
  limit tokenów i odpowiedź się urywa; modele GPT-5 odpadły (odrzucają `temperature`,
  ignorują limity znaków).
- Zmierzone przez Orbio (`npm run check:commentary`, każdy głos osobno; trasa woła je
  naraz, więc całość trwa tyle, co wolniejszy): przy ringu (Sonnet 4.5, sam `call`, ~150–200
  tokenów przy ~55–60 tok/s) pierwsza kwestia po ~2,9–3,3 s, całość ~4,6–5,2 s; barwny
  (Gemini 3.5 Flash, ~85–130 tokenów) pierwsza po ~1,4–2,0 s, całość ~1,7–2,8 s.
  Wcześniej jeden Sonnet piszący oba pola: pierwsza runda ~3,5 s, całość ~6,6–7,9 s.
  Skrypt przyjmuje `VOICE=colour`, `MODEL=...` (z `VOICE`) i `LIST=1`.
- Koniec walki albo skip przerywa strumień, a serwer przerywa wywołania obu modeli.
- Bez rund (walkower, odwołanie) nie ma czego komentować i modele nie są wołane.
- Modele nadal widzą wyłącznie policzone liczby i nigdy wyniku. Żaden z głosów nie może
  mówić, kto prowadzi, kto wziął rundę ani kto wygrywa (rozstrzyga symulacja i sędzia);
  `verify:commentary` pilnuje tego w promptach.
- Liczba w nagłówku strony („2 models · one Orbio key · Orbio Build Week") wynika z liczby
  głosów (`ORBIO_MODELS_IN_USE` w `lib/orbio-stack.ts`); dodajesz model — popraw ją.
- Limit zapytań na IP: `PER_IP_LIMIT` (10 na minutę) z `lib/rate-limit.ts`, ten sam co na
  `/api/fight`, ale we własnym wiadrze — jedna walka to po jednym wywołaniu każdej trasy,
  więc wspólny licznik zjadałby dwa zapytania na walkę. Jedno zapytanie do komentarza to
  dwa wywołania modeli. Kontrola jest przed odczytem ciała i przed modelem, a liczy się też
  błędny ładunek. Bez Upstasha licznik jest per instancja, więc na Vercelu realny próg to
  wielokrotność 10 na minutę; do produkcji podłącz Upstash.

## Skan kontraktu (GoPlus)

Publiczny endpoint, bez klucza: `https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={adres}`.
Robinhood Chain to chainId 4663, to samo id co w Codexie. Kod w `src/lib/security.ts`.

Pięć pytań: honeypot, mintable, blacklist, czy właściciel może zmieniać salda
i czy może wstrzymać transfery (`transfer_pausable`).

- **Honeypot to bramka**, jak holderzy: zawodnik nie przechodzi badań i przegrywa
  walkowerem, bez rund. Kolejność powodów przy kilku wadach: holderzy, honeypot,
  koncentracja — jeden powód na osobę.
- **Pozostałe cztery to ostrzeżenia** w narożniku. Nie wchodzą do symulacji.
- **Każde sprawdzenie ma trzy stany**: wykryto / nie wykryto / brak danych. GoPlus
  potrafi znać adres i nie zwrócić żadnego z pól (WETH na 4663), więc brak pola
  nigdy nie jest zerem.
- **Brak skanu (sieć nieobsługiwana, adres nieznany, timeout, błąd) to `null`
  z notatką**, a walka idzie normalnie. Walkower za to, że GoPlus nie odpowiedział,
  byłby wynikiem wziętym znikąd.
- Nigdy nie pisz, że token jest bezpieczny. „Nie wykryto" znaczy, że skan czegoś
  nie znalazł. Skan idzie do snapshotu (`snapshot.security`) i do rankingu.
- Model tych flag nie widzi.

## Układ ekranu

Szkielet to siatka na `.cage`: trzy kolumny (karta czerwona | środek | karta niebieska)
i dwa wiersze (pasek górny `auto`, scena `1fr`). Pasek górny i scena są w przepływie,
więc nic w środku nie może na siebie nachodzić, jakkolwiek długi byłby tekst komunikatu.

- Nie wracaj do stałej wysokości paska ani do `position:absolute` dla elementów z tekstem.
  Ten błąd wracał już dwa razy: zgadnięta wartość rozjeżdża się z prawdziwą wysokością.
- Długie opisy (GOAT WALLETS, skan GoPlus) nie leżą na środku ekranu, tylko za „?" w karcie
  narożnika. Na środku zostają krótkie komunikaty.
- Węższy niż 56rem wszystko układa się w jednej kolumnie i przewija się cały ekran.
  Nadpisania mobilne muszą stać w pliku PO regułach bazowych, inaczej przegrywają kolejnością.

## Panel „WHY"

Stała tabela po walce, do następnej walki. Domyślnie zwinięta do paska nagłówka
(ring z wynikiem ma być widoczny od razu), rozwijana kliknięciem. Nie jest komentarzem: cała treść to
arytmetyka i szablony w `src/lib/why.ts`, bez udziału modelu.

- Każda statystyka obok surowej liczby, z której powstała: wytrzymałość ← płynność,
  siła ← obrót 24h, garda ← holderzy, szybkość ← wiek pary, podatność ← kapitalizacja
  ÷ płynność jako krotność. Do tego obserwowane portfele i wynik skanu GoPlus.
- Jedno zdanie liczone z tych liczb: przy walce największa przewaga i największy deficyt
  zwycięzcy, przy walkowerze powód z zapisanego zdarzenia badań. Zdanie mówi wprost, że
  ciosy idą z ziarna, więc różnice w statystykach przechylają walkę, ale jej nie przesądzają.
- Linia o źródle: skąd dane, znacznik czasu snapshotu, ziarno i informacja, że wynik jest
  deterministyczny dla tej pary na tym snapshocie. Dane się ruszają, więc nie pisz, że
  te dwa kontrakty „zawsze walczą tak samo".
- Bez „safe", „smart money" i prognoz. `verify:why` pilnuje tych słów.

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

Wyjątek z decyzji właściciela: licznik portfeli z prywatnej listy `TRACKED_WALLETS`
nazywa się w UI **GOAT WALLETS**. To nazwa listy, nie ocena: zostaje samym licznikiem
("3 of 40"), z notatką, że to nie sygnał i niczego nie mówi o przyszłych ruchach portfela.
Reguła powyżej dalej obowiązuje dla skuteczności portfela — żadnych etykiet z wyniku.

Budżet zapytań: darmowy próg Codexu to 10 000 miesięcznie. Historia handlu
50 holderów × 2 tokeny to ponad 100 zapytań na walkę. Dlatego: top 10, wyniki
w cache per portfel, liczone po walce a nie przed.

Zmiana ceny 24h jako modyfikator obrażeń — opcjonalnie, jeśli zostanie czas.

## Panel "Ringside read"

Po walce, te same liczby podane w dolarach, **bez udziału modelu** — czysta arytmetyka
puli o stałym iloczynie (x·y=k):

- ile sprzedasz, zanim cena spadnie o 10% (ok. 2,7% płynności)
- ile papieru przypada na $1 wyjścia (kapitalizacja / płynność)
- **ile zakupu potrzeba na 2x** ≈ 41,4% płynności (√2 - 1)
- **ile sprzedaży sprowadza cenę o połowę** ≈ 29,3% płynności (1 - 1/√2)

Dwie ostatnie zawsze pokazuj razem. Ta sama płytka płynność, która ułatwia wzrost,
równie łatwo działa w dół — pokazanie tylko wzrostu byłoby zachętą, nie informacją.

Przy każdej z tych wartości pisz "około". Przy skoncentrowanej płynności (Uniswap
v3/v4) wynik bywa inny w obie strony — nie udawaj precyzji, której nie ma.

**Czego ten panel NIE robi:** nie podaje prawdopodobieństwa, że token urośnie.
Z płynności, kapitalizacji, holderów i wieku nie wynika szansa na 2x. Panel mówi,
ile kosztuje ruch ceny, nie czy ten ruch nastąpi. Nigdy nie formułuj tego jako
"większa szansa na wzrost", "lepsza okazja" ani żadnej innej prognozy.

### Zdanie porównawcze pod panelem

Główne zdanie pod „Ringside read" (`comparisonHeadline` w `src/lib/ringside.ts`) nie mówi
już zawsze o płynności. Wybiera **najostrzejszą różnicę z trzech**:

1. koncentracja podaży — punkty procentowe między tokenami, próg 10 pp; tylko z odsianych
   sald (`concentration.status === 'ok'`), nigdy z surowego `top10HoldersPercent`;
2. rotacja przy płynności (obrót 24h ÷ płynność) — jedna co najmniej 2× większa od drugiej,
   obie liczone od dołu do 1% dziennie;
3. liczba GOAT WALLETS — różnica co najmniej 10% listy i co najmniej 3 portfele.

Każda różnica jest dzielona przez swój próg, żeby trzy miary dały wynik w jednej skali
(1 = na progu); wygrywa najwyższy wynik ≥ 1, remis rozstrzyga kolejność powyżej. Gdy żadna nie
różnicuje wyraźnie, zdanie wraca do wyjścia z pozycji (ile da się sprzedać przed spadkiem
o 10%). Wszystko to arytmetyka i progi, bez modelu.

- Zdania podają liczby, nie oceny: „26 of 67 GOAT WALLETS hold $AI, 18 hold $WETH." Bez
  „więcej znaczy lepiej", bez porad, bez prognoz. Lista portfeli dalej nie jest sygnałem.
- Brak koncentracji po którejkolwiek stronie po cichu wyłącza jej wariant. **Dziś tak jest
  zawsze:** salda holderów wymagają planu Growth (Codex odpowiada `Not authorized: please
  upgrade your plan`, sprawdzone na żywo). Po zmianie planu wariant włączy się sam.
- `npm run verify:headline` pilnuje progów, remisów, cichego pomijania wariantów i słów oceny.

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

Nie używaj nazwiska ani wizerunku żyjącej osoby — ani jako sędziego, ani jako
zawodnika, ani w nazwie projektu.

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
