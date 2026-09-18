/**
 * Bezpieczeństwo kontraktu z GoPlus Security API: pięć pytań o kod tokena.
 *
 * Bez klucza i bez modelu językowego. Model nie widzi tych flag ani nie ocenia,
 * czy kontrakt „wygląda podejrzanie" — do komentarza nie idzie nic z tego pliku
 * (CLAUDE.md § Zasada nadrzędna).
 *
 * Zasada, na której stoi cały plik: **brak danych to nie to samo co czysty
 * kontrakt**. Każde sprawdzenie ma trzy stany, a nie dwa:
 *
 *  - `detected`     — GoPlus zwrócił `"1"`,
 *  - `not_detected` — GoPlus zwrócił `"0"`,
 *  - `unknown`      — pola nie było, było puste albo miało inną wartość.
 *
 * Trzeci stan nie jest teoretyczny. Dla WETH na Robinhood Chain GoPlus zna
 * adres, ale żadnego z pięciu pól nie zwraca. Gdyby brak pola czytać jak
 * zero, WETH wyszedłby jako kontrakt bez honeypota, mintu, blacklisty,
 * dostępu do sald i wstrzymywania transferów — a nikt tego nie sprawdził.
 *
 * Z tego samego powodu nigdzie tu nie ma słowa „safe": `not_detected` znaczy,
 * że skan czegoś nie znalazł, nie że tego nie ma.
 */

const GOPLUS_ENDPOINT = 'https://api.gopluslabs.io/api/v1/token_security'

/**
 * Skan jest dodatkiem do walki, nie jej warunkiem. Nie czekamy na niego dłużej
 * niż to konieczne, bo każda sekunda idzie w ścieżkę krytyczną `/api/fight`.
 */
const TIMEOUT_MS = 6_000

export type SecurityFlag = 'detected' | 'not_detected' | 'unknown'

export interface SecurityChecks {
  /** Kupić się da, sprzedać nie. Jedyne z pięciu, które ma wpływ na walkę. */
  honeypot: SecurityFlag
  /** Właściciel może wybić nowe tokeny. Ostrzeżenie, bez wpływu na wynik. */
  mintable: SecurityFlag
  /** Kontrakt ma listę blokowanych adresów. Ostrzeżenie, bez wpływu na wynik. */
  blacklist: SecurityFlag
  /** Właściciel może zmieniać cudze salda. Ostrzeżenie, bez wpływu na wynik. */
  ownerCanChangeBalances: SecurityFlag
  /** Właściciel może wstrzymać transfery. Ostrzeżenie, bez wpływu na wynik. */
  transferPausable: SecurityFlag
}

export interface ContractSecurity {
  source: 'goplus'
  chainId: number
  /**
   * `null`, gdy GoPlus nie zna sieci, nie zna kontraktu, nie odpowiedział albo
   * odpowiedział bez żadnego z pięciu pól. Wtedy `note` mówi, co się stało.
   */
  checks: SecurityChecks | null
  /** Czemu nie ma liczby albo czemu część pól jest `unknown`. */
  note: string | null
}

/** Nazwy pól do notatek: po ludzku, w kolejności, w jakiej je pokazujemy. */
const CHECK_LABELS: Record<keyof SecurityChecks, string> = {
  honeypot: 'honeypot',
  mintable: 'mintable',
  blacklist: 'blacklist',
  ownerCanChangeBalances: 'owner can change balances',
  transferPausable: 'transfer pausable',
}

/** Klucze GoPlus dla każdego z pięciu sprawdzeń. */
const GOPLUS_FIELDS: Record<keyof SecurityChecks, string> = {
  honeypot: 'is_honeypot',
  mintable: 'is_mintable',
  blacklist: 'is_blacklisted',
  ownerCanChangeBalances: 'owner_change_balance',
  transferPausable: 'transfer_pausable',
}

/** Brak skanu — jawnie, żeby nigdzie nie udawał czystego kontraktu. */
export function securityUnavailable(chainId: number, note: string): ContractSecurity {
  return { source: 'goplus', chainId, checks: null, note }
}

/**
 * GoPlus podaje flagi jako łańcuchy `"0"` / `"1"`. Wszystko inne — brak pola,
 * pusty łańcuch, `null`, cokolwiek nieoczekiwanego — to `unknown`, nigdy
 * `not_detected`.
 */
function toFlag(value: unknown): SecurityFlag {
  const text = typeof value === 'number' ? String(value) : value
  if (text === '1') return 'detected'
  if (text === '0') return 'not_detected'
  return 'unknown'
}

/**
 * Odpowiedź GoPlus na jeden adres → wynik skanu. Czysta funkcja, bez sieci.
 *
 * Klucze w `result` GoPlus zwraca małymi literami, ale nie polegamy na tym.
 */
