/**
 * Maps a Dyson purifying fan (local MQTT) onto Matter: an air purifier and an air quality sensor,
 * each added directly to the aggregator. Night mode rides on the purifier's FanControl as the
 * spec's sleepWind bit rather than a switch of its own, since a controller draws one card per
 * bridged endpoint.
 *
 * The fan measures only while it runs, so its temperature and humidity are not bridged as sensor
 * endpoints: a controller cannot tell "the fan is off" from "it is 22 degrees in here", and a
 * thermometer that reports whenever it feels like it drags every whole-home climate summary with
 * it. They stay readable through `bun run check-dyson`.
 *
 * They are deliberately NOT composed under a shared BridgedNode, for the same reason as the Nest
 * thermostats: Apple Home surfaces only one device type per composed node and picks it
 * unpredictably. See the header of nest-thermostat.ts.
 */

import { Endpoint } from "@matter/main";
import { AirQuality, ConcentrationMeasurement, FanControl, ResourceMonitoring } from "@matter/main/clusters";
import { FanControlServer } from "@matter/main/behaviors/fan-control";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { HepaFilterMonitoringServer } from "@matter/main/behaviors/hepa-filter-monitoring";
import { ActivatedCarbonFilterMonitoringServer } from "@matter/main/behaviors/activated-carbon-filter-monitoring";
import { Pm25ConcentrationMeasurementServer } from "@matter/main/behaviors/pm25-concentration-measurement";
import { Pm10ConcentrationMeasurementServer } from "@matter/main/behaviors/pm10-concentration-measurement";
import { TotalVolatileOrganicCompoundsConcentrationMeasurementServer } from "@matter/main/behaviors/total-volatile-organic-compounds-concentration-measurement";
import { NitrogenDioxideConcentrationMeasurementServer } from "@matter/main/behaviors/nitrogen-dioxide-concentration-measurement";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { AirPurifierDevice, AirQualitySensorDevice } from "@matter/main/devices";
import type { DysonClient, DysonState } from "./dyson.ts";
import { numbersForSlot } from "./slots.ts";

const { FanMode, FanModeSequence, AirflowDirection } = FanControl;
const { ChangeIndication, DegradationDirection } = ResourceMonitoring;
const { MeasurementUnit, MeasurementMedium, LevelValue } = ConcentrationMeasurement;

/** The fan's own scale: fnsp runs 0001..0010. */
export const SPEED_MAX = 10;

// ---------------------------------------------------------------------------------------------
// Endpoint types. Filter clusters depend on what the fan reports, so endpoints are typed against
// the fully equipped purifier and the actual (narrower) endpoint is cast to it.
// ---------------------------------------------------------------------------------------------

// Wind carries the sleepWind bit, which the spec defines as exactly what Dyson calls night mode.
const PurifierFanControl = FanControlServer.with("MultiSpeed", "Auto", "Rocking", "AirflowDirection", "Wind");
const HepaMonitoring = HepaFilterMonitoringServer.with("Condition", "Warning");
const CarbonMonitoring = ActivatedCarbonFilterMonitoringServer.with("Condition", "Warning");

const FullPurifierDevice = AirPurifierDevice.with(
  PurifierFanControl,
  OnOffServer,
  HepaMonitoring,
  CarbonMonitoring,
  BridgedDeviceBasicInformationServer,
);
type PurifierEndpoint = Endpoint<typeof FullPurifierDevice>;

const HepaOnlyPurifierDevice = AirPurifierDevice.with(
  PurifierFanControl,
  OnOffServer,
  HepaMonitoring,
  BridgedDeviceBasicInformationServer,
);

const BridgedAirQualityDevice = AirQualitySensorDevice.with(
  Pm25ConcentrationMeasurementServer.with("NumericMeasurement"),
  Pm10ConcentrationMeasurementServer.with("NumericMeasurement"),
  // Medium and Critical are gated behind their own features; without them the cluster only
  // accepts Unknown/Low/High and rejects the rest at validation time.
  TotalVolatileOrganicCompoundsConcentrationMeasurementServer.with("LevelIndication", "MediumLevel", "CriticalLevel"),
  NitrogenDioxideConcentrationMeasurementServer.with("LevelIndication", "MediumLevel", "CriticalLevel"),
  BridgedDeviceBasicInformationServer,
);
type AirQualityEndpoint = Endpoint<typeof BridgedAirQualityDevice>;

