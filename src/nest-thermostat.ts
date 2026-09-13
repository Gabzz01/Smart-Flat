/**
 * Maps a Google Nest thermostat (SDM API) onto Matter: one bridged Thermostat endpoint and one
 * bridged HumiditySensor endpoint, each added directly to the aggregator.
 *
 * The ambient temperature is not a sensor endpoint of its own: the Thermostat cluster already
 * carries it as localTemperature, and controllers count both, so a bridged thermometer only
 * duplicates the thermostat in every climate summary.
 *
 * They are deliberately NOT composed under a shared BridgedNode. Apple Home surfaces only one
 * device type per composed node and picks it unpredictably, which left a different thermostat
 * exposed as a humidity sensor after every pairing. One device type per bridged endpoint is
 * unambiguous, and it is also what matter.js recommends for Alexa.
 */

import { Endpoint } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { HumiditySensorDevice, ThermostatDevice } from "@matter/main/devices";
import type { SdmClient, SdmDevice, ThermostatMode } from "./sdm.ts";
import { numbersForSlot } from "./slots.ts";

const { SystemMode, ControlSequenceOfOperation } = Thermostat;

/**
 * Feature selection is per device and only known at runtime, so endpoints are typed against the
 * fully featured thermostat and the actual (narrower) endpoint is cast to it.
 */
const FullThermostatDevice = ThermostatDevice.with(
  ThermostatServer.with("Heating", "Cooling", "AutoMode", "Presets"),
  BridgedDeviceBasicInformationServer,
);
type ThermostatEndpoint = Endpoint<typeof FullThermostatDevice>;

const BridgedHumiditySensorDevice = HumiditySensorDevice.with(BridgedDeviceBasicInformationServer);
type HumidityEndpoint = Endpoint<typeof BridgedHumiditySensorDevice>;

/** Bridged accessory identity. Matter requires uniqueId and serialNumber to differ. */
function bridgedInfo(device: SdmDevice, name: string, kind: "t" | "h") {
  const key = deviceKey(device);
  return {
    nodeLabel: name.slice(0, 32),
    productName: "Nest Thermostat",
    productLabel: name.slice(0, 64),
    serialNumber: `${kind}-${key.slice(-30)}`,
    uniqueId: `nest-${kind}-${key.slice(-25)}`,
    vendorName: "Google",
    reachable: isReachable(device),
  };
}

/** Used when the thermostat is off and Google reports no setpoint at all. */
const DEFAULT_HEAT_C = 20;
const DEFAULT_COOL_C = 24;

/** Setpoint range a Nest accepts (Google Device Access docs). */
const MIN_SETPOINT = 900;
const MAX_SETPOINT = 3200;

/** Preset handles. Nest has exactly two comfort levels: its normal setpoint and Eco. */
const MANUAL_PRESET = Uint8Array.of(1);
const ECO_PRESET = Uint8Array.of(2);

export const deviceKey = (device: SdmDevice) => device.name.split("/").pop() ?? device.name;

/** Matter endpoint ids are path-ish; keep them short, lowercase and unique per device. */
export const endpointId = (device: SdmDevice) =>
  `nest-${deviceKey(device).toLowerCase().replace(/[^a-z0-9]/g, "").slice(-16)}`;

export function displayName(device: SdmDevice) {
  const custom = device.traits["sdm.devices.traits.Info"]?.customName?.trim();
  return custom || device.parentRelations?.[0]?.displayName?.trim() || "Thermostat";
}

/** Nest accepts 0.5 °C steps. */
export const roundToHalf = (celsius: number) => Math.round(celsius * 2) / 2;

const toMatterTemp = (celsius: number) => Math.round(celsius * 100);

export function isEco(device: SdmDevice) {
  return device.traits["sdm.devices.traits.ThermostatEco"]?.mode === "MANUAL_ECO";
}

export function currentMode(device: SdmDevice): ThermostatMode {
  return device.traits["sdm.devices.traits.ThermostatMode"]?.mode ?? "OFF";
}

/**
 * Thermostat cluster features and control sequence implied by the modes Google says the device
 * supports. Features are fixed at endpoint creation, so this runs once per device.
 */
export function thermostatCapabilities(device: SdmDevice) {
  const available = device.traits["sdm.devices.traits.ThermostatMode"]?.availableModes ?? ["OFF"];
  const heating = available.includes("HEAT") || available.includes("HEATCOOL");
  const cooling = available.includes("COOL") || available.includes("HEATCOOL");
  const autoMode = available.includes("HEATCOOL");

  const features = [
    ...(heating ? (["Heating"] as const) : []),
    ...(cooling ? (["Cooling"] as const) : []),
    ...(autoMode ? (["AutoMode"] as const) : []),
  ];

  const controlSequenceOfOperation =
    heating && cooling
      ? ControlSequenceOfOperation.CoolingAndHeating
      : cooling
        ? ControlSequenceOfOperation.CoolingOnly
        : ControlSequenceOfOperation.HeatingOnly;

  return { heating, cooling, autoMode, features, controlSequenceOfOperation };
}

