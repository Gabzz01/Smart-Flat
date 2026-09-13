import { expect, test } from "bun:test";
import {
  authorizationCodeFrom,
  authUrl,
  cameraSerialOf,
  cameraTypeOf,
  codeChallenge,
  codeVerifier,
  deviceTypeOf,
  eventFrom,
  SimpliSafeClient,
  systemStateOf,
  videoUrl,
} from "./simplisafe.ts";
import { contactStateOf, entrySensors, motionSensors, motionSerialOf } from "./simplisafe-sensors.ts";
import { cameraUuidFrom } from "./simplisafe-stream.ts";

const client = new SimpliSafeClient({ SIMPLISAFE_FIXTURE: "fixtures/simplisafe.json" });
const systems = await client.systems();
const [home] = systems;
const sensors = await client.sensors(home!.sid);
const events = ((await Bun.file("fixtures/simplisafe.json").json()) as { events: never[] }).events;

test("an unrecognised device type keeps its id instead of failing", () => {
  // simplisafe-python raises on anything outside its enum, and one unnamed device takes the whole
  // account down with it. Here the number survives and the caller decides what to do.
  expect(deviceTypeOf(99)).toEqual({ id: 99, name: "unknown", known: false });
  expect(deviceTypeOf(5)).toEqual({ id: 5, name: "entry", known: true });
  expect(deviceTypeOf(undefined).known).toBe(false);
});

test("sensors with an unknown type are still returned, with their raw payload", () => {
  expect(sensors).toHaveLength(6);
  const mystery = sensors.find(sensor => sensor.serial === "5EEEE555")!;
  expect(mystery.type.id).toBe(99);
  expect(mystery.type.known).toBe(false);
  expect(mystery.name).toBe("Mystery Device");
  expect(mystery.raw.status).toEqual({ malfunction: false });
});

test("a camera is filed twice: in the subscription, and as a type-21 sensor under its uuid tail", () => {
  const garage = home!.cameras.find(camera => camera.name === "Garage")!;
  const asSensor = sensors.find(sensor => sensor.serial === cameraSerialOf(garage.uuid))!;
  expect(cameraSerialOf("cccccccc-3333-4333-8333-cccccccccccc")).toBe("cccccccc");
  expect(asSensor.type).toEqual({ id: 21, name: "indoor-camera", known: true });
  // type 21's `setting` is per-mode motion arming, not sensor state.
  expect(asSensor.raw.setting).toMatchObject({ off: 0, away: 1 });
});

test("sensor health flags default to false rather than undefined", () => {
  const keypad = sensors.find(sensor => sensor.serial === "4DDDD444")!;
  expect(keypad.offline).toBe(true);
  expect(keypad.lowBattery).toBe(false);
  expect(keypad.error).toBe(false);
});

test("the PKCE challenge matches Auth0's S256 of the verifier", async () => {
  // The RFC 7636 appendix B vector.
  expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const verifier = codeVerifier();
  expect(verifier).toMatch(/^[a-zA-Z0-9]{43,}$/);
});

test("the authorize URL carries the challenge and an uppercased device id", () => {
  const url = new URL(authUrl("CHALLENGE", "abcdef01-2345-6789-abcd-ef0123456789"));
  expect(url.origin + url.pathname).toBe("https://auth.simplisafe.com/authorize");
  expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("device_id")).toBe("ABCDEF01-2345-6789-ABCD-EF0123456789");
});

test("the authorization code is taken from the redirect URL people actually paste", () => {
  expect(authorizationCodeFrom("com.simplisafe.mobile://auth.simplisafe.com/ios/cb?code=abc123&state=x")).toBe(
    "abc123",
  );
  expect(authorizationCodeFrom("  abc123  ")).toBe("abc123");
});

test("subscriptions without a base station are skipped", () => {
  expect(systems.map(system => system.sid)).toEqual([4242424, 6464646]);
  expect(home!.state).toBe("OFF");
  expect(home!.serial).toBe("0000ABCD");
});

test("an empty address and a null temperature read as absent, not as \"\" and null", () => {
  // SimpliSafe sends "" for an address it holds no value for and null for a missing reading, so a
  // plain ?? leaks both through and a controller ends up showing "nullF".
  const bare = systems.find(system => system.sid === 6464646)!;
  expect(bare.temperature).toBeUndefined();
  expect(bare.address).toBeUndefined();
  expect(bare.name).toBe("6464646");
  expect(bare.serial).toBe("6464646");
  expect(home!.temperature).toBe(68);
});

test("an unfamiliar alarm state degrades to UNKNOWN instead of throwing", () => {
  expect(systemStateOf("away")).toBe("AWAY");
  expect(systemStateOf("SOMETHING_NEW")).toBe("UNKNOWN");
  expect(systemStateOf(undefined)).toBe("UNKNOWN");
});

