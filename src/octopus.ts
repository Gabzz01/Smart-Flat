/**
 * Minimal Octopus Energy REST client.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password. The tariff endpoints
 * are public and need no key at all, so a missing key only costs consumption, not prices.
 *
 * Everything here is read-only: Octopus has no write API for meter data.
 */

const API = "https://api.octopus.energy/v1";
/** A request that hangs must not stall the poll loop, nor keep the process alive on shutdown. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Half-hourly readings: a day is 48 rows, so 100 per page covers two days. Cap the walk anyway. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type Fuel = "electricity" | "gas";

export interface Agreement {
  tariffCode: string;
  validFrom: string;
  validTo: string | null;
}

/** One supply point: an electricity MPAN or a gas MPRN, with the meter serial to read it by. */
export interface MeterPoint {
  fuel: Fuel;
  /** MPAN (electricity) or MPRN (gas). */
  id: string;
  serial: string;
  agreements: Agreement[];
}

/** kWh for electricity and SMETS1 gas; m³ for SMETS2 gas. The API does not say which. */
export interface Reading {
  start: Date;
  end: Date;
  value: number;
}

/** Unit rate or standing charge, in pence including VAT. `to` is null while it is still current. */
export interface Rate {
  from: Date;
  to: Date | null;
  pence: number;
}

interface RawAgreement {
  tariff_code?: string;
  valid_from?: string;
  valid_to?: string | null;
}

interface RawMeterPoint {
  mpan?: string;
  mprn?: string;
  is_export?: boolean;
  meters?: { serial_number?: string }[];
  agreements?: RawAgreement[];
}

interface RawAccount {
  properties?: {
    electricity_meter_points?: RawMeterPoint[];
    gas_meter_points?: RawMeterPoint[];
  }[];
}

interface Page<T> {
  results?: T[];
  next?: string | null;
}

/** Saved payloads, so the bridge and the tests can run with no key and no network. */
interface Fixture {
  account: RawAccount;
  /** Keyed by meter point id (MPAN/MPRN). */
  consumption?: Record<string, { consumption: number; interval_start: string; interval_end: string }[]>;
  /** Keyed by tariff code. */
  rates?: Record<string, { value_inc_vat: number; valid_from: string; valid_to: string | null }[]>;
  standingCharges?: Record<string, { value_inc_vat: number; valid_from: string; valid_to: string | null }[]>;
}

/**
 * The product code a tariff belongs to: the tariff code without its `E-1R-`/`G-1R-` rate prefix and
 * without the single-letter region suffix. `E-1R-AGILE-24-10-01-A` → `AGILE-24-10-01`.
 */
export function productCodeOf(tariffCode: string) {
  return tariffCode.replace(/^[EG]-\d+R-/, "").replace(/-[A-P]$/, "");
}

/** The agreement covering `when`, or the most recent one if the account is between agreements. */
export function activeAgreement(point: MeterPoint, when: Date = new Date()) {
  const time = when.getTime();
  const covering = point.agreements.find(
    ({ validFrom, validTo }) =>
      Date.parse(validFrom) <= time && (validTo === null || Date.parse(validTo) > time),
  );
  if (covering) return covering;
  return [...point.agreements].sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0];
}

export class OctopusClient {
  readonly #apiKey: string;
  readonly #accountNumber: string;
  /** Set when OCTOPUS_FIXTURE is configured: no network, no credentials. */
  readonly #fixturePath?: string;
  #fixture?: Fixture;
  readonly #aborter = new AbortController();

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#fixturePath = env.OCTOPUS_FIXTURE;
    this.#apiKey = env.OCTOPUS_API_KEY ?? "";
    this.#accountNumber = env.OCTOPUS_ACCOUNT_NUMBER ?? "";

