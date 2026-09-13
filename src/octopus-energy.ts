/**
 * Maps an Octopus Energy meter point onto Matter: an electrical meter and an energy tariff, each
 * added directly to the aggregator.
 *
 * What this bridges is *history*, not live power. Without an Octopus Home Mini the only readings
 * available are half-hourly kWh pulled over REST, published with a lag of up to 24 hours. So
 * `activePower` reports null unless the newest reading is genuinely recent: a day-old half-hour
 * average dressed as "right now" is worse than an empty field, because a controller has no way to
 * tell the difference.
 *
 * Gas rides on the same two device types. matter.js 0.17.9 has no gas meter device type, and
 * Matter's TariffUnit only admits kWh/kVAh, so gas volume is converted to kWh and bridged as
 * energy; the endpoint is labelled "Gas Meter" so a controller does not present it as electricity.
 *
 * They are deliberately NOT composed under a shared BridgedNode, for the same reason as the Nest
 * thermostats: Apple Home surfaces only one device type per composed node and picks it
 * unpredictably. See the header of nest-thermostat.ts.
 */

import { Endpoint } from "@matter/main";
import { CommodityPrice, ElectricalPowerMeasurement } from "@matter/main/clusters";
import { MeasurementType, TariffUnit } from "@matter/types/globals";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors/electrical-energy-measurement";
import { ElectricalPowerMeasurementServer } from "@matter/main/behaviors/electrical-power-measurement";
import { CommodityPriceServer } from "@matter/main/behaviors/commodity-price";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ElectricalEnergyTariffDevice, ElectricalMeterDevice } from "@matter/main/devices";
import { activeAgreement } from "./octopus.ts";
import type { Fuel, MeterPoint, OctopusClient, Rate, Reading } from "./octopus.ts";
import { numbersForSlot } from "./slots.ts";

/**
 * Matter's epoch-s counts from 2000-01-01, but matter.js does that shift itself inside TlvEpochS
 * and rejects a value already shifted. So publish plain Unix seconds and leave the epoch alone.
 */
export const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * How recent the newest reading must be for activePower to be reported at all. Octopus publishes
 * half-hourly readings up to a day late, so in practice this stays null without a Home Mini — which
 * is the honest answer, and the reason it is a constant rather than a fudge factor.
 */
export const STALE_AFTER_MS = 90 * 60 * 1000;

/** Gas volume correction factor, fixed by Ofgem. */
export const GAS_VOLUME_CORRECTION = 1.02264;
/** Default calorific value in MJ/m³. Varies by region and day; the real one is on the bill. */
export const DEFAULT_CALORIFIC_VALUE = 39.5;

/** GBP, per ISO 4217. Prices are published in this many decimal places of a pound. */
const GBP = 826;
const PRICE_DECIMALS = 5;

// ---------------------------------------------------------------------------------------------
// Endpoint types.
// ---------------------------------------------------------------------------------------------

// ImportedEnergy only: export MPANs are filtered out in OctopusClient.account().
const MeterEnergy = ElectricalEnergyMeasurementServer.with("ImportedEnergy", "CumulativeEnergy", "PeriodicEnergy");
const MeterPower = ElectricalPowerMeasurementServer.with("AlternatingCurrent");

// ElectricalMeter (0x514) is Matter 1.6's own answer for "meters energy for billing", which is
// exactly what this is. It is also brand new: if a controller shows the accessory but no figures,
// the known-rendering alternative is OnOffPlugInUnitDevice with descriptor.deviceTypeList also
// carrying ElectricalSensor (0x510) — an Eve Energy's shape, at the cost of a dead on/off switch.
const BridgedMeterDevice = ElectricalMeterDevice.with(
  MeterEnergy,
  MeterPower,
  BridgedDeviceBasicInformationServer,
);
type MeterEndpoint = Endpoint<typeof BridgedMeterDevice>;