// ---------------------------------------------------------------------------------------------
// Mapping helpers (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

/** Dyson encodes "no reading" as INIT/OFF/INV/FAIL/NONE rather than by omitting the field. */
export function numeric(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}

export const isOn = (state: DysonState) => state.fpwr === "ON";
export const isAuto = (state: DysonState) => state.auto === "ON";
/** Undefined while the fan picks the speed itself (fnsp "AUTO"). */
export const speedOf = (state: DysonState) => numeric(state.fnsp);

/** Fan speed 1..10 to the coarse mode a legacy controller understands. */
export function fanModeOf(state: DysonState): FanControl.FanMode {
  if (!isOn(state)) return FanMode.Off;
  if (isAuto(state)) return FanMode.Auto;
  const speed = speedOf(state) ?? SPEED_MAX;
  return speed <= 3 ? FanMode.Low : speed <= 7 ? FanMode.Medium : FanMode.High;
}

/** FanControl attributes for the current product state. */
export function fanState(state: DysonState) {
  const on = isOn(state);
  const speed = speedOf(state);
  // fnst says whether air is actually moving: in Auto with clean air the fan idles while powered.
  const running = on && state.fnst !== "OFF";
  const current = running ? (speed ?? SPEED_MAX) : 0;
  return {
    fanMode: fanModeOf(state),
    // null is the spec's "the fan decides", which is exactly what Auto means here.
    percentSetting: !on ? 0 : speed === undefined ? null : speed * 10,
    percentCurrent: current * 10,
    speedSetting: !on ? 0 : speed === undefined ? null : speed,
    speedCurrent: current,
    rockSetting: { rockLeftRight: state.oson === "ON", rockUpDown: false, rockRound: false },
    windSetting: { sleepWind: state.nmod === "ON", naturalWind: false },
    airflowDirection: state.fdir === "OFF" ? AirflowDirection.Reverse : AirflowDirection.Forward,
  };
}

/** Filter life as a resource-monitoring cluster, or undefined when no such filter is fitted. */
export function filterState(life: string | undefined) {
  const condition = numeric(life);
  if (condition === undefined) return undefined;
  return {
    condition,
    changeIndication:
      condition === 0 ? ChangeIndication.Critical : condition <= 10 ? ChangeIndication.Warning : ChangeIndication.Ok,
    degradationDirection: DegradationDirection.Down,
  };
}

/**
 * Whether the sensor board is producing readings at all.
 *
 * An idle or faulted board does not use the OFF/INIT sentinels it uses elsewhere: it reports plain
 * zeros for humidity and particulates while temperature sticks at some constant. Indoor air is
 * never 0 % relative humidity, so that zero is the reliable tell, and when it shows every reading
 * from the same board is meaningless — publishing them would put a fabricated temperature in front
 * of the user.
 */
export const sensorsIdle = (environment: DysonState) => numeric(environment.hact) === 0;

/** tact is tenths of a Kelvin; Matter wants hundredths of a degree Celsius. */
export function temperatureState(environment: DysonState) {
  const tact = numeric(environment.tact);
  if (tact === undefined || sensorsIdle(environment)) return { measuredValue: null };
  return { measuredValue: Math.round((tact / 10 - 273.15) * 100) };
}

export function humidityState(environment: DysonState) {
  const hact = numeric(environment.hact);
  if (hact === undefined || hact === 0) return { measuredValue: null };
  return { measuredValue: hact * 100 };
}

/** US EPA PM2.5 breakpoints, in µg/m³. */
export function airQualityOf(pm25: number | undefined): AirQuality.AirQualityEnum {
  if (pm25 === undefined) return AirQuality.AirQualityEnum.Unknown;
  if (pm25 <= 12) return AirQuality.AirQualityEnum.Good;
  if (pm25 <= 35) return AirQuality.AirQualityEnum.Fair;
  if (pm25 <= 55) return AirQuality.AirQualityEnum.Moderate;
  if (pm25 <= 150) return AirQuality.AirQualityEnum.Poor;
  if (pm25 <= 250) return AirQuality.AirQualityEnum.VeryPoor;
  return AirQuality.AirQualityEnum.ExtremelyPoor;
}