export function parseGoPlus(body: unknown, address: string, chainId: number): ContractSecurity {
  const root = body as { code?: unknown; message?: unknown; result?: unknown } | null
  if (!root || typeof root !== 'object') {
    return securityUnavailable(chainId, 'GoPlus returned something that is not JSON.')
  }

  // `code` 1 to sukces. Inne, np. 2022 „The main chain is not supported" —
  // GoPlus nie zna sieci, więc nie ma czego pokazać.
  if (root.code !== 1) {
    const message = typeof root.message === 'string' ? root.message : 'no message'
    return securityUnavailable(chainId, `GoPlus could not scan chain ${chainId}: ${message} (code ${String(root.code)}).`)
  }

  const result = root.result
  const wanted = address.toLowerCase()
  const entry =
    result && typeof result === 'object'
      ? Object.entries(result as Record<string, unknown>).find(([key]) => key.toLowerCase() === wanted)?.[1]
      : undefined

  // Adres, którego GoPlus nie zna, wraca jako `result: {}` z kodem 1.
  if (!entry || typeof entry !== 'object') {
    return securityUnavailable(chainId, `GoPlus has no record of this contract on chain ${chainId}.`)
  }

  const record = entry as Record<string, unknown>
  const checks: SecurityChecks = {
    honeypot: toFlag(record[GOPLUS_FIELDS.honeypot]),
    mintable: toFlag(record[GOPLUS_FIELDS.mintable]),
    blacklist: toFlag(record[GOPLUS_FIELDS.blacklist]),
    ownerCanChangeBalances: toFlag(record[GOPLUS_FIELDS.ownerCanChangeBalances]),
    transferPausable: toFlag(record[GOPLUS_FIELDS.transferPausable]),
  }

  const unknown = (Object.keys(checks) as (keyof SecurityChecks)[]).filter((k) => checks[k] === 'unknown')

  // Wszystkie pięć pustych: adres jest w bazie, ale nic o nim nie powiedziano.
  // Pięć `unknown` w obiekcie wyglądałyby jak skan, który coś sprawdził.
  if (unknown.length === Object.keys(checks).length) {
    return securityUnavailable(chainId, 'GoPlus knows this contract but returned none of the five checks.')
  }

  return {
    source: 'goplus',
    chainId,
    checks,
    note: unknown.length === 0 ? null : `GoPlus returned no data for: ${unknown.map((k) => CHECK_LABELS[k]).join(', ')}.`,
  }
}

/**
 * Skan jednego kontraktu.
 *
 * **Nigdy nie rzuca.** Timeout, 429, awaria sieci, zła odpowiedź — każde z nich
 * kończy się `checks: null` z notatką, a walka rozgrywa się normalnie. Brak
 * skanu nie jest ani wyrokiem, ani zaświadczeniem o czystości.
 *
 * `chainId` idzie do GoPlus bez tłumaczenia: dla sieci EVM id z Codexu jest tym
 * samym id, którego używa GoPlus (Robinhood Chain: 4663 po obu stronach). Sieci,
 * w których się różnią — Solana — GoPlus odrzuca kodem 2022, co też kończy się
 * `null` z notatką, a nie zgadywaniem.
 */
export async function fetchContractSecurity(address: string, chainId: number): Promise<ContractSecurity> {
  try {
    const url = `${GOPLUS_ENDPOINT}/${chainId}?contract_addresses=${encodeURIComponent(address)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      return securityUnavailable(chainId, `GoPlus did not answer: HTTP ${res.status}.`)
    }
    return parseGoPlus(await res.json(), address, chainId)
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return securityUnavailable(
      chainId,
      timedOut
        ? `GoPlus did not answer within ${TIMEOUT_MS / 1_000}s.`
        : `GoPlus unreachable: ${error instanceof Error ? error.message : String(error)}.`,
    )
  }
}

/* ------------------------------------------------------------------ */
/* Bramka                                                              */
/* ------------------------------------------------------------------ */

export interface HoneypotGate {
  /** Co powiedział skan; z tego wyszła bramka. */
  status: SecurityFlag
  passed: boolean
}

/**
 * Honeypot to jedyna z pięciu flag, która zatrzymuje zawodnika: nie przechodzi
 * badań i przegrywa walkowerem, bez rozgrywania rund.
 *
 * Przechodzi także `unknown`. To nie jest zaświadczenie o czystości, tylko
 * brak podstaw do wyroku: walkower za to, że GoPlus nie odpowiedział, byłby
 * wynikiem wziętym znikąd — tak samo jak zero holderów z braku danych
 * (CLAUDE.md § Bramka na holderach). Bramka pokazuje `status`, więc front
 * nie musi zgadywać, że „przeszedł" znaczy „sprawdzony".
 *
 * Pozostałe cztery flagi tu nie wchodzą. Są ostrzeżeniami w narożniku i nie
 * zmieniają wyniku walki.
 */
export function honeypotGate(security: ContractSecurity): HoneypotGate {
  const status = security.checks?.honeypot ?? 'unknown'
  return { status, passed: status !== 'detected' }
}
