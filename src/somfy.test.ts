import { expect, test } from "bun:test";
import { Endpoint, Environment, ServerNode } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { MovementDirection } from "@matter/main/behaviors/window-covering";
import {
  defaultScript,
  parseShutters,
  RollingCodes,
  rollingCodePath,
  SomfyRadio,
  type SomfyCommand,
  type Transmitter,
} from "./somfy.ts";

const codePath = () => `${import.meta.dir}/../.matter-storage/test-codes-${crypto.randomUUID()}.json`;
import { BridgedShutter, CLOSED, endpointId, INITIAL, movementFor, OPEN } from "./somfy-shutter.ts";

test("shutters parse to a name and a normalised address", () => {
  expect(parseShutters("Living Room:0x123457, Bedroom:123458")).toEqual([
    { name: "Living Room", address: "0x123457" },
    { name: "Bedroom", address: "0x123458" },
  ]);
  expect(parseShutters(undefined)).toEqual([]);
  expect(parseShutters("  ")).toEqual([]);
});

test("a name may contain a colon: the address is after the last one", () => {
  expect(parseShutters("Kitchen: Left:0xAABBCC")).toEqual([{ name: "Kitchen: Left", address: "0xaabbcc" }]);
});

/** Nothing discovers these addresses, so a typo would drive the wrong shutter or none at all. */
test("bad entries are rejected rather than silently driving nothing", () => {
  expect(() => parseShutters("Living Room")).toThrow(/<name>:<address>/);
  expect(() => parseShutters(":0x123457")).toThrow(/no name/);
  expect(() => parseShutters("Living Room:0x12345")).toThrow(/3 hex bytes/);
  expect(() => parseShutters("Living Room:zzzzzz")).toThrow(/3 hex bytes/);
  expect(() => parseShutters("Living Room:0x123457,Bedroom:123457")).toThrow(/twice/);
});

/** The script is spawned, so a compiled binary has to find it on disk, not inside itself. */
test("the transmitter script is found next to the executable when compiled", () => {
  expect(defaultScript("/opt/bridge/src", "/usr/bin/bun")).toBe("/opt/bridge/src/../somfy-tx.py");
  expect(defaultScript("/$bunfs/root", "/opt/bridge/matter-bridge")).toBe("/opt/bridge/somfy-tx.py");
});

test("open and close map to up and down, and a reversed motor swaps them", () => {
  expect(movementFor(MovementDirection.Open, false)).toEqual({ command: "up", position: OPEN });
  expect(movementFor(MovementDirection.Close, false)).toEqual({ command: "down", position: CLOSED });
  // Reversed swaps which command opens, not which position counts as open.
  expect(movementFor(MovementDirection.Open, true)).toEqual({ command: "down", position: OPEN });
  expect(movementFor(MovementDirection.Close, true)).toEqual({ command: "up", position: CLOSED });
});

/** The shutter can only be told to run, so a slider drag has to land on one end or the other. */
test("a target position resolves to the end it is nearer, and is reported as that end", () => {
  const by = MovementDirection.DefinedByPosition;
  expect(movementFor(by, false, 0)).toEqual({ command: "up", position: OPEN });
  expect(movementFor(by, false, 4_999)).toEqual({ command: "up", position: OPEN });
  // Exactly halfway closes: a shutter asked for "half" is more useful shut than open.
  expect(movementFor(by, false, 5_000)).toEqual({ command: "down", position: CLOSED });
  expect(movementFor(by, false, 10_000)).toEqual({ command: "down", position: CLOSED });
  // Nothing to resolve it with.
  expect(movementFor(by, false)).toBeUndefined();
});