/** VOC and NO2 are reported as a 0-9 index, not a concentration, so they map to a level. */
export function levelOf(index: number | undefined): ConcentrationMeasurement.LevelValue {
  if (index === undefined) return LevelValue.Unknown;
  if (index < 4) return LevelValue.Low;
  if (index < 7) return LevelValue.Medium;
  if (index < 9) return LevelValue.High;
  return LevelValue.Critical;
}

const particles = (value: number | undefined) => ({
  measuredValue: value ?? null,
  minMeasuredValue: 0,
  maxMeasuredValue: 999,
  measurementUnit: MeasurementUnit.Ugm3,
  measurementMedium: MeasurementMedium.Air,
});

const level = (index: number | undefined) => ({
  levelValue: levelOf(index),
  measurementMedium: MeasurementMedium.Air,
});

/** Every air-quality cluster's attributes for one sensor reading. */
export function airQualityState(environment: DysonState) {
  const idle = sensorsIdle(environment);
  const pm25 = idle ? undefined : numeric(environment.pm25);
  return {
    airQuality: { airQuality: airQualityOf(pm25) },
    pm25ConcentrationMeasurement: particles(pm25),
    pm10ConcentrationMeasurement: particles(idle ? undefined : numeric(environment.pm10)),
    totalVolatileOrganicCompoundsConcentrationMeasurement: level(idle ? undefined : numeric(environment.va10)),
    nitrogenDioxideConcentrationMeasurement: level(idle ? undefined : numeric(environment.noxl)),
  };
}

/** What a controller asked for, read back off the Matter clusters. */
export interface DesiredFan {
  on: boolean;
  auto: boolean;
  /** Absent while the fan chooses the speed. */
  speed?: number;
  oscillate: boolean;
  forward: boolean;
  /** nmod, published as FanControl's sleepWind. */
  night: boolean;
}

const onOff = (value: boolean) => (value ? "ON" : "OFF");

/** The product-state patch that turns the fan's current state into the desired one. */
export function commandsFor(desired: DesiredFan, current: DysonState): DysonState {
  const patch: DysonState = {};
  const set = (key: string, value: string) => {
    if (current[key] !== value) patch[key] = value;
  };

  set("fpwr", onOff(desired.on));
  set("nmod", onOff(desired.night));
  set("oson", onOff(desired.oscillate));
  set("fdir", onOff(desired.forward));

  if (!desired.on) return patch;

  set("auto", onOff(desired.auto));
  // A speed only sticks with auto off, and the fan reports "AUTO" rather than a number while on.
  if (!desired.auto && desired.speed !== undefined) {
    set("fnsp", String(Math.min(Math.max(Math.round(desired.speed), 1), SPEED_MAX)).padStart(4, "0"));
  }
  return patch;
}

/** What the fan itself currently wants, in the same shape a controller's writes are read into. */
export function desiredOf(state: DysonState): DesiredFan {
  return {
    on: isOn(state),
    auto: isAuto(state),
    speed: speedOf(state),
    oscillate: state.oson === "ON",
    forward: state.fdir !== "OFF",
    night: state.nmod === "ON",
  };
}

/**
 * Which power the controller meant.
 *
 * A controller writes ONE of fanMode, onOff or percent/speed, and matter.js syncs none of them, so
 * the other two keep the value we last mirrored from the fan. Whichever source now disagrees with
 * the fan is the instruction; if none does, nothing about the power changed.
 */
export function powerIntent(sources: { mode: boolean; onOff: boolean; speed: boolean }, applied: boolean) {
  return [sources.mode, sources.onOff, sources.speed].find(value => value !== applied) ?? applied;
}

/** Matter derives percent from speed by rounding up, so invert it the same way. */
export const speedFromPercent = (percent: number) =>
  percent <= 0 ? 0 : Math.min(SPEED_MAX, Math.ceil((percent * SPEED_MAX) / 100));

/** Which speed the controller meant, by the same rule as {@link powerIntent}. */
export function speedIntent(sources: { speed?: number; percent?: number }, applied: number | undefined) {
  return [sources.speed, sources.percent].find(value => value !== undefined && value !== applied) ?? applied;
}

/** Bridged accessory identity. Matter requires uniqueId and serialNumber to differ. */
function bridgedInfo(serial: string, name: string, kind: string) {
  return {
    nodeLabel: name.slice(0, 32),
    // No productLabel: Matter rejects one that repeats the vendor name, and "Dyson" usually does.
    productName: "Purifier",
    serialNumber: `${kind}-${serial.slice(-30)}`,
    uniqueId: `dyson-${kind}-${serial.slice(-25)}`,
    vendorName: "Dyson",
    reachable: false,
  };
}

