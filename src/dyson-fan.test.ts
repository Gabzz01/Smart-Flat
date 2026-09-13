import { expect, test } from "bun:test";
import { AirQuality, ConcentrationMeasurement, FanControl, ResourceMonitoring } from "@matter/main/clusters";
import {
  airQualityOf,
  desiredOf,
  powerIntent,
  speedFromPercent,
  speedIntent,
  airQualityState,
  commandsFor,
  endpointId,
  fanState,
  filterState,
  humidityState,
  levelOf,
  temperatureState,
} from "./dyson-fan.ts";
import type { DesiredFan } from "./dyson-fan.ts";
import { environmentOf, normalizeState } from "./dyson.ts";
import type { DysonState } from "./dyson.ts";

const fixture = (await Bun.file("fixtures/dyson-state.json").json()) as {
  state: { "product-state": Record<string, string> };
  environment: Record<string, unknown>;
  changes: { "product-state": Record<string, [string, string]> }[];
};

const state = normalizeState(fixture.state["product-state"]);
const environment = environmentOf(fixture.environment);
const [poweredOn, slowedDown, switchedToAuto] = fixture.changes.map(change =>
  normalizeState(change["product-state"]),
) as [DysonState, DysonState, DysonState];

const desired = (overrides: Partial<DesiredFan> = {}): DesiredFan => ({
  on: true,
  auto: false,
  speed: 5,
  oscillate: true,
  forward: true,
  night: false,
  ...overrides,
});

test("STATE-CHANGE pairs collapse to the new value", () => {
  expect(poweredOn.fpwr).toBe("ON"); // ["OFF", "ON"]
  expect(slowedDown.fnsp).toBe("0003"); // ["0004", "0003"]
});

test("a running fan reports its speed as mode, percent and speed", () => {
  expect(fanState(state)).toMatchObject({
    fanMode: FanControl.FanMode.Medium,
    percentSetting: 50,
    percentCurrent: 50,
    speedSetting: 5,
    speedCurrent: 5,
  });
});

test("fan mode buckets follow the 1-10 speed", () => {
  const at = (fnsp: string) => fanState({ fpwr: "ON", fnst: "FAN", fnsp }).fanMode;
  expect(at("0003")).toBe(FanControl.FanMode.Low);
  expect(at("0007")).toBe(FanControl.FanMode.Medium);
  expect(at("0008")).toBe(FanControl.FanMode.High);
});

test("auto mode leaves the setting to the fan and reports it idle when not blowing", () => {
  expect(fanState(switchedToAuto)).toMatchObject({
    fanMode: FanControl.FanMode.Off, // fpwr went OFF in this capture
    percentSetting: 0,
    speedSetting: 0,
  });
  const running = fanState({ fpwr: "ON", auto: "ON", fnsp: "AUTO", fnst: "FAN" });
  expect(running.fanMode).toBe(FanControl.FanMode.Auto);
  expect(running.percentSetting).toBeNull();
  expect(running.speedSetting).toBeNull();
  const idle = fanState({ fpwr: "ON", auto: "ON", fnsp: "AUTO", fnst: "OFF" });
  expect(idle.percentCurrent).toBe(0);
});

test("oscillation and airflow direction come from oson and fdir", () => {
  expect(fanState(state).rockSetting.rockLeftRight).toBe(true);
  expect(fanState(poweredOn).rockSetting.rockLeftRight).toBe(false);
  expect(fanState(state).airflowDirection).toBe(FanControl.AirflowDirection.Forward);
  expect(fanState({ ...state, fdir: "OFF" }).airflowDirection).toBe(FanControl.AirflowDirection.Reverse);
});

test("night mode is published as the sleepWind bit", () => {
  expect(fanState({ nmod: "ON" }).windSetting).toEqual({ sleepWind: true, naturalWind: false });
  expect(fanState({ nmod: "OFF" }).windSetting.sleepWind).toBe(false);
  expect(commandsFor(desired({ night: true }), state)).toEqual({ nmod: "ON" });
});

test("filter life becomes a condition, and INV means no such filter", () => {
  expect(filterState(state.hflr)).toEqual({
    condition: 60,
    changeIndication: ResourceMonitoring.ChangeIndication.Ok,
    degradationDirection: ResourceMonitoring.DegradationDirection.Down,
  });
  expect(filterState(state.cflr)).toBeUndefined(); // "INV": combined filter, none fitted
  expect(filterState("0008")?.changeIndication).toBe(ResourceMonitoring.ChangeIndication.Warning);
  expect(filterState("0000")?.changeIndication).toBe(ResourceMonitoring.ChangeIndication.Critical);
});

test("tenths of a Kelvin become hundredths of a degree Celsius", () => {
  expect(temperatureState(environment).measuredValue).toBe(2205); // 295.2 K
  expect(temperatureState({ tact: "OFF" }).measuredValue).toBeNull();
  expect(humidityState(environment).measuredValue).toBe(4700);
  expect(humidityState({}).measuredValue).toBeNull();
});

test("an idle sensor board publishes nothing rather than its constants", () => {
  // What a stuck board actually sends: 0 % humidity, zeroed particulates, a frozen temperature.
  const idle = { tact: "2710", hact: "0000", pm25: "0000", pm10: "0000", va10: "0005", noxl: "0002" };
  expect(humidityState(idle).measuredValue).toBeNull();
  expect(temperatureState(idle).measuredValue).toBeNull();
  const clusters = airQualityState(idle);
  expect(clusters.pm25ConcentrationMeasurement.measuredValue).toBeNull();
  expect(clusters.airQuality.airQuality).toBe(AirQuality.AirQualityEnum.Unknown);
  expect(clusters.nitrogenDioxideConcentrationMeasurement.levelValue).toBe(ConcentrationMeasurement.LevelValue.Unknown);
  // With humidity reporting, a genuine 0 µg/m³ is still a reading.
  expect(airQualityState({ hact: "0047", pm25: "0000" }).pm25ConcentrationMeasurement.measuredValue).toBe(0);
});