/** One radio and one pigpio waveform: two overlapping transmissions make a frame nothing decodes. */
test("transmissions are queued, never overlapped", async () => {
  const log = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}.log`;
  const script = `${log}.sh`;
  const codes = codePath();
  // Stands in for somfy-tx.py: brackets its run in the log so an overlap is visible.
  await Bun.write(script, `echo "start $SOMFY_ADDR $1" >> ${log}\nsleep 0.1\necho "end $SOMFY_ADDR $1" >> ${log}\n`);
  const radio = new SomfyRadio(await RollingCodes.open(codes), { SOMFY_PYTHON: "/bin/sh", SOMFY_SCRIPT: script });

  try {
    await Promise.all([radio.send("0xaaaaaa", "up"), radio.send("0xbbbbbb", "down"), radio.send("0xcccccc", "my")]);
    expect((await Bun.file(log).text()).trim().split("\n")).toEqual([
      "start 0xaaaaaa up",
      "end 0xaaaaaa up",
      "start 0xbbbbbb down",
      "end 0xbbbbbb down",
      "start 0xcccccc my",
      "end 0xcccccc my",
    ]);
  } finally {
    radio.close();
    await Bun.file(log).delete();
    await Bun.file(script).delete();
    await Bun.file(codes).delete();
  }
});

test("a failed transmission is reported and does not wedge the queue", async () => {
  const script = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}.sh`;
  const codes = codePath();
  await Bun.write(script, 'test "$1" = up && { echo "no pigpiod" >&2; exit 3; }\necho ok\n');
  const radio = new SomfyRadio(await RollingCodes.open(codes), { SOMFY_PYTHON: "/bin/sh", SOMFY_SCRIPT: script });

  try {
    expect(radio.send("0xaaaaaa", "up")).rejects.toThrow(/exited 3: no pigpiod/);
    await radio.send("0xaaaaaa", "down");
  } finally {
    radio.close();
    await Bun.file(script).delete();
    await Bun.file(codes).delete();
  }
});

/** A shutter ignores a code behind the last it accepted, so the counter may only ever go up. */
test("rolling codes count up per remote and survive a restart", async () => {
  const path = codePath();
  try {
    const codes = await RollingCodes.open(path);
    expect(await codes.next("0xaaaaaa")).toBe(1);
    expect(await codes.next("0xaaaaaa")).toBe(2);
    // Each virtual remote has its own counter; one shutter's traffic must not skip another's.
    expect(await codes.next("0xbbbbbb")).toBe(1);

    // Gaps are free, going backwards is not.
    await codes.advanceTo("0xaaaaaa", 50);
    expect(await codes.next("0xaaaaaa")).toBe(50);
    await codes.advanceTo("0xaaaaaa", 10);
    expect(await codes.next("0xaaaaaa")).toBe(51);

    const reopened = await RollingCodes.open(path);
    expect(await reopened.next("0xaaaaaa")).toBe(52);
    expect(await reopened.next("0xbbbbbb")).toBe(2);
  } finally {
    await Bun.file(path).delete();
  }
});

/** The transmitter owns no state: the code it sends with has to arrive in its environment. */
test("the reserved code is handed to the transmitter, and its next= is adopted", async () => {
  const path = codePath();
  const script = `${path}.sh`;
  const out = `${path}.out`;
  await Bun.write(script, `echo "$SOMFY_ADDR $SOMFY_ROLL" >> ${out}\necho "sent $1: roll=$SOMFY_ROLL next=$((SOMFY_ROLL + 7))"\n`);
  const radio = new SomfyRadio(await RollingCodes.open(path), { SOMFY_PYTHON: "/bin/sh", SOMFY_SCRIPT: script });

  try {
    await radio.send("0xaaaaaa", "up");
    await radio.send("0xaaaaaa", "down");
    // 1, then the 8 the transmitter reported rather than the 2 the reservation alone would give.
    expect((await Bun.file(out).text()).trim().split("\n")).toEqual(["0xaaaaaa 1", "0xaaaaaa 8"]);
    expect(await Bun.file(path).json()).toEqual({ "0xaaaaaa": 15 });
  } finally {
    radio.close();
    await Bun.file(script).delete();
    await Bun.file(out).delete();
    await Bun.file(path).delete();
  }
});