// Forecasting carries the rest of the published rates, which on Agile is up to 48 half-hours.
const BridgedTariffDevice = ElectricalEnergyTariffDevice.with(
  CommodityPriceServer.with("Forecasting"),
  BridgedDeviceBasicInformationServer,
);
type TariffEndpoint = Endpoint<typeof BridgedTariffDevice>;

/**
 * Matter requires an accuracy declaration per measurement type. Octopus reports what the smart
 * meter recorded, so the value is measured rather than estimated, and the accuracy is the meter's:
 * 2.5 % is the worst case an MID class B meter is allowed.
 */
const accuracyFor = (measurementType: MeasurementType, max: number) => ({
  measurementType,
  measured: true,
  minMeasuredValue: 0,
  maxMeasuredValue: max,
  accuracyRanges: [{ rangeMin: 0, rangeMax: max, percentMax: 250 }],
});

/** 1 GWh in mWh, and 100 kW in mW: past anything a domestic supply will ever report. */
const MAX_ENERGY_MWH = 1_000_000_000_000;
const MAX_POWER_MW = 100_000_000;

// ---------------------------------------------------------------------------------------------
// Octopus → Matter.
// ---------------------------------------------------------------------------------------------

/**
 * Gas volume in m³ to energy in kWh. A meter that already reports kWh (SMETS1) passes through
 * untouched. The calorific value is a knob because it genuinely varies by region and by day.
 */
export function gasToKwh(value: number, calorific = DEFAULT_CALORIFIC_VALUE, unitsAreM3 = true) {
  return unitsAreM3 ? (value * GAS_VOLUME_CORRECTION * calorific) / 3.6 : value;
}

const KWH_TO_MWH = 1_000_000;

/** Running total over every reading held, with the window it actually covers. */
export function cumulativeEnergy(readings: Reading[]) {
  if (!readings.length) return null;
  const kwh = readings.reduce((total, reading) => total + reading.value, 0);
  return {
    energy: Math.round(kwh * KWH_TO_MWH),
    startTimestamp: epochSeconds(readings[0]!.start),
    endTimestamp: epochSeconds(readings.at(-1)!.end),
  };
}

/**
 * The newest half-hour on its own. It carries its real start and end, so a controller reading a
 * stale value can see how stale it is rather than having to assume it is current.
 */
export function periodicEnergy(readings: Reading[]) {
  const latest = readings.at(-1);
  if (!latest) return null;
  return {
    energy: Math.round(latest.value * KWH_TO_MWH),
    startTimestamp: epochSeconds(latest.start),
    endTimestamp: epochSeconds(latest.end),
  };
}

/**
 * Average power over the newest reading, in mW — but only while that reading is recent enough to
 * mean anything. Everything else reports null rather than inventing a present tense.
 */
export function activePower(readings: Reading[], now: Date = new Date()) {
  const latest = readings.at(-1);
  if (!latest) return null;
  if (now.getTime() - latest.end.getTime() > STALE_AFTER_MS) return null;
  const hours = (latest.end.getTime() - latest.start.getTime()) / 3_600_000;
  if (hours <= 0) return null;
  return Math.round((latest.value / hours) * KWH_TO_MWH);
}

/** Matter reports money in the currency's minor units scaled by decimalPoints; Octopus in pence. */
export const priceOf = (pence: number) => Math.round((pence / 100) * 10 ** PRICE_DECIMALS);

const priceStruct = (rate: Rate, description: string): CommodityPrice.CommodityPriceStruct => ({
  periodStart: epochSeconds(rate.from),
  periodEnd: rate.to === null ? null : epochSeconds(rate.to),
  price: priceOf(rate.pence),
  description,
});

/** The rate covering `when`. A fixed tariff has one open-ended rate, so this finds that too. */
export function priceAt(rates: Rate[], when: Date = new Date(), description = "") {
  const time = when.getTime();
  const rate = rates.find(({ from, to }) => from.getTime() <= time && (to === null || to.getTime() > time));
  return rate ? priceStruct(rate, description) : null;
}

/** Every rate that starts after `when`, oldest first: what Octopus has published for the future. */
export function forecastFrom(rates: Rate[], when: Date = new Date(), description = "") {
  const time = when.getTime();
  return rates.filter(rate => rate.from.getTime() > time).map(rate => priceStruct(rate, description));
}

