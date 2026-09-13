/**
 * Maps a SimpliSafe system's sensors and cameras onto Matter.
 *
 *   entry sensor  -> ContactSensor  (BooleanState: FALSE=open, TRUE=closed)
 *   motion sensor -> OccupancySensor
 *   camera        -> OccupancySensor
 *
 * A camera is an occupancy sensor because Matter's own CameraDevice (0x142) cannot carry video from
 * a bridge: it mandates CameraAvStreamManagement + WebRtcTransportProvider, so the bridge would have
 * to be a WebRTC peer negotiating SDP and sending RTP, and matter.js 0.17.9 ships those clusters as
 * empty stubs regardless. There is no URL attribute anywhere in the Matter camera model. What is
 * real is the OccupancySensing cluster the camera device type carries anyway, and SimpliSafe does
 * push camera motion. Video is served over plain HTTP instead — see simplisafe-stream.ts.
 *
 * The two state sources are unequal, and it matters:
 *   - Entry sensors carry `status.triggered` over REST, so polling is the source of truth.
 *   - Motion sensors send an empty `status` block. Their state exists only as websocket events, and
 *     their own `setting` says `off: 0, home: 0, away: 1` — SimpliSafe keeps them asleep unless the
 *     system is armed Away. A motion endpoint on a disarmed system will never fire. That is the
 *     hardware's behaviour, not a gap here.
 *
 * Occupancy has no "cleared" event either way, so it is held for MOTION_HOLD_MS and released on a
 * timer. Endpoints are added directly to the aggregator, never composed under a BridgedNode; see
 * the header of nest-thermostat.ts for why.
 */

import { Endpoint } from "@matter/main";
import { BooleanStateServer } from "@matter/main/behaviors/boolean-state";
import { OccupancySensingServer } from "@matter/main/behaviors/occupancy-sensing";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ContactSensorDevice, OccupancySensorDevice } from "@matter/main/devices";
import { OccupancySensing } from "@matter/main/clusters";
import { cameraSerialOf } from "./simplisafe.ts";
import type { Camera, Sensor, SimpliSafeEvent, System } from "./simplisafe.ts";
import { numbersForSlot } from "./slots.ts";

/**
 * How long occupancy stays set after a motion event. SimpliSafe reports the start of motion and
 * never its end, so this is a hold, not a measurement — tune it to taste. Too short and a
 * controller misses the change between polls; too long and a corridor reads as permanently busy.
 */
export const MOTION_HOLD_MS = Number(process.env.SIMPLISAFE_MOTION_HOLD_MS ?? 60_000);

/** The bounds the cluster publishes as holdTimeLimits, in seconds. */
export const HOLD_MIN_S = 1;
export const HOLD_MAX_S = 3600;

/**
 * The hold as the cluster wants it: whole seconds, inside the limits we publish for it.
 *
 * The clamp is not cosmetic. holdTime is validated against holdTimeLimits at initialization, so a
 * SIMPLISAFE_MOTION_HOLD_MS under 500 rounds to 0 and takes every motion endpoint down with a
 * constraint error. The hold itself stays in milliseconds and is not clamped -- only what is
 * published about it.
 */
export const holdSeconds = (holdMs: number) =>
  Math.min(HOLD_MAX_S, Math.max(HOLD_MIN_S, Math.round(holdMs / 1000)));

/** Entry sensors. */
export const ENTRY_TYPE = 5;
/** Motion sensors. The v2 hardware (20) reports the same way. */
export const MOTION_TYPES = [4, 20];
/** A camera as the base station files it — already bridged from the subscription payload. */
export const CAMERA_TYPE = 21;

/**
 * Matter's contact sensor is the inverse of SimpliSafe's: BooleanState TRUE means closed, while
 * `triggered` means opened. Getting this backwards makes every door read as open at rest.
 */
export const contactStateOf = (sensor: Sensor) => !sensor.triggered;

/** The entry sensors worth an endpoint. */
export const entrySensors = (sensors: Sensor[]) => sensors.filter(sensor => sensor.type.id === ENTRY_TYPE);

/**
 * The motion sensors worth an endpoint. Type 21 is excluded on purpose: it is a camera the
 * subscription payload already described, and bridging both would double the accessory.
 */
