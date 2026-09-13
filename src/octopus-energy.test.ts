import { expect, test } from "bun:test";
import {
  activePower,
  costOf,
  cumulativeEnergy,
  endpointId,
  forecastFrom,
  gasToKwh,
  epochSeconds,
  periodicEnergy,
  priceAt,
  priceOf,
  STALE_AFTER_MS,
} from "./octopus-energy.ts";
import { activeAgreement, OctopusClient, productCodeOf } from "./octopus.ts";
import type { Rate, Reading } from "./octopus.ts";

const client = new OctopusClient({ OCTOPUS_FIXTURE: "fixtures/octopus.json" });
const points = await client.account();
const [electricity, gas] = points as [(typeof points)[number], (typeof points)[number]];

const reading = (start: string, end: string, value: number): Reading => ({
  start: new Date(start),
  end: new Date(end),
  value,
});
const rate = (from: string, to: string | null, pence: number): Rate => ({
  from: new Date(from),
  to: to === null ? null : new Date(to),
  pence,
});

test("export meter points and meterless supplies are skipped", () => {
  expect(points.map(point => point.id)).toEqual(["1000000000001", "9000000001"]);
  expect(electricity.fuel).toBe("electricity");
  expect(gas.fuel).toBe("gas");
});

test("timestamps are plain Unix seconds: matter.js shifts to Matter's epoch itself", () => {
  expect(epochSeconds(new Date("2000-01-01T00:00:00Z"))).toBe(946_684_800);
  expect(epochSeconds(new Date("2026-08-28T22:00:00Z"))).toBe(1_787_954_400);
});

test("product code drops the rate prefix and the region suffix, for both fuels", () => {
  expect(productCodeOf("E-1R-AGILE-24-10-01-A")).toBe("AGILE-24-10-01");
  expect(productCodeOf("G-1R-VAR-22-11-01-A")).toBe("VAR-22-11-01");
  // A tariff code that carries neither is left alone.
  expect(productCodeOf("SILVER-FLEX-22-11-25")).toBe("SILVER-FLEX-22-11-25");
});

test("the agreement covering the moment wins over the one that ended", () => {
  expect(activeAgreement(electricity, new Date("2026-08-28T00:00:00Z"))?.tariffCode).toBe(
    "E-1R-AGILE-24-10-01-A",
  );
  expect(activeAgreement(electricity, new Date("2024-01-01T00:00:00Z"))?.tariffCode).toBe(
    "E-1R-VAR-22-11-01-A",
  );
  // Before any agreement started, fall back to the most recent rather than reporting nothing.
  expect(activeAgreement(electricity, new Date("2020-01-01T00:00:00Z"))?.tariffCode).toBe(
    "E-1R-AGILE-24-10-01-A",
  );
});

test("gas volume converts to kWh, and a kWh meter passes through", () => {
  // 1 m3 x 1.02264 x 39.5 / 3.6
  expect(gasToKwh(1)).toBeCloseTo(11.2206, 4);
  expect(gasToKwh(1, 38.6)).toBeCloseTo(10.9650, 4);
  expect(gasToKwh(11.22, 39.5, false)).toBe(11.22);
});