export function systemModeOf(device: SdmDevice) {
  switch (currentMode(device)) {
    case "HEAT":
      return SystemMode.Heat;
    case "COOL":
      return SystemMode.Cool;
    case "HEATCOOL":
      return SystemMode.Auto;
    default:
      return SystemMode.Off;
  }
}

/** The setpoints the Nest holds outside Eco, kept separately so Eco cannot overwrite them. */
export interface Setpoints {
  heat?: number;
  cool?: number;
}

/**
 * The manual (non-Eco) setpoints. Google reports an empty setpoint trait whenever the thermostat is
 * off or in Eco, so the last known value carries over, then a sane default.
 */
export function manualSetpoints(device: SdmDevice, previous?: Setpoints): Setpoints {
  const { heating, cooling } = thermostatCapabilities(device);
  const trait = device.traits["sdm.devices.traits.ThermostatTemperatureSetpoint"];
  return {
    heat: heating
      ? (trait?.heatCelsius !== undefined ? toMatterTemp(trait.heatCelsius) : (previous?.heat ?? toMatterTemp(DEFAULT_HEAT_C)))
      : undefined,
    cool: cooling
      ? (trait?.coolCelsius !== undefined ? toMatterTemp(trait.coolCelsius) : (previous?.cool ?? toMatterTemp(DEFAULT_COOL_C)))
      : undefined,
  };
}

/** The setpoints the Nest holds in Eco, as Google reports them. */
export function ecoSetpoints(device: SdmDevice): Setpoints {
  const { heating, cooling } = thermostatCapabilities(device);
  const eco = device.traits["sdm.devices.traits.ThermostatEco"];
  return {
    heat: heating && eco?.heatCelsius !== undefined ? toMatterTemp(eco.heatCelsius) : undefined,
    cool: cooling && eco?.coolCelsius !== undefined ? toMatterTemp(eco.coolCelsius) : undefined,
  };
}

export interface ThermostatState {
  localTemperature: number;
  systemMode: Thermostat.SystemMode;
  occupiedHeatingSetpoint?: number;
  occupiedCoolingSetpoint?: number;
  thermostatRunningState: Thermostat.RelayState;
  /** Nest's Eco mode, exposed as a preset a controller can activate. */
  activePresetHandle: Uint8Array;
}

export const isEcoPreset = (handle: Uint8Array | null) => handle?.[0] === ECO_PRESET[0];

