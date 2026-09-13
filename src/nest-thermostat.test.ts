import { expect, test } from "bun:test";
import { Thermostat } from "@matter/main/clusters";
import {
  commandsFor,
  displayName,
  endpointId,
  humidityState,
  manualSetpoints,
  presetsFor,
  roundToHalf,
  runningState,
  setpointLimits,
  thermostatCapabilities,
  thermostatState,
} from "./nest-thermostat.ts";
import type { ThermostatState } from "./nest-thermostat.ts";
import type { SdmDevice } from "./sdm.ts";

const fixture = (await Bun.file("fixtures/devices.json").json()) as { devices: SdmDevice[] };
const [spareRoom, , kitchen] = fixture.devices as [SdmDevice, SdmDevice, SdmDevice];

const withTraits = (device: SdmDevice, traits: Partial<SdmDevice["traits"]>): SdmDevice => ({
  ...device,
  traits: { ...device.traits, ...traits },
});

/** Cluster state as a controller would leave it: Eco off unless a test says otherwise. */
const manualState = (state: Partial<ThermostatState>): ThermostatState => ({
  localTemperature: 2575,
  systemMode: Thermostat.SystemMode.Off,
  thermostatRunningState: { heat: false, cool: false, fan: false },
  activePresetHandle: Uint8Array.of(1),
  ...state,
});
const ecoState = (state: Partial<ThermostatState> = {}) =>
  manualState({ ...state, activePresetHandle: Uint8Array.of(2) });

test("heat-only Nest gets the Heating feature and a heating control sequence", () => {
  const { features, controlSequenceOfOperation, autoMode } = thermostatCapabilities(spareRoom);
  expect(features).toEqual(["Heating"]);
  expect(autoMode).toBe(false);
  expect(controlSequenceOfOperation).toBe(Thermostat.ControlSequenceOfOperation.HeatingOnly);
});

test("HEATCOOL Nest gets heating, cooling and auto", () => {
  const heatcool = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatMode": { mode: "HEATCOOL", availableModes: ["HEAT", "COOL", "HEATCOOL", "OFF"] },
  });
  expect(thermostatCapabilities(heatcool).features).toEqual(["Heating", "Cooling", "AutoMode"]);
  expect(thermostatCapabilities(heatcool).controlSequenceOfOperation).toBe(
    Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
  );
});

test("ambient temperature rides on the thermostat, not a sensor endpoint", () => {
  expect(thermostatState(spareRoom).localTemperature).toBe(2575);
  expect(humidityState(spareRoom).measuredValue).toBe(5800);
});

test("mode OFF maps to SystemMode.Off and no cooling setpoint on a heat-only device", () => {
  const state = thermostatState(spareRoom);
  expect(state.systemMode).toBe(Thermostat.SystemMode.Off);
  expect(state.occupiedCoolingSetpoint).toBeUndefined();
});

test("empty setpoint trait falls back to the previous value, then to the default", () => {
  expect(manualSetpoints(spareRoom)).toEqual({ heat: 2000, cool: undefined });
  expect(manualSetpoints(spareRoom, { heat: 2150 })).toEqual({ heat: 2150, cool: undefined });
  expect(thermostatState(spareRoom).occupiedHeatingSetpoint).toBe(2000);
});

test("Eco does not overwrite the remembered manual setpoint", () => {
  const eco = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatEco": { mode: "MANUAL_ECO", heatCelsius: 9.5, coolCelsius: 24.5 },
  });
  const manual = { heat: 2150 };
  // The cluster reports Eco's setpoint...
  expect(thermostatState(eco, manual).occupiedHeatingSetpoint).toBe(950);
  // ...while the Manual preset still carries the real one.
  expect(presetsFor(eco, manual)[0]?.heatingSetpoint).toBe(2150);
});

test("reported setpoint wins over the fallback", () => {
  const heating = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["HEAT", "OFF"] },
    "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21.5 },
  });
  expect(thermostatState(heating).occupiedHeatingSetpoint).toBe(2150);
});

test("Eco mode reports the eco setpoints", () => {
  const eco = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatEco": { mode: "MANUAL_ECO", heatCelsius: 9.444397, coolCelsius: 24.444443 },
  });
  expect(thermostatState(eco).occupiedHeatingSetpoint).toBe(944);
});

test("empty customName falls back to the room name", () => {
  expect(displayName(kitchen)).toBe("Kitchen");
  expect(displayName(spareRoom)).toBe("Spare Room");
});

test("endpoint id is short, lowercase and unique per device", () => {
  const ids = fixture.devices.map(endpointId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^nest-[a-z0-9]{16}$/);
});

test("setpoints are rounded to Nest's half-degree steps", () => {
  expect(roundToHalf(21.26)).toBe(21.5);
  expect(roundToHalf(21.1)).toBe(21);
});

