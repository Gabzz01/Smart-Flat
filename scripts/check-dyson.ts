/** Verifies the Dyson credentials in .env by connecting over MQTT and printing what the fan says. */

import { DysonClient, type DysonState } from "../src/dyson.ts";
import { airQualityState, fanState, filterState, humidityState, sensorsIdle, temperatureState } from "../src/dyson-fan.ts";

const TIMEOUT_MS = 15_000;

const client = new DysonClient();
let state: DysonState | undefined;
let environment: DysonState | undefined;

const done = Promise.withResolvers<void>();
const settle = () => {
  if (state && environment) done.resolve();
};

client.onState = value => {
  state = value;
  settle();
};
client.onEnvironment = value => {
  environment = value;
  settle();
};

console.log(`Connecting to ${client.isFixture ? "DYSON_FIXTURE" : `${client.host}:1883`} as ${client.serial}...`);
await client.connect();
await Promise.race([done.promise, Bun.sleep(TIMEOUT_MS)]);
client.close();

if (!state) {
  console.error(`No state received within ${TIMEOUT_MS / 1000}s. Check DYSON_HOST, DYSON_PASSWORD and the serial.`);
  process.exit(1);
}

const fan = fanState(state);
const hepa = filterState(state.hflr);
const carbon = filterState(state.cflr);
const temperature = temperatureState(environment ?? {}).measuredValue;
const humidity = humidityState(environment ?? {}).measuredValue;
const air = airQualityState(environment ?? {});

console.log(`\nDyson ${client.serial} (product type ${client.productType})`);
console.log(`  power:       ${state.fpwr ?? "-"} (fan ${state.fnst ?? "-"})`);
console.log(`  mode:        ${state.auto === "ON" ? "AUTO" : "MANUAL"} -> Matter fanMode ${fan.fanMode}`);
console.log(`  speed:       ${state.fnsp ?? "-"} -> ${fan.percentSetting ?? "auto"} %`);
console.log(`  oscillation: ${state.oson ?? "-"} (${state.osal ?? "?"}-${state.osau ?? "?"}°)`);
console.log(`  direction:   ${state.fdir === "OFF" ? "rear" : "front"}`);
console.log(`  night mode:  ${state.nmod ?? "-"}`);
console.log(`  HEPA:        ${hepa ? `${hepa.condition} %` : `not fitted (${state.hflr ?? "-"})`}`);
console.log(`  carbon:      ${carbon ? `${carbon.condition} %` : `not fitted (${state.cflr ?? "-"})`}`);

if (!environment) {
  console.log("\nNo sensor data received (the fan only answers when it is powered).");
  process.exit(0);
}
console.log(`  temperature: ${temperature === null ? "-" : (temperature / 100).toFixed(1)} °C`);
console.log(`  humidity:    ${humidity === null ? "-" : humidity / 100} %`);
console.log(`  PM2.5:       ${air.pm25ConcentrationMeasurement.measuredValue ?? "-"} µg/m³`);
console.log(`  PM10:        ${air.pm10ConcentrationMeasurement.measuredValue ?? "-"} µg/m³`);
console.log(`  air quality: ${air.airQuality.airQuality}`);
console.log(
  `  VOC / NO2:   level ${air.totalVolatileOrganicCompoundsConcentrationMeasurement.levelValue} / ` +
    `${air.nitrogenDioxideConcentrationMeasurement.levelValue}`,
);
if (sensorsIdle(environment)) {
  console.log(`\n  The sensor board is reporting 0 % humidity: readings are suppressed as meaningless.`);
  console.log(`  Raw: ${JSON.stringify(environment)}`);
}