/** Google → Matter state. `manual` supplies the setpoints to report when Eco is off. */
export function thermostatState(
  device: SdmDevice,
  manual: Setpoints = manualSetpoints(device),
): ThermostatState {
  const active = isEco(device) ? ecoSetpoints(device) : manual;
  const ambient = device.traits["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius ?? 0;

  return {
    localTemperature: toMatterTemp(ambient),
    systemMode: systemModeOf(device),
    thermostatRunningState: runningState(device),
    activePresetHandle: isEco(device) ? ECO_PRESET : MANUAL_PRESET,
    ...(active.heat !== undefined ? { occupiedHeatingSetpoint: active.heat } : {}),
    ...(active.cool !== undefined ? { occupiedCoolingSetpoint: active.cool } : {}),
  };
}

/** Google → Matter: what the HVAC is energising right now. */
export function runningState(device: SdmDevice) {
  const status = device.traits["sdm.devices.traits.ThermostatHvac"]?.status;
  return { heat: status === "HEATING", cool: status === "COOLING", fan: false };
}

export function humidityState(device: SdmDevice) {
  const percent = device.traits["sdm.devices.traits.Humidity"]?.ambientHumidityPercent;
  return { measuredValue: percent === undefined ? null : Math.round(percent * 100) };
}

/**
 * The two presets we publish. Eco carries the setpoints Google reports for it, so activating the
 * preset in a controller shows the temperatures the Nest will actually hold.
 */
export function presetsFor(device: SdmDevice, manual: Setpoints): Thermostat.Preset[] {
  const eco = ecoSetpoints(device);
  return [
    {
      presetHandle: MANUAL_PRESET,
      presetScenario: Thermostat.PresetScenario.Occupied,
      name: "Manual",
      builtIn: true,
      heatingSetpoint: manual.heat,
      coolingSetpoint: manual.cool,
    },
    {
      presetHandle: ECO_PRESET,
      presetScenario: Thermostat.PresetScenario.Unoccupied,
      name: "Eco",
      builtIn: true,
      heatingSetpoint: eco.heat,
      coolingSetpoint: eco.cool,
    },
  ];
}

/** Setpoint limits, so controllers cannot offer a temperature Google would reject. */
export function setpointLimits(device: SdmDevice) {
  const { heating, cooling } = thermostatCapabilities(device);
  return {
    ...(heating
      ? {
          absMinHeatSetpointLimit: MIN_SETPOINT,
          absMaxHeatSetpointLimit: MAX_SETPOINT,
          minHeatSetpointLimit: MIN_SETPOINT,
          maxHeatSetpointLimit: MAX_SETPOINT,
        }
      : {}),
    ...(cooling
      ? {
          absMinCoolSetpointLimit: MIN_SETPOINT,
          absMaxCoolSetpointLimit: MAX_SETPOINT,
          minCoolSetpointLimit: MIN_SETPOINT,
          maxCoolSetpointLimit: MAX_SETPOINT,
        }
      : {}),
  };
}

export const isReachable = (device: SdmDevice) =>
  device.traits["sdm.devices.traits.Connectivity"]?.status !== "OFFLINE";

/** Commands needed to bring the real thermostat in line with the Matter cluster state. */
export function commandsFor(state: ThermostatState, device: SdmDevice) {
  const commands: { command: string; params: Record<string, unknown> }[] = [];

  const wantEco = isEcoPreset(state.activePresetHandle);
  if (wantEco !== isEco(device)) {
    commands.push({
      command: "sdm.devices.commands.ThermostatEco.SetMode",
      params: { mode: wantEco ? "MANUAL_ECO" : "OFF" },
    });
  }
  // In Eco the Nest holds its own setpoints and Google rejects mode and setpoint commands.
  if (wantEco) return commands;

  const mode: ThermostatMode =
    state.systemMode === SystemMode.Heat
      ? "HEAT"
      : state.systemMode === SystemMode.Cool
        ? "COOL"
        : state.systemMode === SystemMode.Auto
          ? "HEATCOOL"
          : "OFF";

  if (mode !== currentMode(device)) {
    commands.push({ command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode } });
  }

  const heat = state.occupiedHeatingSetpoint;
  const cool = state.occupiedCoolingSetpoint;
  const setpoint = "sdm.devices.commands.ThermostatTemperatureSetpoint";
  if (mode === "HEATCOOL" && heat !== undefined && cool !== undefined) {
    commands.push({
      command: `${setpoint}.SetRange`,
      params: { heatCelsius: roundToHalf(heat / 100), coolCelsius: roundToHalf(cool / 100) },
    });
  } else if (mode === "HEAT" && heat !== undefined) {
    commands.push({ command: `${setpoint}.SetHeat`, params: { heatCelsius: roundToHalf(heat / 100) } });
  } else if (mode === "COOL" && cool !== undefined) {
    commands.push({ command: `${setpoint}.SetCool`, params: { coolCelsius: roundToHalf(cool / 100) } });
  }

  return commands;
}

/** A bridged Nest thermostat: its endpoints plus the state sync in both directions. */
export class BridgedThermostat {
  readonly #client: SdmClient;
  readonly #thermostat: ThermostatEndpoint;
  readonly #humidity: HumidityEndpoint;
  #device: SdmDevice;
  #state: ThermostatState;
  /** Last known non-Eco setpoints, so entering Eco does not erase them. */
  #manual: Setpoints;
  /** Set while a controller-initiated write is pending or in flight; polls skip this device. */
  #writeTimer?: ReturnType<typeof setTimeout>;
  #writing = false;

  private constructor(
    client: SdmClient,
    device: SdmDevice,
    thermostat: ThermostatEndpoint,
    humidity: HumidityEndpoint,
    state: ThermostatState,
    manual: Setpoints,
  ) {
    this.#client = client;
    this.#device = device;
    this.#thermostat = thermostat;
    this.#humidity = humidity;
    this.#state = state;
    this.#manual = manual;
  }