/**
 * What the readings cost, in pence: each half-hour at the rate in force for it, plus one standing
 * charge per day covered. Matter has no attribute for money spent, so this exists for
 * `bun run check-octopus` and the poll log rather than for a controller.
 */
export function costOf(readings: Reading[], rates: Rate[], standingCharges: Rate[] = []) {
  const rateAt = (when: Date) => {
    const time = when.getTime();
    return rates.find(({ from, to }) => from.getTime() <= time && (to === null || to.getTime() > time));
  };
  const usage = readings.reduce(
    (total, reading) => total + reading.value * (rateAt(reading.start)?.pence ?? 0),
    0,
  );

  const days = new Set(readings.map(reading => reading.start.toISOString().slice(0, 10)));
  const standing = [...days].reduce((total, day) => {
    const time = Date.parse(`${day}T12:00:00Z`);
    const charge = standingCharges.find(
      ({ from, to }) => from.getTime() <= time && (to === null || to.getTime() > time),
    );
    return total + (charge?.pence ?? 0);
  }, 0);

  return usage + standing;
}

// ---------------------------------------------------------------------------------------------

const labelFor = (fuel: Fuel) => (fuel === "gas" ? "Gas Meter" : "Electricity Meter");

/** Bridged accessory identity. Matter requires uniqueId and serialNumber to differ. */
function bridgedInfo(point: MeterPoint, name: string, kind: string) {
  return {
    nodeLabel: name.slice(0, 32),
    productName: labelFor(point.fuel),
    serialNumber: `${kind}-${point.id.slice(-30)}`,
    uniqueId: `octopus-${kind}-${point.id.slice(-25)}`,
    vendorName: "Octopus Energy",
    reachable: true,
  };
}

export const endpointId = (point: MeterPoint) =>
  `octopus-${point.fuel.slice(0, 1)}${point.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-16)}`;

// ---------------------------------------------------------------------------------------------

/** How far back to pull readings. A month is enough for a meaningful cumulative total. */
const WINDOW_DAYS = 30;

/** A bridged Octopus meter point: its two endpoints plus the refresh that feeds them. */
export class BridgedMeter {
  readonly #client: OctopusClient;
  readonly #point: MeterPoint;
  readonly #name: string;
  readonly #meter: MeterEndpoint;
  readonly #tariff: TariffEndpoint;
  readonly #calorific: number;
  readonly #gasInM3: boolean;
  /** Last computed cost in pence, so the poll log can report it. */
  #cost = 0;

  private constructor(init: {
    client: OctopusClient;
    point: MeterPoint;
    name: string;
    meter: MeterEndpoint;
    tariff: TariffEndpoint;
    calorific: number;
    gasInM3: boolean;
  }) {
    this.#client = init.client;
    this.#point = init.point;
    this.#name = init.name;
    this.#meter = init.meter;
    this.#tariff = init.tariff;
    this.#calorific = init.calorific;
    this.#gasInM3 = init.gasInM3;
  }

