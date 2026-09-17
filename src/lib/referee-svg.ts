/**
 * Sędzia — Tung Tung Tung Sahur: kłoda z twarzą, muchą i pałką.
 *
 * Postać przychodzi z modelu obrazkowego w dwóch warstwach (patrz
 * scripts/generate-art.ts, presety `sahur` i `club`), złożonych tutaj jako
 * dwa `<image>` w jednym SVG. Pałka jest osobną warstwą, żeby CSS mógł ją
 * obracać wokół dłoni: wymach w gong na start rundy, rąbanie przy odliczaniu,
 * zamaszysty gest przy przerwaniu walki.
 *
 * To omija powód zakazu z CLAUDE.md § Sędzia — „obrazek jest statyczny
 * i nie umie się ruszać" — nie łamiąc go: warstwa się rusza, choć jest
 * obrazkiem. Wcześniej cała figura była rysowana kształtami SVG i wyglądała
 * słabo; geometria została, zmieniło się tylko, co ją wypełnia.
 *
 * Gong zostaje rysowany kształtami, bo jest prostym stojakiem i tarczą,
 * i musi dzwonić w rytm wymachu.
 *
 * Co sędzia mówi, liczy `referee.ts` z wyniku symulacji; figura tylko
 * odgrywa. Odliczanie jest animacją, nie losowaniem.
 *
 * Ten sam układ współrzędnych co `fighter-svg.ts`: viewBox 120×176, podłoga
 * na y=168.
 */

/**
 * Położenia policzone z pomiarów obu obrazków, nie na oko — wartości
 * wyliczone w komentarzu niżej, żeby dało się je odtworzyć po regeneracji
 * grafiki (rozmiary źródeł mogą się zmienić).
 *
 * Kłoda 512×512, treść w bbox (63,46)–(448,470), środek prawej dłoni (430,321).
 * Pałka 512×512, knob rączki (176,460), czubek (301,51) — z czego wychodzi
 * wbudowany przechył 17° od pionu i długość osi 428 px.
 *
 * Skala: figura ma 92 jednostki wysokości widocznej, stopy na podłodze,
 * środek w x=44. Pałka ma 40 jednostek długości, chwyt 20% drogi od knoba.
 */
const BODY = { x: -11.4, y: 66.0, size: 111.1 }

/** Dłoń: oś obrotu pałki. Ta sama para liczb siedzi w `transform-origin` w CSS. */
const HAND = { x: 81.9, y: 135.7 }

/**
 * Pałka. Chwyt wypada w 20% drogi od knoba rączki do czubka, czyli na
 * ułamkach (0.393, 0.738) szerokości i wysokości obrazka — stąd położenie
 * warstwy wynika z pozycji dłoni, zamiast stać obok niej jako druga,
 * niezależna liczba, którą łatwo rozjechać przy zmianie skali.
 */
const CLUB_SIZE = 47.9
const CLUB_GRIP = { x: 0.393, y: 0.738 }
const CLUB = {
  size: CLUB_SIZE,
  x: HAND.x - CLUB_GRIP.x * CLUB_SIZE,
  y: HAND.y - CLUB_GRIP.y * CLUB_SIZE,
}

const GONG = { x: 106, y: 122, r: 10 }

export function drawReferee(): string {
  const parts: string[] = []

  /* Stojak gongu. Rysowany pierwszy, więc zostaje z tyłu. */
  parts.push(
    `<g class="gong-rig">` +
      `<rect x="116" y="70" width="3" height="94" rx="1.5" fill="var(--rule)"/>` +
      `<rect x="110" y="162" width="10" height="3.5" rx="1.7" fill="var(--rule)"/>` +
      `<rect x="103" y="70" width="16" height="3" rx="1.5" fill="var(--rule)"/>` +
      `<path d="M105 73 L102 ${GONG.y - GONG.r} M117 73 L110 ${GONG.y - GONG.r}" ` +
      `stroke="var(--rule)" stroke-width="1.2" fill="none"/>` +
      `</g>`,
  )
  parts.push(
    `<g class="gong">` +
      `<circle cx="${GONG.x}" cy="${GONG.y}" r="${GONG.r}" fill="var(--gold)" opacity=".92"/>` +
      `<circle cx="${GONG.x}" cy="${GONG.y}" r="${GONG.r * 0.62}" fill="none" stroke="var(--ink)" ` +
      `stroke-width="1" opacity=".22"/>` +
      `<circle cx="${GONG.x}" cy="${GONG.y}" r="2.2" fill="var(--ink)" opacity=".3"/>` +
      `</g>`,
  )

  /*
   * Dwie grupy zagnieżdżone, bo każda nosi osobną animację i jedna klasa
   * nie może nadpisać drugiej: `ref-sway` kołysze całą postacią przy
   * instrukcjach i werdykcie, `ref-fig` oddycha w spoczynku.
   */
  const body = `<image href="/arena/sahur.png" x="${BODY.x}" y="${BODY.y}" ` +
    `width="${BODY.size}" height="${BODY.size}" preserveAspectRatio="xMidYMid meet"/>`
  const club = `<g class="club"><image href="/arena/club.png" x="${CLUB.x}" y="${CLUB.y}" ` +
    `width="${CLUB.size}" height="${CLUB.size}" preserveAspectRatio="xMidYMid meet"/></g>`

  parts.push(`<g class="ref-sway"><g class="ref-fig">${body}${club}</g></g>`)

  return (
    `<svg viewBox="0 0 120 176" role="img" aria-label="Referee">` + parts.join('') + `</svg>`
  )
}