export const endpointId = (serial: string) => `dyson-${serial.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

// ---------------------------------------------------------------------------------------------

/** A bridged Dyson fan: its endpoints plus the state sync in both directions. */
export class BridgedFan {
  readonly #client: DysonClient;
  readonly #name: string;
  readonly #purifier: PurifierEndpoint;
  readonly #airQuality: AirQualityEndpoint;
  readonly #hasCarbonFilter: boolean;
  #state: DysonState;
  /** Set while a controller-initiated write is pending or in flight; updates skip the fan state. */
  #writeTimer?: ReturnType<typeof setTimeout>;
  #writing = false;

  private constructor(init: {
    client: DysonClient;
    name: string;
    purifier: PurifierEndpoint;
    airQuality: AirQualityEndpoint;
    hasCarbonFilter: boolean;
    state: DysonState;
  }) {
    this.#client = init.client;
    this.#name = init.name;
    this.#purifier = init.purifier;
    this.#airQuality = init.airQuality;
    this.#hasCarbonFilter = init.hasCarbonFilter;
    this.#state = init.state;
  }

  /**
   * Endpoints are created before the fan answers, so they start from an empty state and become
   * reachable once MQTT connects. A fan that is unplugged must not block the bridge.
   */
  static async add(aggregator: Endpoint, client: DysonClient, slot: number, name: string, state: DysonState = {}) {
    const { serial } = client;
    const id = endpointId(serial);
    // Undefined past the three-digit range: fall back to matter.js numbering, which orders the
    // parts list correctly again once every endpoint has four digits.
    const base = numbersForSlot(slot);
    const at = (offset: number) => (base === undefined ? undefined : base + offset);
    const hepa = filterState(state.hflr);
    const carbon = filterState(state.cflr);

    const purifier = (await aggregator.add(carbon ? FullPurifierDevice : HepaOnlyPurifierDevice, {
      id: `${id}-f`,
      number: at(0),
      fanControl: {
        ...fanState(state),
        fanModeSequence: FanModeSequence.OffLowMedHighAuto,
        speedMax: SPEED_MAX,
        rockSupport: { rockLeftRight: true, rockUpDown: false, rockRound: false },
        windSupport: { sleepWind: true, naturalWind: false },
      },
      onOff: { onOff: isOn(state) },
      hepaFilterMonitoring: hepa ?? {
        condition: 100,
        changeIndication: ChangeIndication.Ok,
        degradationDirection: DegradationDirection.Down,
      },
      ...(carbon ? { activatedCarbonFilterMonitoring: carbon } : {}),
      bridgedDeviceBasicInformation: bridgedInfo(serial, name, "f"),
    })) as PurifierEndpoint;

    const airQuality = (await aggregator.add(BridgedAirQualityDevice, {
      id: `${id}-a`,
      number: at(1),
      ...airQualityState({}),
      bridgedDeviceBasicInformation: bridgedInfo(serial, `${name} Air Quality`, "a"),
    })) as AirQualityEndpoint;

    const fan = new BridgedFan({
      client,
      name,
      purifier,
      airQuality,
      hasCarbonFilter: carbon !== undefined,
      state,
    });
    fan.#watchControllerWrites();
    return fan;
  }

  /** Matter → Dyson. Controller writes are coalesced, our own updates (offline) are ignored. */
  #watchControllerWrites() {
    const watch = (events: unknown, names: string[]) => {
      const map = events as Record<
        string,
        { on(handler: (value: unknown, oldValue: unknown, context: { offline?: boolean }) => void): void }
      >;
      for (const name of names) {
        map[name]?.on((value, _old, context) => {
          if (context?.offline) return; // our own update writing state back
          // Which attribute a controller writes is not predictable (matter.js syncs none of them),
          // so name it: it is the only way to tell "wrote nothing" from "wrote something we ignored".
          console.log(`${this.#name}: controller set ${name.replace("$Changed", "")}=${JSON.stringify(value)}`);
          this.#scheduleWrite();
        });
      }
    };
    // DYSON_DEBUG=1 traces every attribute the cluster reports, ours included, to tell "the
    // controller never wrote" apart from "it wrote something we do not act on".
    if (process.env.DYSON_DEBUG) {
      const events = this.#purifier.events.fanControl as unknown as Record<string, unknown>;
      for (const attribute of Object.keys(fanState({}))) {
        const event = events[`${attribute}$Changed`] as
          | { on(handler: (value: unknown, old: unknown, context: { offline?: boolean }) => void): void }
          | undefined;
        event?.on((value, old, context) =>
          console.log(
            `${this.#name}: [debug] ${attribute} ${JSON.stringify(old)} -> ${JSON.stringify(value)}` +
              `${context?.offline ? " (ours)" : " (controller)"}`,
          ),
        );
      }
    }

    watch(this.#purifier.events.fanControl, [
      "fanMode$Changed",
      "percentSetting$Changed",
      "speedSetting$Changed",
      "rockSetting$Changed",
      "airflowDirection$Changed",
      "windSetting$Changed",
    ]);
    watch(this.#purifier.events.onOff, ["onOff$Changed"]);
  }

  #scheduleWrite() {
    clearTimeout(this.#writeTimer);
    // ponytail: 500ms coalesce so a speed drag, or a power+speed pair, becomes one STATE-SET
    this.#writeTimer = setTimeout(() => void this.#flushWrite(), 500);
  }

  async #flushWrite() {
    this.#writeTimer = undefined;
    this.#writing = true;
    try {
      const fan = this.#purifier.state.fanControl;
      const applied = desiredOf(this.#state);
      const speed = speedIntent(
        {
          speed: fan.speedSetting ?? undefined,
          percent: fan.percentSetting === null ? undefined : speedFromPercent(fan.percentSetting),
        },
        applied.speed,
      );
      // A speed the fan did not report is a manual speed request, which also means "not auto".
      const speedChanged = speed !== undefined && speed > 0 && speed !== applied.speed;
      const desired: DesiredFan = {
        on: powerIntent(
          { mode: fan.fanMode !== FanMode.Off, onOff: this.#purifier.state.onOff.onOff, speed: (speed ?? 0) > 0 },
          applied.on,
        ),
        auto: speedChanged ? false : fan.fanMode === FanMode.Auto,
        speed: speedChanged ? speed : applied.speed,
        oscillate: fan.rockSetting.rockLeftRight === true,
        forward: fan.airflowDirection !== AirflowDirection.Reverse,
        night: fan.windSetting.sleepWind === true,
      };
      const patch = commandsFor(desired, this.#state);
      if (!Object.keys(patch).length) {
        console.log(`${this.#name}: controller write matched the fan's state, nothing sent`);
        // Snap the attributes the controller did not write back to the fan's truth, so a slider
        // resting between two of the fan's ten steps does not look like a pending change.
        await this.#mirror();
        return;
      }
      this.#client.setState(patch);
      console.log(`${this.#name}: STATE-SET ${JSON.stringify(patch)}`);
      this.#state = { ...this.#state, ...patch };
      // The controller only wrote one attribute; publish the rest so its UI and our next read agree.
      await this.#mirror();
    } catch (error) {
      console.error(`${this.#name}: command failed:`, error);
    } finally {
      this.#writing = false;
    }
  }

  /** Push the fan's state onto every attribute a controller might have written. */
  async #mirror() {
    await this.#purifier.set({
      fanControl: fanState(this.#state),
      onOff: { onOff: isOn(this.#state) },
    });
  }

  /** Dyson → Matter. */
  async applyState(state: DysonState) {
    this.#state = state;
    if (this.#writing || this.#writeTimer !== undefined) return; // a controller write owns the state
    const hepa = filterState(state.hflr);
    const carbon = filterState(state.cflr);
    await this.#purifier.set({
      fanControl: fanState(state),
      onOff: { onOff: isOn(state) },
      ...(hepa ? { hepaFilterMonitoring: hepa } : {}),
      ...(this.#hasCarbonFilter && carbon ? { activatedCarbonFilterMonitoring: carbon } : {}),
    });
  }

  async applyEnvironment(environment: DysonState) {
    await this.#airQuality.set(airQualityState(environment));
  }

  /** The fan is only reachable while the MQTT session is up. */
  async setReachable(reachable: boolean) {
    for (const endpoint of [this.#purifier, this.#airQuality]) {
      await endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
    }
  }
}
