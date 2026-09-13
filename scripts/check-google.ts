/** Verifies the Google credentials in .env by listing the thermostats the API returns. */

import { SdmClient } from "../src/sdm.ts";
import { currentMode, displayName, thermostatCapabilities } from "../src/nest-thermostat.ts";

const client = new SdmClient();
const devices = await client.listThermostats();

console.log(`${devices.length} thermostat(s)${client.isFixture ? " (from SDM_FIXTURE)" : ""}\n`);

for (const device of devices) {
  const { traits } = device;
  console.log(displayName(device));
  console.log(`  id:       ${device.name.split("/").pop()}`);
  console.log(`  room:     ${device.parentRelations?.[0]?.displayName ?? "-"}`);
  console.log(`  online:   ${traits["sdm.devices.traits.Connectivity"]?.status ?? "?"}`);
  console.log(`  temp:     ${traits["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius?.toFixed(2) ?? "-"} °C`);
  console.log(`  humidity: ${traits["sdm.devices.traits.Humidity"]?.ambientHumidityPercent ?? "-"} %`);
  console.log(`  mode:     ${currentMode(device)} (available: ${thermostatCapabilities(device).features.join(", ") || "none"})`);
  console.log(`  setpoint: ${JSON.stringify(traits["sdm.devices.traits.ThermostatTemperatureSetpoint"] ?? {})}`);
  console.log(`  eco:      ${traits["sdm.devices.traits.ThermostatEco"]?.mode ?? "-"}`);
  console.log(`  hvac:     ${traits["sdm.devices.traits.ThermostatHvac"]?.status ?? "-"}\n`);
}