export const motionSensors = (sensors: Sensor[]) =>
  sensors.filter(sensor => MOTION_TYPES.includes(sensor.type.id));

/**
 * The serial a motion-bearing event belongs to, or undefined when the event is not about motion.
 * Camera motion arrives as its own event type; a motion sensor only ever speaks by setting the
 * alarm off, which is why the alarm events count as motion at the sensor that raised them.
 */
export function motionSerialOf(event: SimpliSafeEvent): string | undefined {
  const motionEvents = ["camera_motion_detected", "alarm_triggered", "entry_delay", "secret_alert_triggered"];
  return motionEvents.includes(event.type) ? event.sensorSerial : undefined;
}

// ---------------------------------------------------------------------------------------------

const OccupancyDevice = OccupancySensorDevice.with(
  // PIR is what both a SimpliSafe motion sensor and a camera's motion detection actually are.
  // OccupancyEvent makes the cluster emit OccupancyChanged; the server does it on its own once the
  // feature is on. Worth having because the hold is short: a controller polling the attribute can
  // miss a whole motion window between reads, while an event cannot be missed that way.
  OccupancySensingServer.with("PassiveInfrared", "OccupancyEvent"),
  BridgedDeviceBasicInformationServer,
);
type OccupancyEndpoint = Endpoint<typeof OccupancyDevice>;

const ContactDevice = ContactSensorDevice.with(BooleanStateServer, BridgedDeviceBasicInformationServer);
type ContactEndpoint = Endpoint<typeof ContactDevice>;

/** Bridged accessory identity. Matter requires uniqueId and serialNumber to differ. */
function bridgedInfo(serial: string, name: string, productName: string) {
  return {
    nodeLabel: name.slice(0, 32),
    productName,
    serialNumber: serial.slice(-30),
    // Both are capped at 32 characters, and a camera uuid is already 32 (36 hyphenated), so the
    // prefix has to be short. They must also differ from each other, hence the prefix at all.
    uniqueId: `ss-${serial.toLowerCase().slice(-28)}`,
    vendorName: "SimpliSafe",
    reachable: true,
  };
}

export const endpointId = (serial: string) =>
  `simplisafe-${serial.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-16)}`;

/** The slot key for a device. Stable across restarts, so controllers keep their pairing. */
export const slotKey = (serial: string) => `simplisafe:${serial}`;

// ---------------------------------------------------------------------------------------------

/** An entry sensor as a Matter contact sensor. Fed by the REST poll. */
export class BridgedContact {
  readonly serial: string;
  readonly #endpoint: ContactEndpoint;

  private constructor(serial: string, endpoint: ContactEndpoint) {
    this.serial = serial;
    this.#endpoint = endpoint;
  }

  static async add(aggregator: Endpoint, sensor: Sensor, slot: number) {
    const endpoint = (await aggregator.add(ContactDevice, {
      id: endpointId(sensor.serial),
      number: numbersForSlot(slot),
      booleanState: { stateValue: contactStateOf(sensor) },
      bridgedDeviceBasicInformation: bridgedInfo(sensor.serial, sensor.name, "Entry Sensor"),
    })) as ContactEndpoint;
    return new BridgedContact(sensor.serial, endpoint);
  }

  async apply(sensor: Sensor) {
    await this.#endpoint.set({ booleanState: { stateValue: contactStateOf(sensor) } });
    await this.setReachable(!sensor.offline);
  }

  async setReachable(reachable: boolean) {
    await this.#endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
  }
}

/**
 * A motion sensor or a camera as a Matter occupancy sensor. Fed by websocket events, which say
 * only that motion started — so `trigger()` sets occupancy and arms the release itself.
 */
export class BridgedMotion {
  readonly serial: string;
  readonly #endpoint: OccupancyEndpoint;
  readonly #holdMs: number;
  #release?: ReturnType<typeof setTimeout>;
  #closed = false;

  private constructor(serial: string, endpoint: OccupancyEndpoint, holdMs: number) {
    this.serial = serial;
    this.#endpoint = endpoint;
    this.#holdMs = holdMs;
  }

