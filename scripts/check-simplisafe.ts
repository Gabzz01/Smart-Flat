/**
 * Verifies the SimpliSafe credentials by printing what the account reports, and names every device
 * type SimpliSafe has not documented. Pass --watch to stay connected and print realtime events.
 */

import { cameraSerialOf, SimpliSafeClient, videoUrl } from "../src/simplisafe.ts";
import { DEFAULT_HOST, DEFAULT_PORT } from "../src/simplisafe-stream.ts";
import { ENTRY_TYPE } from "../src/simplisafe-sensors.ts";

const watch = process.argv.includes("--watch");
const streamHost = process.env.SIMPLISAFE_STREAM_HOST ?? DEFAULT_HOST;
const streamPort = process.env.SIMPLISAFE_STREAM_PORT ?? DEFAULT_PORT;
const client = new SimpliSafeClient();
const systems = await client.systems();

const source = client.isFixture ? " (from SIMPLISAFE_FIXTURE)" : "";
console.log(`${systems.length} system(s)${source}\n`);

/** Every unrecognised type id seen, with one raw payload each, printed at the end. */
const unknownTypes = new Map<number, unknown>();

for (const system of systems) {
  console.log(`system ${system.sid} (v${system.version})`);
  console.log(`  address:  ${system.address ?? "-"}`);
  console.log(`  state:    ${system.state}${system.alarmGoingOff ? "  ** ALARM GOING OFF **" : ""}`);
  console.log(`  health:   ${system.isOffline ? "offline" : "online"}, ${system.powerOutage ? "power outage" : "mains ok"}`);
  console.log(`  temp:     ${system.temperature === undefined ? "-" : `${system.temperature}F`}`);

  console.log(`  cameras:  ${system.cameras.length}`);
  for (const camera of system.cameras) {
    const shutters = [
      `off ${camera.shutterOpenWhenOff ? "open" : "closed"}`,
      `home ${camera.shutterOpenWhenHome ? "open" : "closed"}`,
      `away ${camera.shutterOpenWhenAway ? "open" : "closed"}`,
    ].join(", ");
    console.log(`    ${camera.name}`);
    console.log(`      uuid:     ${camera.uuid}`);
    console.log(`      model:    ${camera.model || "-"} -> ${camera.type}`);
    console.log(`      status:   ${camera.status}, subscription ${camera.subscriptionEnabled ? "on" : "off"}`);
    console.log(`      shutter:  ${shutters}`);
    // The upstream URL needs the bearer token, so it is not openable as-is. The bridge's own
    // stream server is what hands out a URL you can paste into VLC; see simplisafe-stream.ts.
    console.log(`      upstream: ${videoUrl(camera.uuid)} (needs the bearer token)`);
    console.log(`      via bridge: http://${streamHost}:${streamPort}/camera/${camera.uuid}`);
    if (camera.type === "unknown") {
      console.log(`      note:     model ${camera.model} is not in the model table; report it.`);
    }
  }

  const sensors = await client.sensors(system.sid);
  // A camera is filed twice: once above, once as a sensor under the tail of its uuid. Say so, so
  // the duplicate reads as one device rather than two.
  const camerasBySerial = new Map(system.cameras.map(camera => [cameraSerialOf(camera.uuid), camera.name]));
  console.log(`  sensors:  ${sensors.length}`);
  for (const sensor of sensors) {
    const flags = [
      // Entry sensors are the only ones whose live state REST carries; showing it here is what
      // tells you whether a door the bridge reports wrongly is the bridge's fault or SimpliSafe's.
      sensor.type.id === ENTRY_TYPE ? (sensor.triggered ? "OPEN" : "shut") : "",
      sensor.error ? "malfunction" : "",
      sensor.lowBattery ? "low battery" : "",
      sensor.offline ? "offline" : "",
    ].filter(Boolean);
    const camera = camerasBySerial.get(sensor.serial);
    console.log(
      `    ${sensor.serial}  type ${String(sensor.type.id).padStart(3)} (${sensor.type.name})` +
        `  ${sensor.name}${flags.length ? `  [${flags.join(", ")}]` : ""}` +
        `${camera ? `  = camera "${camera}"` : ""}`,
    );
    if (!sensor.type.known) unknownTypes.set(sensor.type.id, sensor.raw);
  }

  if (system.notifications.length) {
    console.log(`  messages: ${system.notifications.length}`);
    for (const notification of system.notifications) {
      console.log(`    ${notification.timestamp.toISOString().slice(0, 16)}  ${notification.text}`);
    }
  }
  console.log("");
}

if (unknownTypes.size) {
  // This is the point of the script: simplisafe-python dies on an id it does not know (21 today),
  // so print enough of the payload to work out what the device actually is.
  console.log(`${unknownTypes.size} undocumented device type(s) on this account:\n`);
  for (const [id, raw] of unknownTypes) {
    console.log(`  type ${id}:`);
    console.log(
      JSON.stringify(raw, null, 2)
        .split("\n")
        .map(line => `    ${line}`)
        .join("\n"),
    );
    console.log("");
  }
  console.log("Add the id to DEVICE_TYPE_NAMES in src/simplisafe.ts once you know what it is.\n");
} else {
  console.log("Every device type on this account is recognised.\n");
}

if (!watch) {
  client.close();
  console.log("Pass --watch to stay connected and print motion, doorbell and alarm events.");
  process.exit(0);
}

console.log("Watching for events. Trigger some motion; Ctrl-C to stop.\n");
client.onConnectionChange = connected => console.log(connected ? "[socket] connected" : "[socket] disconnected");
client.onEvent = event => {
  const who = event.changedBy ? ` by ${event.changedBy}` : "";
  console.log(`${event.timestamp.toISOString().slice(11, 19)}  ${event.type} (cid ${event.cid})${who}`);
  console.log(`  ${event.info}`);
  if (event.sensorName) console.log(`  sensor:   ${event.sensorName} (${event.sensorType?.name ?? "-"})`);
  if (event.mediaUrls?.imageUrl) console.log(`  snapshot: ${event.mediaUrls.imageUrl}`);
  if (event.mediaUrls?.clipUrl) console.log(`  clip:     ${event.mediaUrls.clipUrl}`);
};
process.on("SIGINT", () => {
  client.close();
  process.exit(0);
});
await client.connect();