test("cumulative energy sums the window and reports the window it covers", () => {
  const readings = [
    reading("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 0.324),
    reading("2026-08-28T22:30:00Z", "2026-08-28T23:00:00Z", 0.221),
  ];
  expect(cumulativeEnergy(readings)).toEqual({
    energy: 545_000, // 0.545 kWh in mWh
    startTimestamp: epochSeconds(new Date("2026-08-28T22:00:00Z")),
    endTimestamp: epochSeconds(new Date("2026-08-28T23:00:00Z")),
  });
  expect(cumulativeEnergy([])).toBeNull();
});

test("periodic energy is the newest half-hour, carrying its own start and end", () => {
  const readings = [
    reading("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 0.324),
    reading("2026-08-28T22:30:00Z", "2026-08-28T23:00:00Z", 0.221),
  ];
  expect(periodicEnergy(readings)).toEqual({
    energy: 221_000,
    startTimestamp: epochSeconds(new Date("2026-08-28T22:30:00Z")),
    endTimestamp: epochSeconds(new Date("2026-08-28T23:00:00Z")),
  });
});

test("active power is null unless the newest reading is genuinely recent", () => {
  const readings = [reading("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 0.324)];
  const fresh = new Date(Date.parse("2026-08-28T22:30:00Z") + STALE_AFTER_MS - 1);
  const stale = new Date(Date.parse("2026-08-28T22:30:00Z") + STALE_AFTER_MS + 1);
  // 0.324 kWh over half an hour is 648 W.
  expect(activePower(readings, fresh)).toBe(648_000);
  expect(activePower(readings, stale)).toBeNull();
  expect(activePower([], fresh)).toBeNull();
});

test("prices convert pence to the currency's minor units at the declared scale", () => {
  expect(priceOf(21.5)).toBe(21_500);
  expect(priceOf(-3.2)).toBe(-3_200);
});

test("the current price is the rate covering now, and the forecast is what comes after", () => {
  const rates = [
    rate("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 21.5),
    rate("2026-08-28T22:30:00Z", "2026-08-28T23:00:00Z", 18.9),
    rate("2026-08-28T23:00:00Z", "2026-08-28T23:30:00Z", 12.04),
  ];
  const now = new Date("2026-08-28T22:30:00Z"); // exactly on the boundary: the new rate wins
  expect(priceAt(rates, now)?.price).toBe(18_900);
  expect(forecastFrom(rates, now).map(entry => entry.price)).toEqual([12_040]);
  expect(priceAt(rates, new Date("2026-08-29T06:00:00Z"))).toBeNull();
});

test("an open-ended fixed rate still resolves", () => {
  const rates = [rate("2023-01-01T00:00:00Z", null, 6.12)];
  const price = priceAt(rates, new Date("2026-08-28T22:00:00Z"));
  expect(price?.price).toBe(6_120);
  expect(price?.periodEnd).toBeNull();
});

test("cost is usage at the rate in force plus one standing charge per day", () => {
  const readings = [
    reading("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 0.324),
    reading("2026-08-28T22:30:00Z", "2026-08-28T23:00:00Z", 0.221),
    reading("2026-08-29T00:00:00Z", "2026-08-29T00:30:00Z", 0.1),
  ];
  const rates = [
    rate("2026-08-28T22:00:00Z", "2026-08-28T22:30:00Z", 21.5),
    rate("2026-08-28T22:30:00Z", "2026-08-29T01:00:00Z", 10),
  ];
  const standing = [rate("2025-06-01T00:00:00Z", null, 54.85)];
  // 0.324x21.5 + 0.221x10 + 0.1x10 = 6.966 + 2.21 + 1 = 10.176p, over two days of standing charge.
  expect(costOf(readings, rates, standing)).toBeCloseTo(10.176 + 2 * 54.85, 3);
  expect(costOf([], rates, standing)).toBe(0);
});

test("endpoint ids are short, lowercase and distinct per fuel", () => {
  expect(endpointId(electricity)).toBe("octopus-e1000000000001");
  expect(endpointId(gas)).toBe("octopus-g9000000001");
});

test("the fixture client returns readings and rates for both fuels", async () => {
  const from = new Date("2026-08-28T00:00:00Z");
  const to = new Date("2026-08-29T00:00:00Z");
  const readings = await client.consumption(electricity, from, to);
  expect(readings).toHaveLength(3);
  expect(readings[0]?.value).toBe(0.324);

  const rates = await client.rates(electricity, "E-1R-AGILE-24-10-01-A", from, to);
  expect(rates.map(entry => entry.pence)).toEqual([21.5, 18.9, 12.04, 9.87]);
  expect((await client.standingCharges(gas, "G-1R-VAR-22-11-01-A"))[0]?.pence).toBe(31.66);
});
