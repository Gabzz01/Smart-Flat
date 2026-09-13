import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { BridgedFan } from "./src/dyson-fan.ts";
import { DysonClient } from "./src/dyson.ts";
import { BridgedMeter } from "./src/octopus-energy.ts";
import { OctopusClient } from "./src/octopus.ts";
import { BridgedThermostat, displayName } from "./src/nest-thermostat.ts";
import { SdmClient } from "./src/sdm.ts";
import { BridgedAlarm } from "./src/simplisafe-sensors.ts";
import { serveCameras } from "./src/simplisafe-stream.ts";
import { isConfigured, SimpliSafeClient } from "./src/simplisafe.ts";
import { Slots } from "./src/slots.ts";

const env = Environment.default;
// Node identity, fabric credentials and endpoint numbers live here: back it up, and give an
// absolute path when the working directory is not the project (systemd, docker).
// Delete the directory to reset commissioning.
const storagePath = process.env.MATTER_STORAGE_PATH ?? ".matter-storage";
env.vars.set("storage.path", storagePath);
// matter.js defaults to debug. Its shutdown path logs a harmless "Error on closing socket" at that
// level because Bun's node:dgram lacks an internal node uses; info keeps the noise out.
env.vars.set("log.level", process.env.MATTER_LOG_LEVEL ?? "info");

const server = await ServerNode.create({
  id: "matter-bridge",
  network: { port: Number(process.env.MATTER_PORT ?? 5540) },
  commissioning: {
    passcode: Number(process.env.MATTER_PASSCODE ?? 20202021),
    discriminator: Number(process.env.MATTER_DISCRIMINATOR ?? 3840),
  },
  productDescription: { name: "Matter Bridge", deviceType: AggregatorEndpoint.deviceType },
  basicInformation: {
    vendorName: "matter-bridge",
    vendorId: VendorId(0xfff1), // test vendor id
    productName: "Matter Bridge",
    productId: 0x8000,
    serialNumber: process.env.MATTER_SERIAL ?? "bridge-0001",
  },
});

const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await server.add(aggregator);

const client = new SdmClient();
const slots = await Slots.open(`${storagePath}/endpoint-slots.json`);
const bridged = new Map<string, BridgedThermostat>();

let stopping = false;

async function sync() {
  if (stopping) return;
  const devices = await client.listThermostats();
  const seen = new Set<string>();

  for (const device of devices) {
    // Endpoints are torn down during shutdown; writing to them then throws.
    if (stopping) return;
    seen.add(device.name);
    const existing = bridged.get(device.name);
    if (existing) {
      await existing.apply(device);
      continue;
    }
    const slot = await slots.slotFor(device.name);
    bridged.set(device.name, await BridgedThermostat.add(aggregator, device, client, slot));
    const { traits } = device;
    console.log(
      `Bridged thermostat: ${displayName(device)} ` +
        `(${traits["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius?.toFixed(1)}°C, ` +
        `${traits["sdm.devices.traits.ThermostatMode"]?.mode})`,
    );
  }

  // Devices Google stopped reporting stay as endpoints so controllers keep their pairing.
  for (const [name, thermostat] of bridged) {
    if (stopping) return;
    if (!seen.has(name)) await thermostat.setUnreachable();
  }
}

// matter.js shuts itself down on SIGTERM/SIGINT, but a poll of our own would still hold the
// process open afterwards: the timer keeps the loop alive, and so does a request waiting on
// Google. Stop both as soon as the signal arrives, before the node starts tearing endpoints down.
// Registered before the first sync, so a signal during startup is handled too.
let poll: ReturnType<typeof setInterval> | undefined;
// The Dyson fan is optional: without DYSON_SERIAL (or DYSON_FIXTURE) the bridge is Nest-only.
let dyson: DysonClient | undefined;
// So is the Octopus account, and it owns a second poll timer of its own.
let octopus: OctopusClient | undefined;
let energyPoll: ReturnType<typeof setInterval> | undefined;
// So is SimpliSafe, which owns a poll timer, the endpoints, and the camera stream server.
let simplisafe: SimpliSafeClient | undefined;
let alarm: BridgedAlarm | undefined;
let alarmPoll: ReturnType<typeof setInterval> | undefined;
let cameraServer: ReturnType<typeof serveCameras> | undefined;