test("cameras come from the subscription payload, and an unknown model degrades to unknown", () => {
  expect(home!.cameras.map(camera => camera.name)).toEqual(["Living Room", "Front Door", "Garage"]);
  expect(home!.cameras.map(camera => camera.type)).toEqual(["camera", "doorbell", "unknown"]);
  expect(cameraTypeOf("SSOBCM4")).toBe("outdoor-camera");
  // The Wireless Indoor Camera reports a name rather than an SS-code.
  expect(cameraTypeOf("scout")).toBe("camera");
  expect(cameraTypeOf(undefined)).toBe("unknown");
});

test("shutter settings read as booleans", () => {
  const living = home!.cameras[0]!;
  expect(living.shutterOpenWhenOff).toBe(false);
  expect(living.shutterOpenWhenHome).toBe(false);
  expect(living.shutterOpenWhenAway).toBe(true);
  // A camera whose settings block is missing is closed everywhere, not undefined.
  expect(home!.cameras[2]!.shutterOpenWhenAway).toBe(false);
});

test("a websocket payload becomes a typed event with media links", () => {
  const motion = eventFrom(events[0]!);
  expect(motion.type).toBe("camera_motion_detected");
  expect(motion.systemId).toBe(4242424);
  // SimpliSafe sends seconds, not milliseconds.
  expect(motion.timestamp.toISOString()).toBe("2025-08-30T00:05:45.000Z");
  expect(motion.mediaUrls?.imageUrl).toBe("https://media.simplisafe.example/snapshot.jpg");
  expect(motion.mediaUrls?.flvUrl).toBeUndefined();
  expect(eventFrom(events[1]!).mediaUrls).toBeUndefined();
});

test("an unmapped event code keeps its number", () => {
  const mystery = eventFrom(events[2]!);
  expect(mystery.type).toBe("unknown");
  expect(mystery.cid).toBe(4242);
  expect(mystery.sensorType).toEqual({ id: 21, name: "indoor-camera", known: true });
});

test("the media url carries width and audio encoding", () => {
  expect(videoUrl("cam-1")).toBe("https://media.simplisafe.com/v1/cam-1/flv?x=1280&audioEncoding=AAC");
  expect(videoUrl("cam-1", { width: 640 })).toContain("x=640");
});

// --------------------------------------------------------------------------------------------
// Matter mapping
// --------------------------------------------------------------------------------------------

test("a contact sensor is closed when SimpliSafe is not triggered, and open when it is", () => {
  // Matter's BooleanState is the inverse of SimpliSafe's `triggered`, and getting it backwards
  // makes every door read as open at rest.
  const front = sensors.find(sensor => sensor.name === "Front Door")!;
  const balcony = sensors.find(sensor => sensor.name === "Balcony Door")!;
  expect(front.triggered).toBe(true);
  expect(contactStateOf(front)).toBe(false);
  expect(contactStateOf(balcony)).toBe(true);
});

test("motion sensors carry no REST state at all, so they never look triggered", () => {
  // SimpliSafe sends `status: {}` for a motion sensor; its state exists only on the websocket.
  for (const sensor of motionSensors(sensors)) expect(sensor.triggered).toBe(false);
});

test("entry and motion sensors are selected by type, and the camera twin is left out", () => {
  expect(entrySensors(sensors).map(sensor => sensor.name)).toEqual(["Front Door", "Balcony Door"]);
  expect(motionSensors(sensors).map(sensor => sensor.name)).toEqual(["Hallway"]);
  // Type 21 is a camera the subscription payload already described; bridging it would double it.
  expect(motionSensors(sensors).some(sensor => sensor.type.id === 21)).toBe(false);
});

test("only motion-bearing events route to an occupancy endpoint", () => {
  expect(motionSerialOf(eventFrom(events[0]!))).toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
  // A doorbell press is not motion, and an unmapped code is not either.
  expect(motionSerialOf(eventFrom(events[1]!))).toBeUndefined();
  expect(motionSerialOf(eventFrom(events[2]!))).toBeUndefined();
});

test("the stream route accepts a camera uuid and nothing else", () => {
  expect(cameraUuidFrom("/camera/24ae55d73185676b2d48798df11f4d99")).toBe("24ae55d73185676b2d48798df11f4d99");
  expect(cameraUuidFrom("/camera/abc/")).toBe("abc");
  expect(cameraUuidFrom("/camera/")).toBeUndefined();
  expect(cameraUuidFrom("/camera/../etc/passwd")).toBeUndefined();
  expect(cameraUuidFrom("/")).toBeUndefined();
});
