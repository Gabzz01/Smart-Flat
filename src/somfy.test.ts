import { expect, test } from "bun:test";
import { Endpoint, Environment, ServerNode } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { MovementDirection } from "@matter/main/behaviors/window-covering";
import { defaultScript, parseShutters, SomfyRadio, type SomfyCommand, type Transmitter } from "./somfy.ts";
import { BridgedShutter, commandFor, endpointId } from "./somfy-shutter.ts";

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
  expect(commandFor(MovementDirection.Open, false)).toBe("up");
  expect(commandFor(MovementDirection.Close, false)).toBe("down");
  expect(commandFor(MovementDirection.Open, true)).toBe("down");
  expect(commandFor(MovementDirection.Close, true)).toBe("up");
  // Needs a position-aware feature to arise, and there is no position to resolve it with.
  expect(commandFor(MovementDirection.DefinedByPosition, false)).toBeUndefined();
});

/** One radio and one pigpio waveform: two overlapping transmissions make a frame nothing decodes. */
test("transmissions are queued, never overlapped", async () => {
  const log = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}.log`;
  const script = `${log}.sh`;
  // Stands in for somfy-tx.py: brackets its run in the log so an overlap is visible.
  await Bun.write(script, `echo "start $SOMFY_ADDR $1" >> ${log}\nsleep 0.1\necho "end $SOMFY_ADDR $1" >> ${log}\n`);
  const radio = new SomfyRadio({ SOMFY_PYTHON: "/bin/sh", SOMFY_SCRIPT: script });

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
  }
});

test("a failed transmission is reported and does not wedge the queue", async () => {
  const script = `${import.meta.dir}/../.matter-storage/test-somfy-${crypto.randomUUID()}.sh`;
  await Bun.write(script, 'test "$1" = up && { echo "no pigpiod" >&2; exit 3; }\necho ok\n');
  const radio = new SomfyRadio({ SOMFY_PYTHON: "/bin/sh", SOMFY_SCRIPT: script });

  try {
    expect(radio.send("0xaaaaaa", "up")).rejects.toThrow(/exited 3: no pigpiod/);
    await radio.send("0xaaaaaa", "down");
  } finally {
    radio.close();
    await Bun.file(script).delete();
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

    await endpoint.act(agent => (agent as unknown as { windowCovering: { upOrOpen(): Promise<void> } }).windowCovering.upOrOpen());
    await endpoint.act(agent => (agent as unknown as { windowCovering: { downOrClose(): Promise<void> } }).windowCovering.downOrClose());
    await endpoint.act(agent => (agent as unknown as { windowCovering: { stopMotion(): Promise<void> } }).windowCovering.stopMotion());

    expect(sent).toEqual([
      { address: "0x123457", command: "up" },
      { address: "0x123457", command: "down" },
      { address: "0x123457", command: "my" },
    ]);
  } finally {
    await node.close();
    await Bun.$`rm -rf ${storage}`.quiet();
  }
});