  static async add(
    aggregator: Endpoint,
    client: OctopusClient,
    point: MeterPoint,
    slot: number,
    env: Record<string, string | undefined> = process.env,
  ) {
    const id = endpointId(point);
    // Undefined past the three-digit range: fall back to matter.js numbering, which orders the
    // parts list correctly again once every endpoint has four digits.
    const base = numbersForSlot(slot);
    const at = (offset: number) => (base === undefined ? undefined : base + offset);
    const name = labelFor(point.fuel);

    const meter = (await aggregator.add(BridgedMeterDevice, {
      id: `${id}-m`,
      number: at(0),
      electricalEnergyMeasurement: {
        accuracy: accuracyFor(MeasurementType.ElectricalEnergy, MAX_ENERGY_MWH),
        cumulativeEnergyImported: null,
        periodicEnergyImported: null,
      },
      electricalPowerMeasurement: {
        powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
        numberOfMeasurementTypes: 1,
        accuracy: [accuracyFor(MeasurementType.ActivePower, MAX_POWER_MW)],
        activePower: null,
      },
      bridgedDeviceBasicInformation: bridgedInfo(point, name, "m"),
    })) as MeterEndpoint;

    const tariff = (await aggregator.add(BridgedTariffDevice, {
      id: `${id}-p`,
      number: at(1),
      commodityPrice: {
        tariffUnit: TariffUnit.KWh,
        currency: { currency: GBP, decimalPoints: PRICE_DECIMALS },
        currentPrice: null,
        priceForecast: [],
      },
      bridgedDeviceBasicInformation: bridgedInfo(point, `${name} Tariff`, "p"),
    })) as TariffEndpoint;

    return new BridgedMeter({
      client,
      point,
      name,
      meter,
      tariff,
      calorific: Number(env.OCTOPUS_GAS_CALORIFIC_VALUE ?? DEFAULT_CALORIFIC_VALUE),
      gasInM3: (env.OCTOPUS_GAS_UNITS ?? "m3").toLowerCase() !== "kwh",
    });
  }

  get label() {
    return `${this.#name} ${this.#point.id}`;
  }

  get cost() {
    return this.#cost;
  }

  /** Readings converted to kWh, so gas and electricity share every helper downstream. */
  #inKwh(readings: Reading[]): Reading[] {
    if (this.#point.fuel !== "gas") return readings;
    return readings.map(reading => ({
      ...reading,
      value: gasToKwh(reading.value, this.#calorific, this.#gasInM3),
    }));
  }

  /** One poll: pull the window, publish energy, then publish the price for right now. */
  async refresh(now: Date = new Date()) {
    const from = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    const readings = this.#inKwh(await this.#client.consumption(this.#point, from, now));

    // Both are null exactly when the window came back empty, since both read the same array.
    const cumulative = cumulativeEnergy(readings);
    const periodic = periodicEnergy(readings);
    if (cumulative && periodic) {
      // setMeasurement rather than a plain attribute write: CumulativeEnergyMeasured and
      // PeriodicEnergyMeasured are mandatory with the CUME/PERE features this cluster declares, and
      // writing the attributes directly publishes the numbers while never emitting the events a
      // controller may be subscribed to instead. It skips any value left undefined, which is why
      // the empty case cannot go through it.
      await this.#meter.act(agent =>
        agent.electricalEnergyMeasurement.setMeasurement({
          cumulativeEnergy: { imported: cumulative },
          periodicEnergy: { imported: periodic },
        }),
      );
    } else {
      // Nothing to report is not the same as nothing changed: publish unknown over a stale total.
      await this.#meter.set({
        electricalEnergyMeasurement: { cumulativeEnergyImported: null, periodicEnergyImported: null },
      });
    }
    await this.#meter.set({
      electricalPowerMeasurement: { activePower: activePower(readings, now) },
    });

    const agreement = activeAgreement(this.#point, now);
    if (!agreement) return;
    // Rates are published a day ahead on Agile, so ask for a window that reaches into tomorrow.
    const rates = await this.#client.rates(
      this.#point,
      agreement.tariffCode,
      new Date(now.getTime() - 86_400_000),
      new Date(now.getTime() + 2 * 86_400_000),
    );
    await this.#tariff.set({
      commodityPrice: {
        currentPrice: priceAt(rates, now, agreement.tariffCode),
        priceForecast: forecastFrom(rates, now, agreement.tariffCode),
      },
    });

    const standingCharges = await this.#client.standingCharges(this.#point, agreement.tariffCode);
    // Rates were only fetched for the last day or so, while readings cover a month. Costing a
    // reading with no rate in hand would silently under-report, so cost only what is covered.
    const priced = rates.length ? readings.filter(reading => reading.start >= rates[0]!.from) : [];
    this.#cost = costOf(priced, rates, standingCharges);
  }

  async setReachable(reachable: boolean) {
    for (const endpoint of [this.#meter, this.#tariff]) {
      await endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
    }
  }
}
