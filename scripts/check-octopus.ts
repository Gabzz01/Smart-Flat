/** Verifies the Octopus credentials in .env by printing what the account's meters report. */

import { activeAgreement, OctopusClient, productCodeOf } from "../src/octopus.ts";
import {
  costOf,
  DEFAULT_CALORIFIC_VALUE,
  gasToKwh,
  priceAt,
  STALE_AFTER_MS,
} from "../src/octopus-energy.ts";

const client = new OctopusClient();
const points = await client.account();
const now = new Date();
const from = new Date(now.getTime() - 3 * 86_400_000);
const calorific = Number(process.env.OCTOPUS_GAS_CALORIFIC_VALUE ?? DEFAULT_CALORIFIC_VALUE);

const source = client.isFixture ? " (from OCTOPUS_FIXTURE)" : "";
console.log(`${points.length} meter point(s)${source}\n`);

for (const point of points) {
  const agreement = activeAgreement(point, now);
  console.log(`${point.fuel} ${point.id}`);
  console.log(`  meter:    ${point.serial}`);
  const product = agreement ? productCodeOf(agreement.tariffCode) : "-";
  console.log(`  tariff:   ${agreement?.tariffCode ?? "-"} (product ${product})`);

  const readings = await client.consumption(point, from, now);
  const latest = readings.at(-1);
  if (!latest) {
    console.log("  readings: none in the last 3 days\n");
    continue;
  }
  const lagHours = (now.getTime() - latest.end.getTime()) / 3_600_000;
  console.log(`  readings: ${readings.length} since ${from.toISOString().slice(0, 16)}`);
  console.log(
    `  newest:   ${latest.end.toISOString().slice(0, 16)} (${lagHours.toFixed(1)}h ago, ${latest.value})`,
  );
  const fresh = lagHours * 3_600_000 < STALE_AFTER_MS;
  console.log(`  live:     ${fresh ? "fresh enough to report power" : "too stale, activePower stays null"}`);

  const total = readings.reduce((sum, reading) => sum + reading.value, 0);
  if (point.fuel === "gas") {
    // The API does not say whether this meter reports m3 or kWh. Print both so the reading can be
    // matched against the bill, then set OCTOPUS_GAS_UNITS accordingly.
    console.log(`  total:    ${total.toFixed(3)} raw units`);
    console.log(
      `            = ${gasToKwh(total, calorific).toFixed(2)} kWh if the meter reports m3 (CV ${calorific})`,
    );
    console.log(`            = ${total.toFixed(2)} kWh if the meter already reports kWh (SMETS1)`);
  } else {
    console.log(`  total:    ${total.toFixed(3)} kWh`);
  }

  if (!agreement) {
    console.log("");
    continue;
  }
  const ahead = new Date(now.getTime() + 2 * 86_400_000);
  const rates = await client.rates(point, agreement.tariffCode, from, ahead);
  const standing = await client.standingCharges(point, agreement.tariffCode);
  const current = priceAt(rates, now);
  const pence = current === null ? "-" : `${(Number(current.price) / 1000).toFixed(3)} p/kWh`;
  console.log(`  price:    ${pence} (${rates.length} rates published)`);
  console.log(`  standing: ${standing.find(rate => rate.to === null)?.pence.toFixed(2) ?? "-"} p/day`);

  const priced = rates.length ? readings.filter(reading => reading.start >= rates[0]!.from) : [];
  const inM3 = (process.env.OCTOPUS_GAS_UNITS ?? "m3").toLowerCase() !== "kwh";
  const inKwh =
    point.fuel === "gas"
      ? priced.map(reading => ({ ...reading, value: gasToKwh(reading.value, calorific, inM3) }))
      : priced;
  const cost = (costOf(inKwh, rates, standing) / 100).toFixed(2);
  console.log(`  cost:     ${cost} GBP over ${priced.length} priced readings\n`);
}