    if (!this.#fixturePath) {
      const missing = (
        [
          ["OCTOPUS_API_KEY", this.#apiKey],
          ["OCTOPUS_ACCOUNT_NUMBER", this.#accountNumber],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length) {
        throw new Error(`Missing Octopus credentials: ${missing.join(", ")} (or set OCTOPUS_FIXTURE)`);
      }
    }
  }

  get isFixture() {
    return this.#fixturePath !== undefined;
  }

  /**
   * Abort any request in flight. Without this a poll waiting on Octopus keeps the process alive
   * after the Matter node has shut down, so SIGTERM appears to hang.
   */
  close() {
    this.#aborter.abort(new Error("Bridge shutting down"));
  }

  get #signal() {
    return AbortSignal.any([this.#aborter.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  }

  async #loadFixture() {
    this.#fixture ??= (await Bun.file(this.#fixturePath!).json()) as Fixture;
    return this.#fixture;
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      signal: this.#signal,
      // The tariff endpoints ignore this header; the account ones require it.
      headers: { authorization: `Basic ${btoa(`${this.#apiKey}:`)}` },
    });
    if (!response.ok) {
      throw new Error(`Octopus ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /** Walks `next` until the results run out, so a long window is not silently truncated. */
  async #paged<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const first = await this.#get<Page<T>>(path, { ...params, page_size: String(PAGE_SIZE) });
    const results = [...(first.results ?? [])];
    let next = first.next;
    for (let page = 1; next && page < MAX_PAGES; page++) {
      const response = await fetch(next, {
        signal: this.#signal,
        headers: { authorization: `Basic ${btoa(`${this.#apiKey}:`)}` },
      });
      if (!response.ok) break;
      const body = (await response.json()) as Page<T>;
      results.push(...(body.results ?? []));
      next = body.next;
    }
    return results;
  }

  /** Every import meter point on the account. Export MPANs are skipped: we only bridge imports. */
  async account(): Promise<MeterPoint[]> {
    const account = this.#fixturePath
      ? (await this.#loadFixture()).account
      : await this.#get<RawAccount>(`accounts/${this.#accountNumber}/`);

    const points: MeterPoint[] = [];
    for (const property of account.properties ?? []) {
      const sources = [
        ["electricity", property.electricity_meter_points ?? []],
        ["gas", property.gas_meter_points ?? []],
      ] as const;
      for (const [fuel, raw] of sources) {
        for (const point of raw) {
          const id = point.mpan ?? point.mprn;
          const serial = point.meters?.[0]?.serial_number;
          // A meter point with no meter fitted, or an export MPAN, has nothing to read.
          if (!id || !serial || point.is_export) continue;
          points.push({
            fuel,
            id,
            serial,
            agreements: (point.agreements ?? [])
              .filter(agreement => agreement.tariff_code)
              .map(agreement => ({
                tariffCode: agreement.tariff_code!,
                validFrom: agreement.valid_from ?? new Date(0).toISOString(),
                validTo: agreement.valid_to ?? null,
              })),
          });
        }
      }
    }
    return points;
  }

  /** Half-hourly readings, oldest first. Octopus publishes these with a lag of up to 24 hours. */
  async consumption(point: MeterPoint, from: Date, to: Date): Promise<Reading[]> {
    const raw = this.#fixturePath
      ? ((await this.#loadFixture()).consumption?.[point.id] ?? [])
      : await this.#paged<{ consumption: number; interval_start: string; interval_end: string }>(
          `${point.fuel}-meter-points/${point.id}/meters/${point.serial}/consumption/`,
          { period_from: from.toISOString(), period_to: to.toISOString(), order_by: "period" },
        );
    return raw
      .map(row => ({
        start: new Date(row.interval_start),
        end: new Date(row.interval_end),
        value: row.consumption,
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /** Unit rates in p/kWh, oldest first. Public endpoint: works even with a bad key. */
  async rates(point: MeterPoint, tariffCode: string, from: Date, to: Date): Promise<Rate[]> {
    return this.#tariffRates(point, tariffCode, "standard-unit-rates", {
      period_from: from.toISOString(),
      period_to: to.toISOString(),
    });
  }

  /** Standing charges in pence per day. */
  async standingCharges(point: MeterPoint, tariffCode: string): Promise<Rate[]> {
    return this.#tariffRates(point, tariffCode, "standing-charges", {}, "standingCharges");
  }

  async #tariffRates(
    point: MeterPoint,
    tariffCode: string,
    kind: "standard-unit-rates" | "standing-charges",
    params: Record<string, string>,
    fixtureKey: "rates" | "standingCharges" = "rates",
  ): Promise<Rate[]> {
    const raw = this.#fixturePath
      ? ((await this.#loadFixture())[fixtureKey]?.[tariffCode] ?? [])
      : await this.#paged<{ value_inc_vat: number; valid_from: string; valid_to: string | null }>(
          `products/${productCodeOf(tariffCode)}/${point.fuel}-tariffs/${tariffCode}/${kind}/`,
          params,
        );
    return raw
      .map(row => ({
        from: new Date(row.valid_from),
        to: row.valid_to === null ? null : new Date(row.valid_to),
        pence: row.value_inc_vat,
      }))
      .sort((a, b) => a.from.getTime() - b.from.getTime());
  }
}