  static async add(aggregator: Endpoint, device: SdmDevice, client: SdmClient, slot: number) {
    const id = endpointId(device);
    // Undefined past the three-digit range: fall back to matter.js numbering, which orders the
    // parts list correctly again once every endpoint has four digits.
    const base = numbersForSlot(slot);
    const name = displayName(device);
    const { features, controlSequenceOfOperation } = thermostatCapabilities(device);
    const manual = manualSetpoints(device);
    const state = thermostatState(device, manual);

    const thermostat = (await aggregator.add(
      ThermostatDevice.with(
        ThermostatServer.with(...features, "Presets"),
        BridgedDeviceBasicInformationServer,
      ),
      {
        id: `${id}-t`,
        number: base,
        thermostat: {
          ...state,
          ...setpointLimits(device),
          controlSequenceOfOperation,
          presetTypes: [
            {
              presetScenario: Thermostat.PresetScenario.Occupied,
              numberOfPresets: 1,
              presetTypeFeatures: { automatic: false, supportsNames: true },
            },
            {
              presetScenario: Thermostat.PresetScenario.Unoccupied,
              numberOfPresets: 1,
              presetTypeFeatures: { automatic: false, supportsNames: true },
            },
          ],
          numberOfPresets: 2,
          // Seeds the cluster's virtual "presets" attribute; later updates go to persistedPresets.
          presets: presetsFor(device, manual),
        },
        bridgedDeviceBasicInformation: bridgedInfo(device, name, "t"),
      },
    )) as ThermostatEndpoint;

    const humidity = (await aggregator.add(BridgedHumiditySensorDevice, {
      id: `${id}-h`,
      number: base === undefined ? undefined : base + 1,
      relativeHumidityMeasurement: humidityState(device),
      bridgedDeviceBasicInformation: bridgedInfo(device, `${name} Humidity`, "h"),
    })) as HumidityEndpoint;

    const bridge = new BridgedThermostat(client, device, thermostat, humidity, state, manual);
    bridge.#watchControllerWrites();
    return bridge;
  }

  get name() {
    return this.#device.name;
  }

  /** Matter → Google. Controller writes are coalesced, our own updates (offline) are ignored. */
  #watchControllerWrites() {
    const events = this.#thermostat.events.thermostat as unknown as Record<
      string,
      { on(handler: (value: unknown, oldValue: unknown, context: { offline?: boolean }) => void): void }
    >;
    const watched = [
      "systemMode$Changed",
      "occupiedHeatingSetpoint$Changed",
      "occupiedCoolingSetpoint$Changed",
      "activePresetHandle$Changed",
    ];
    for (const name of watched) {
      events[name]?.on((_value, _old, context) => {
        if (context?.offline) return; // our own poll writing state back
        this.#scheduleWrite();
      });
    }
  }

  #scheduleWrite() {
    clearTimeout(this.#writeTimer);
    // ponytail: 500ms coalesce so a setpoint drag or a mode+setpoint pair becomes one round trip
    this.#writeTimer = setTimeout(() => void this.#flushWrite(), 500);
  }

  async #flushWrite() {
    this.#writeTimer = undefined;
    this.#writing = true;
    try {
      const cluster = this.#thermostat.state.thermostat;
      const desired: ThermostatState = {
        localTemperature: this.#state.localTemperature,
        systemMode: cluster.systemMode,
        occupiedHeatingSetpoint: cluster.occupiedHeatingSetpoint,
        occupiedCoolingSetpoint: cluster.occupiedCoolingSetpoint,
        thermostatRunningState: this.#state.thermostatRunningState,
        activePresetHandle: cluster.activePresetHandle ?? MANUAL_PRESET,
      };
      if (isEco(this.#device) && !isEcoPreset(desired.activePresetHandle)) {
        console.log(`${displayName(this.#device)}: leaving Eco`);
      }
      for (const { command, params } of commandsFor(desired, this.#device)) {
        await this.#client.executeCommand(this.#device.name, command, params);
        console.log(`${displayName(this.#device)}: ${command.split(".").pop()} ${JSON.stringify(params)}`);
      }
      this.#state = { ...desired };
    } catch (error) {
      console.error(`${displayName(this.#device)}: command failed:`, error);
    } finally {
      this.#writing = false;
    }
  }

  /** Google → Matter. */
  async apply(device: SdmDevice) {
    this.#device = device;
    const reachable = isReachable(device);
    await this.#thermostat.set({ bridgedDeviceBasicInformation: { reachable } });
    await this.#humidity.set({
      bridgedDeviceBasicInformation: { reachable },
      relativeHumidityMeasurement: humidityState(device),
    });
    if (this.#writing || this.#writeTimer !== undefined) return; // a controller write owns the state right now
    this.#manual = manualSetpoints(device, this.#manual);
    this.#state = thermostatState(device, this.#manual);

    // Rewriting the preset list clears the active handle, so only touch it when it really changed.
    const presets = presetsFor(device, this.#manual);
    const current = this.#thermostat.state.thermostat.presets;
    if (JSON.stringify(current) !== JSON.stringify(presets)) {
      await this.#thermostat.set({ thermostat: { persistedPresets: presets } });
    }
    // A direct setpoint write clears activePresetHandle (a manual change deactivates the preset),
    // so the handle has to be restored afterwards rather than in the same patch.
    const { activePresetHandle, ...attributes } = this.#state;
    await this.#thermostat.set({ thermostat: attributes });
    await this.#thermostat.set({ thermostat: { activePresetHandle } });
  }

  async setUnreachable() {
    for (const endpoint of [this.#thermostat, this.#humidity]) {
      await endpoint.set({ bridgedDeviceBasicInformation: { reachable: false } });
    }
  }
}