function stop() {
  stopping = true;
  clearInterval(poll);
  clearInterval(energyPoll);
  clearInterval(alarmPoll);
  client.close();
  dyson?.close();
  octopus?.close();
  simplisafe?.close();
  alarm?.close();
  void cameraServer?.stop(true);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.lifecycle.offline.on(stop);

// A cloud outage must not take the bridge down: log and retry on the next tick. Failures caused by
// our own shutdown (an aborted request) are not worth reporting.
const reportSyncFailure = (error: unknown) => {
  if (!stopping) console.error("Device sync failed:", error);
};

const reportFanFailure = (error: unknown) => {
  if (!stopping) console.error("Fan update failed:", error);
};

await sync().catch(reportSyncFailure);
poll = setInterval(() => void sync().catch(reportSyncFailure), Number(process.env.POLL_INTERVAL_MS ?? 60_000));
// A pending poll is not a reason to keep the process alive.
poll.unref();

if (!stopping && (process.env.DYSON_SERIAL || process.env.DYSON_FIXTURE)) {
  dyson = new DysonClient();
  const name = process.env.DYSON_NAME ?? "Dyson Purifier";
  const fan = await BridgedFan.add(aggregator, dyson, await slots.slotFor(`dyson:${dyson.serial}`), name);
  dyson.onState = state => void fan.applyState(state).catch(reportFanFailure);
  dyson.onEnvironment = environment => void fan.applyEnvironment(environment).catch(reportFanFailure);
  dyson.onConnectionChange = connected => void fan.setReachable(connected).catch(reportFanFailure);
  console.log(`Bridged fan: ${name} (${dyson.isFixture ? "from DYSON_FIXTURE" : dyson.host})`);
  // A fan that is unplugged must not stop the bridge; mqtt reconnects on its own.
  await dyson.connect().catch(error => console.error("Dyson connect failed:", error));
}

if (!stopping && (process.env.OCTOPUS_API_KEY || process.env.OCTOPUS_FIXTURE)) {
  octopus = new OctopusClient();
  const meters: BridgedMeter[] = [];
  const reportEnergyFailure = (error: unknown) => {
    if (!stopping) console.error("Energy update failed:", error);
  };
  const refreshEnergy = async () => {
    for (const meter of meters) {
      if (stopping) return;
      await meter.refresh();
      console.log(`${meter.label}: ${(meter.cost / 100).toFixed(2)} GBP over the priced window`);
    }
  };

  try {
    for (const point of await octopus.account()) {
      const slot = await slots.slotFor(`octopus:${point.id}`);
      meters.push(await BridgedMeter.add(aggregator, octopus, point, slot));
      console.log(`Bridged meter: ${point.fuel} ${point.id}${octopus.isFixture ? " (from OCTOPUS_FIXTURE)" : ""}`);
    }
    await refreshEnergy();
  } catch (error) {
    // A supplier outage must not stop the bridge; the next tick tries again.
    reportEnergyFailure(error);
  }

  energyPoll = setInterval(
    () => void refreshEnergy().catch(reportEnergyFailure),
    Number(process.env.OCTOPUS_POLL_INTERVAL_MS ?? 1_800_000),
  );
  energyPoll.unref();
}

if (!stopping && isConfigured()) {
  simplisafe = new SimpliSafeClient();
  const reportAlarmFailure = (error: unknown) => {
    if (!stopping) console.error("SimpliSafe update failed:", error);
  };

  try {
    const [system] = await simplisafe.systems();
    if (!system) throw new Error("No active SimpliSafe system on this account");

    const sensors = await simplisafe.sensors(system.sid);
    alarm = await BridgedAlarm.add(aggregator, system, sensors, key => slots.slotFor(key));
    const { contacts, motion } = alarm.counts;
    console.log(
      `Bridged alarm: system ${system.sid} — ${contacts} contact, ${motion} motion` +
        `${simplisafe.isFixture ? " (from SIMPLISAFE_FIXTURE)" : ""}`,
    );

    // Motion sensors are asleep unless the system is armed Away, so an occupancy endpoint that
    // never fires on a disarmed system is the hardware, not a fault. Say so once, at startup.
    if (motion && system.state === "OFF") {
      console.log("  note: SimpliSafe keeps motion sensors asleep while disarmed; those endpoints stay idle.");
    }

    // Entry sensors are the only devices whose state REST carries. Nothing pushes a door: opening
    // one while the system is disarmed produces no websocket event at all (measured), so this poll
    // is the only thing that will ever move a contact sensor. Hence 10s rather than a minute — at
    // 60s a door opened and shut between ticks is invisible, which just looks broken.
    const refreshAlarm = async () => {
      if (stopping || !simplisafe || !alarm) return;
      await alarm.apply(await simplisafe.sensors(system.sid));
    };

    simplisafe.onEvent = event => {
      void alarm
        ?.handle(event)
        .then(moved => console.log(`SimpliSafe: ${event.type}${moved ? "" : " (no endpoint)"} — ${event.info}`))
        .catch(reportAlarmFailure);
      // Any event can also mean a door moved, and the socket does not carry contact state.
      void refreshAlarm().catch(reportAlarmFailure);
    };
    simplisafe.onConnectionChange = connected => console.log(`SimpliSafe socket ${connected ? "up" : "down"}`);

    if (!system.cameras.length) {
      console.log("  no cameras on this system, so no stream server.");
    } else {
      cameraServer = serveCameras(simplisafe, () => system.cameras);
      console.log(`  camera streams: http://${cameraServer.hostname}:${cameraServer.port}/`);
    }

    alarmPoll = setInterval(
      () => void refreshAlarm().catch(reportAlarmFailure),
      Number(process.env.SIMPLISAFE_POLL_INTERVAL_MS ?? 10_000),
    );
    // A pending poll is not a reason to keep the process alive.
    alarmPoll.unref();

    // A cloud outage must not stop the bridge; the socket reconnects on its own.
    await simplisafe.connect().catch(error => console.error("SimpliSafe connect failed:", error));
  } catch (error) {
    reportAlarmFailure(error);
  }
}

function printPairingCodes() {
  const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
  console.log(`QR: https://project-chip.github.io/connectedhomeip/qrcode.html?data=${qrPairingCode}`);
  console.log(`Manual pairing code: ${manualPairingCode}`);
}

server.lifecycle.online.on(() => {
  if (server.lifecycle.isCommissioned) {
    console.log("Bridge commissioned. Waiting for controllers...");
    return;
  }
  printPairingCodes();
});

// Removing the bridge from a controller drops the last fabric: the node starts advertising for
// commissioning again, so print the codes without waiting for a restart.
server.lifecycle.decommissioned.on(() => {
  console.log("Bridge removed from its last controller, ready to pair again.");
  printPairingCodes();
});

await server.run();