/** The whole point of the endpoint: a controller's open/close/stop must reach the radio. */
test("controller commands reach the radio", async () => {
  const sent: { address: string; command: SomfyCommand }[] = [];
  const radio: Transmitter = {
    async send(address, command) {
      sent.push({ address, command });
    },
  };

  const shutter = { name: "Living Room", address: "0x123457" };
  const storage = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}`;
  const environment = new Environment("somfy-test", Environment.default);
  environment.vars.set("storage.path", storage);
  const node = await ServerNode.create({ id: "somfy-test", environment });
  const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
  await node.add(aggregator);

  try {
    await BridgedShutter.add(aggregator, radio, shutter, 0);
    const endpoint = aggregator.parts.get(endpointId(shutter))!;

    type Covering = {
      upOrOpen(): Promise<void>;
      downOrClose(): Promise<void>;
      stopMotion(): Promise<void>;
      goToLiftPercentage(request: { liftPercent100thsValue: number }): Promise<void>;
      state: { currentPositionLiftPercent100ths: number | null };
    };
    const covering = (agent: unknown) => (agent as { windowCovering: Covering }).windowCovering;
    const position = () => endpoint.act(agent => covering(agent).state.currentPositionLiftPercent100ths);

    // Never null: HomeKit has no "unknown" position and drops the accessory when it reads one.
    expect(await position()).toBe(INITIAL);

    await endpoint.act(agent => covering(agent).upOrOpen());
    expect(await position()).toBe(OPEN);
    await endpoint.act(agent => covering(agent).downOrClose());
    expect(await position()).toBe(CLOSED);
    await endpoint.act(agent => covering(agent).stopMotion());
    // A stop lands somewhere unknowable, so the last commanded position stands.
    expect(await position()).toBe(CLOSED);
    await endpoint.act(agent => covering(agent).goToLiftPercentage({ liftPercent100thsValue: 2_000 }));
    expect(await position()).toBe(OPEN);

    expect(sent).toEqual([
      { address: "0x123457", command: "up" },
      { address: "0x123457", command: "down" },
      { address: "0x123457", command: "my" },
      { address: "0x123457", command: "up" },
    ]);
  } finally {
    await node.close();
    await Bun.$`rm -rf ${storage}`.quiet();
  }
});

/** The position is written before the frame goes out, so a dead radio must not leave a lie behind. */
test("a failed transmission puts the position back", async () => {
  const radio: Transmitter = {
    async send() {
      throw new Error("no pigpiod");
    },
  };

  const shutter = { name: "Living Room", address: "0x123457" };
  const storage = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}`;
  const environment = new Environment("somfy-test", Environment.default);
  environment.vars.set("storage.path", storage);
  const node = await ServerNode.create({ id: "somfy-test", environment });
  const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
  await node.add(aggregator);

  try {
    await BridgedShutter.add(aggregator, radio, shutter, 0);
    const endpoint = aggregator.parts.get(endpointId(shutter))!;
    type Covering = { upOrOpen(): Promise<void>; state: { currentPositionLiftPercent100ths: number | null } };
    const covering = (agent: unknown) => (agent as { windowCovering: Covering }).windowCovering;

    // The command itself succeeds: the send is deliberately not awaited inside its transaction, and
    // matter.js would not surface the failure to the controller even if it were.
    await endpoint.act(agent => covering(agent).upOrOpen());

    const position = () => endpoint.act(agent => covering(agent).state.currentPositionLiftPercent100ths);
    // The correction lands in a transaction of its own, a tick or two later.
    for (let attempt = 0; (await position()) !== INITIAL && attempt < 50; attempt++) await Bun.sleep(10);
    expect(await position()).toBe(INITIAL);
  } finally {
    await node.close();
    await Bun.$`rm -rf ${storage}`.quiet();
  }
});