test("air quality follows the PM2.5 breakpoints", () => {
  const { AirQualityEnum } = AirQuality;
  expect(airQualityOf(undefined)).toBe(AirQualityEnum.Unknown);
  expect(airQualityOf(12)).toBe(AirQualityEnum.Good);
  expect(airQualityOf(13)).toBe(AirQualityEnum.Fair);
  expect(airQualityOf(55)).toBe(AirQualityEnum.Moderate);
  expect(airQualityOf(150)).toBe(AirQualityEnum.Poor);
  expect(airQualityOf(250)).toBe(AirQualityEnum.VeryPoor);
  expect(airQualityOf(251)).toBe(AirQualityEnum.ExtremelyPoor);
});

test("the VOC and NO2 indexes become levels", () => {
  const { LevelValue } = ConcentrationMeasurement;
  expect(levelOf(undefined)).toBe(LevelValue.Unknown);
  expect(levelOf(3)).toBe(LevelValue.Low);
  expect(levelOf(6)).toBe(LevelValue.Medium);
  expect(levelOf(8)).toBe(LevelValue.High);
  expect(levelOf(9)).toBe(LevelValue.Critical);
});

test("particulates carry their unit and medium", () => {
  const clusters = airQualityState(environment);
  expect(clusters.airQuality.airQuality).toBe(AirQuality.AirQualityEnum.Good);
  expect(clusters.pm25ConcentrationMeasurement).toMatchObject({
    measuredValue: 4,
    measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
    measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
  });
  expect(clusters.pm10ConcentrationMeasurement.measuredValue).toBe(6);
  expect(clusters.nitrogenDioxideConcentrationMeasurement.levelValue).toBe(ConcentrationMeasurement.LevelValue.Low);
});

test("only changed keys are sent", () => {
  expect(commandsFor(desired(), state)).toEqual({});
  expect(commandsFor(desired({ speed: 9 }), state)).toEqual({ fnsp: "0009" });
});

test("a speed always turns auto off, and auto never sends a speed", () => {
  const auto: DysonState = { ...state, auto: "ON", fnsp: "AUTO" };
  expect(commandsFor(desired({ speed: 5 }), auto)).toEqual({ auto: "OFF", fnsp: "0005" });
  expect(commandsFor(desired({ auto: true }), state)).toEqual({ auto: "ON" });
});

test("turning off sends no speed or mode", () => {
  expect(commandsFor(desired({ on: false, speed: 9, auto: true }), state)).toEqual({ fpwr: "OFF" });
});

test("oscillation, direction and night mode are switched independently", () => {
  expect(commandsFor(desired({ oscillate: false }), state)).toEqual({ oson: "OFF" });
  expect(commandsFor(desired({ forward: false }), state)).toEqual({ fdir: "OFF" });
  expect(commandsFor(desired({ night: true }), state)).toEqual({ nmod: "ON" });
});

test("speeds are clamped to the fan's 1-10 scale", () => {
  expect(commandsFor(desired({ speed: 0 }), state).fnsp).toBe("0001");
  expect(commandsFor(desired({ speed: 42 }), state).fnsp).toBe("0010");
});

test("endpoint id is derived from the serial", () => {
  expect(endpointId("X3B-UK-SAA0251A")).toBe("dyson-x3buksaa0251a");
});

test("whichever power source disagrees with the fan is the instruction", () => {
  // matter.js syncs none of fanMode / onOff / percentSetting, so only one of them moves.
  const off = { mode: false, onOff: false, speed: false };
  expect(powerIntent(off, false)).toBe(false);
  expect(powerIntent({ ...off, mode: true }, false)).toBe(true); // HomeKit wrote fanMode
  expect(powerIntent({ ...off, onOff: true }, false)).toBe(true); // ... or onOff
  expect(powerIntent({ ...off, speed: true }, false)).toBe(true); // ... or a speed
  const on = { mode: true, onOff: true, speed: true };
  expect(powerIntent(on, true)).toBe(true);
  expect(powerIntent({ ...on, onOff: false }, true)).toBe(false);
});

test("the fan's own state reads back as a desired state", () => {
  expect(desiredOf(state)).toEqual({
    on: true,
    auto: false,
    speed: 5,
    oscillate: true,
    forward: true,
    night: false,
  });
  expect(commandsFor(desiredOf(state), state)).toEqual({});
});

test("percent maps onto the fan's ten steps by rounding up, as the spec derives it", () => {
  expect(speedFromPercent(0)).toBe(0);
  expect(speedFromPercent(1)).toBe(1);
  expect(speedFromPercent(23)).toBe(3);
  expect(speedFromPercent(40)).toBe(4);
  expect(speedFromPercent(55)).toBe(6);
  expect(speedFromPercent(100)).toBe(10);
});

test("a speed written as percent wins over the stale speedSetting", () => {
  // Home writes percentSetting only; speedSetting keeps whatever we last mirrored from the fan.
  expect(speedIntent({ speed: 2, percent: 4 }, 2)).toBe(4);
  // ... and the other way round for a controller that writes speedSetting.
  expect(speedIntent({ speed: 7, percent: 2 }, 2)).toBe(7);
  // Neither moved: nothing changed.
  expect(speedIntent({ speed: 2, percent: 2 }, 2)).toBe(2);
  expect(speedIntent({ speed: undefined, percent: undefined }, 5)).toBe(5);
});