  static async add(
    aggregator: Endpoint,
    init: { serial: string; name: string; productName: string },
    slot: number,
    holdMs = MOTION_HOLD_MS,
  ) {
    const endpoint = (await aggregator.add(OccupancyDevice, {
      id: endpointId(init.serial),
      number: numbersForSlot(slot),
      occupancySensing: {
        occupancy: { occupied: false },
        occupancySensorType: OccupancySensing.OccupancySensorType.Pir,
        occupancySensorTypeBitmap: { pir: true },
        // Matter's own name for the hold, in seconds, so a controller can show what it is doing.
        holdTime: holdSeconds(holdMs),
        holdTimeLimits: { holdTimeMin: HOLD_MIN_S, holdTimeMax: HOLD_MAX_S, holdTimeDefault: holdSeconds(holdMs) },
      },
      bridgedDeviceBasicInformation: bridgedInfo(init.serial, init.name, init.productName),
    })) as OccupancyEndpoint;
    return new BridgedMotion(init.serial, endpoint, holdMs);
  }

  /** Motion started. Holds occupancy, and re-arms the release if motion repeats inside the window. */
  async trigger() {
    if (this.#closed) return;
    clearTimeout(this.#release);
    await this.#endpoint.set({ occupancySensing: { occupancy: { occupied: true } } });
    this.#release = setTimeout(() => {
      void this.#endpoint
        .set({ occupancySensing: { occupancy: { occupied: false } } })
        .catch(error => {
          if (!this.#closed) console.error(`SimpliSafe ${this.serial}: clearing occupancy failed:`, error);
        });
    }, this.#holdMs);
    // A pending release is not a reason to keep the process alive.
    this.#release.unref();
  }

  async setReachable(reachable: boolean) {
    await this.#endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#release);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Every endpoint for one system, and the routing between the two state sources. Cameras and motion
 * sensors share the occupancy map, keyed by serial, so an event lands on whichever raised it.
 */
export class BridgedAlarm {
  readonly #contacts = new Map<string, BridgedContact>();
  readonly #motion = new Map<string, BridgedMotion>();

  private constructor(readonly systemId: number) {}

  static async add(aggregator: Endpoint, system: System, sensors: Sensor[], slotFor: (key: string) => Promise<number>) {
    const alarm = new BridgedAlarm(system.sid);

    for (const sensor of entrySensors(sensors)) {
      const slot = await slotFor(slotKey(sensor.serial));
      alarm.#contacts.set(sensor.serial, await BridgedContact.add(aggregator, sensor, slot));
    }

    for (const sensor of motionSensors(sensors)) {
      const slot = await slotFor(slotKey(sensor.serial));
      alarm.#motion.set(
        sensor.serial,
        await BridgedMotion.add(aggregator, { ...sensor, productName: "Motion Sensor" }, slot),
      );
    }

    for (const camera of system.cameras) {
      const slot = await slotFor(slotKey(camera.uuid));
      // A camera usually shares its room's name with the motion sensor in that room, and two
      // accessories called "Hallway" is unreadable in a controller. Say which one it is.
      const motion = await BridgedMotion.add(
        aggregator,
        { serial: camera.uuid, name: `${camera.name} Camera`, productName: "Camera" },
        slot,
      );
      // Events name a camera by the tail of its uuid on some devices and in full on others, so
      // register both spellings rather than guessing which this camera uses.
      alarm.#motion.set(camera.uuid, motion);
      alarm.#motion.set(cameraSerialOf(camera.uuid), motion);
      // A camera SimpliSafe reports as offline cannot see anything; say so rather than show it idle.
      await motion.setReachable(camera.status !== "offline");
    }

    return alarm;
  }

  get counts() {
    return { contacts: this.#contacts.size, motion: new Set(this.#motion.values()).size };
  }

  /** One poll: entry sensors are the only devices whose state REST actually carries. */
  async apply(sensors: Sensor[]) {
    for (const sensor of entrySensors(sensors)) {
      await this.#contacts.get(sensor.serial)?.apply(sensor);
    }
  }

  /** One websocket event. Returns whether it moved anything, so the caller can log usefully. */
  async handle(event: SimpliSafeEvent) {
    const serial = motionSerialOf(event);
    const motion = serial ? this.#motion.get(serial) : undefined;
    if (!motion) return false;
    await motion.trigger();
    return true;
  }

  close() {
    for (const motion of new Set(this.#motion.values())) motion.close();
  }
}