test("turning on heat sends SetMode then SetHeat", () => {
  const commands = commandsFor(
    manualState({ systemMode: Thermostat.SystemMode.Heat, occupiedHeatingSetpoint: 2126 }),
    spareRoom,
  );
  expect(commands).toEqual([
    { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "HEAT" } },
    { command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat", params: { heatCelsius: 21.5 } },
  ]);
});

test("auto mode sends a range", () => {
  const heatcool = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatMode": { mode: "HEATCOOL", availableModes: ["HEAT", "COOL", "HEATCOOL", "OFF"] },
  });
  expect(
    commandsFor(
      manualState({
        systemMode: Thermostat.SystemMode.Auto,
        occupiedHeatingSetpoint: 2000,
        occupiedCoolingSetpoint: 2400,
      }),
      heatcool,
    ),
  ).toEqual([
    {
      command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange",
      params: { heatCelsius: 20, coolCelsius: 24 },
    },
  ]);
});

test("turning off sends only SetMode", () => {
  const heating = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["HEAT", "OFF"] },
  });
  expect(
    commandsFor(
      manualState({ systemMode: Thermostat.SystemMode.Off, occupiedHeatingSetpoint: 2000 }),
      heating,
    ),
  ).toEqual([{ command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "OFF" } }]);
});

test("HVAC status maps to the running state relay bitmap", () => {
  expect(runningState(spareRoom)).toEqual({ heat: false, cool: false, fan: false });
  const heating = withTraits(spareRoom, { "sdm.devices.traits.ThermostatHvac": { status: "HEATING" } });
  expect(runningState(heating)).toEqual({ heat: true, cool: false, fan: false });
  const cooling = withTraits(spareRoom, { "sdm.devices.traits.ThermostatHvac": { status: "COOLING" } });
  expect(runningState(cooling)).toEqual({ heat: false, cool: true, fan: false });
});

test("setpoint limits cover the range a Nest accepts, per supported mode", () => {
  expect(setpointLimits(spareRoom)).toEqual({
    absMinHeatSetpointLimit: 900,
    absMaxHeatSetpointLimit: 3200,
    minHeatSetpointLimit: 900,
    maxHeatSetpointLimit: 3200,
  });
  const heatcool = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatMode": { mode: "HEATCOOL", availableModes: ["HEAT", "COOL", "HEATCOOL", "OFF"] },
  });
  expect(Object.keys(setpointLimits(heatcool))).toHaveLength(8);
});

test("Eco is published as a preset carrying Google's eco setpoints", () => {
  const [manual, eco] = presetsFor(spareRoom, manualSetpoints(spareRoom)) as [
    Thermostat.Preset,
    Thermostat.Preset,
  ];
  expect(manual.presetHandle).toEqual(Uint8Array.of(1));
  expect(manual.heatingSetpoint).toBe(2000);
  expect(eco.presetHandle).toEqual(Uint8Array.of(2));
  expect(eco.name).toBe("Eco");
  expect(eco.heatingSetpoint).toBe(944);
  // Heat-only device: no cooling setpoint on either preset.
  expect(manual.coolingSetpoint).toBeUndefined();
  expect(eco.coolingSetpoint).toBeUndefined();
});

test("a device in Eco reports the Eco preset as active", () => {
  const eco = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatEco": { mode: "MANUAL_ECO", heatCelsius: 9.444397, coolCelsius: 24.444443 },
  });
  expect(thermostatState(eco).activePresetHandle).toEqual(Uint8Array.of(2));
  expect(thermostatState(spareRoom).activePresetHandle).toEqual(Uint8Array.of(1));
});

test("activating the Eco preset turns Eco on and sends nothing else", () => {
  expect(commandsFor(ecoState({ systemMode: Thermostat.SystemMode.Heat }), spareRoom)).toEqual([
    { command: "sdm.devices.commands.ThermostatEco.SetMode", params: { mode: "MANUAL_ECO" } },
  ]);
});

test("leaving Eco turns it off before restoring mode and setpoint", () => {
  const eco = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatEco": { mode: "MANUAL_ECO", heatCelsius: 9.4, coolCelsius: 24.4 },
  });
  expect(
    commandsFor(manualState({ systemMode: Thermostat.SystemMode.Heat, occupiedHeatingSetpoint: 2100 }), eco),
  ).toEqual([
    { command: "sdm.devices.commands.ThermostatEco.SetMode", params: { mode: "OFF" } },
    { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "HEAT" } },
    { command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat", params: { heatCelsius: 21 } },
  ]);
});

test("staying in Eco sends no commands at all", () => {
  const eco = withTraits(spareRoom, {
    "sdm.devices.traits.ThermostatEco": { mode: "MANUAL_ECO", heatCelsius: 9.4, coolCelsius: 24.4 },
  });
  expect(commandsFor(ecoState(), eco)).toEqual([]);
});
