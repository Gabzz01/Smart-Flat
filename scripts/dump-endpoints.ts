/** Prints the endpoint tree a controller sees, including each node's published parts list. */
import { Endpoint, Environment, ServerNode } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { BridgedFan } from "../src/dyson-fan.ts";
import { DysonClient } from "../src/dyson.ts";
import { BridgedThermostat } from "../src/nest-thermostat.ts";
import { BridgedMeter } from "../src/octopus-energy.ts";
import { OctopusClient } from "../src/octopus.ts";
import { SdmClient } from "../src/sdm.ts";
import { BridgedAlarm } from "../src/simplisafe-sensors.ts";
import { isConfigured, SimpliSafeClient } from "../src/simplisafe.ts";
import { Slots } from "../src/slots.ts";

const storagePath = process.env.MATTER_STORAGE_PATH ?? ".matter-storage";
Environment.default.vars.set("storage.path", storagePath);
const server = await ServerNode.create({ id: "matter-bridge", network: { port: 5596 } });
const agg = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await server.add(agg);
const client = new SdmClient();
const slots = await Slots.open(`${storagePath}/endpoint-slots.json`);
for (const device of await client.listThermostats()) {
  await BridgedThermostat.add(agg, device, client, await slots.slotFor(device.name));
}
if (process.env.DYSON_SERIAL || process.env.DYSON_FIXTURE) {
  const dyson = new DysonClient();
  await BridgedFan.add(agg, dyson, await slots.slotFor(`dyson:${dyson.serial}`), "Dyson Purifier");
}
if (process.env.OCTOPUS_API_KEY || process.env.OCTOPUS_FIXTURE) {
  const octopus = new OctopusClient();
  for (const point of await octopus.account()) {
    await BridgedMeter.add(agg, octopus, point, await slots.slotFor(`octopus:${point.id}`));
  }
  octopus.close();
}
if (isConfigured()) {
  const simplisafe = new SimpliSafeClient();
  const [system] = await simplisafe.systems();
  if (system) {
    await BridgedAlarm.add(agg, system, await simplisafe.sensors(system.sid), key => slots.slotFor(key));
  }
  simplisafe.close();
}
await server.start();

const walk = (ep: any, depth = 0) => {
  const d = ep.state.descriptor;
  const types = d.deviceTypeList.map((t: any) => `0x${t.deviceType.toString(16)}`).join(",");
  const label = ep.state.bridgedDeviceBasicInformation?.nodeLabel ?? "";
  console.log(`${"  ".repeat(depth)}#${ep.number} ${ep.id} types=[${types}] parts=[${d.partsList.join(",")}] ${label}`);
  for (const part of ep.parts) walk(part, depth + 1);
};
walk(agg);
await server.close();
