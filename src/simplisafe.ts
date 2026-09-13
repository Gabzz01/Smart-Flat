/**
 * Minimal SimpliSafe cloud client: a TypeScript reimplementation of the useful third of
 * bachya/simplisafe-python.
 *
 * Auth is Auth0 authorization-code + PKCE. There is no username/password API, so the login happens
 * once in a browser (`bun run simplisafe-auth`) and the resulting refresh token is what the bridge
 * keeps. SimpliSafe hands back a *new* refresh token on every refresh, so unlike the Google one it
 * cannot live in .env alone: it is persisted next to the Matter fabric state and rewritten in place.
 *
 * Nothing here maps to Matter yet. Reads are the subscription list (which is also where cameras
 * live), the sensor list, and the realtime websocket; the only write is arm/disarm.
 */

const API = "https://api.simplisafe.com/v1";
const AUTH = "https://auth.simplisafe.com";
const MEDIA = "https://media.simplisafe.com/v1";
const SOCKET = "wss://socketlink.prd.aser.simplisafe.com";

/** The iOS app's public Auth0 client. SimpliSafe issues no client of our own. */
const CLIENT_ID = "42aBZ5lYrVW12jfOuu3CQROitwxg9sN5";
const REDIRECT_URI = "com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback";
const SCOPE = "offline_access email openid https://api.simplisafe.com/scopes/user:platform";
/** Base64 of the Auth0.swift client descriptor the app sends; the authorize endpoint wants it. */
const AUTH0_CLIENT =
  "eyJ2ZXJzaW9uIjoiMi4zLjIiLCJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsic3dpZnQiOiI1LngiLCJpT1MiOiIxNi4zIn19";
/** SimpliSafe answers 403 to anything that does not look like a browser. Send exactly this. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15";

/** A request that hangs must not stall the poll loop, nor keep the process alive on shutdown. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A base station syncing with the cloud answers 409 until it is done. */
const CONFLICT_RETRIES = 3;
/** No message for this long means the socket is wedged even though it still looks open. */
const WATCHDOG_MS = 5 * 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const DEFAULT_TOKEN_PATH = () => `${process.env.MATTER_STORAGE_PATH ?? ".matter-storage"}/simplisafe-token.json`;

// --------------------------------------------------------------------------------------------
// PKCE
// --------------------------------------------------------------------------------------------

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A fresh PKCE verifier. Auth0 accepts only unreserved characters, so the padding is stripped. */
export function codeVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(40))).replace(/[^a-zA-Z0-9]+/g, "");
}

/** The S256 challenge Auth0 expects for a given verifier. */
export async function codeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The URL to open in a browser. `deviceId` only labels the session in SimpliSafe's account page. */
export function authUrl(challenge: string, deviceId: string = crypto.randomUUID()) {
  const params = new URLSearchParams({
    audience: "https://api.simplisafe.com/",
    auth0Client: AUTH0_CLIENT,
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    device: "iPhone",
    device_id: deviceId.toUpperCase(),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
  });
  return `${AUTH}/authorize?${params}`;
}

/**
 * The `code` query parameter out of the redirect the browser refuses to follow. Accepts the whole
 * `com.simplisafe.mobile://...?code=...` URL or a bare code, since people paste both.
 */
export function authorizationCodeFrom(input: string) {
  const trimmed = input.trim();
  const match = /[?&]code=([^&\s]+)/.exec(trimmed);
  return match ? decodeURIComponent(match[1]!) : trimmed;
}

// --------------------------------------------------------------------------------------------
// Device, camera and system vocabulary
// --------------------------------------------------------------------------------------------

/**
 * SimpliSafe's internal device type ids. Unlisted ids are not an error: SimpliSafe ships hardware
 * faster than anyone documents it, and a sensor we cannot name is still a sensor we can report.
 * `deviceTypeOf` keeps the number, so the next one costs a line here instead of an outage.
 */
const DEVICE_TYPE_NAMES: Record<number, string> = {
  0: "remote",
  1: "keypad",
  2: "keychain",
  3: "panic-button",
  4: "motion",
  5: "entry",
  6: "glass-break",
  7: "carbon-monoxide",
  8: "smoke",
  9: "leak",
  10: "temperature",
  12: "camera",
  13: "siren",
  14: "smoke-and-carbon-monoxide",
  15: "doorbell",
  16: "lock",
  17: "outdoor-camera",
  20: "motion-v2",
  // The base station registers a camera as a device too, alongside its entry in the subscription
  // payload: the serial is the last eight hex characters of the camera's uuid, and `setting` holds
  // per-mode motion arming rather than sensor state. `cameraSerialOf` pairs the two back up.
  21: "indoor-camera",
  22: "outdoor-alarm-security-bell-box",
  253: "lock-keypad",
};

export interface DeviceType {
  id: number;
  name: string;
  known: boolean;
}

/** Never throws and never collapses the id: an unrecognised type is reported, not swallowed. */
export function deviceTypeOf(id: number | undefined): DeviceType {
  if (typeof id !== "number") return { id: -1, name: "unknown", known: false };
  const name = DEVICE_TYPE_NAMES[id];
  return name ? { id, name, known: true } : { id, name: "unknown", known: false };
}

export type CameraType = "camera" | "doorbell" | "outdoor-camera" | "unknown";

const CAMERA_MODELS: Record<string, CameraType> = {
  SS001: "camera",
  SS002: "doorbell",
  SS003: "camera",
  SSOBCM4: "outdoor-camera",
  // The Wireless Indoor Camera reports a name, not an SS-code.
  scout: "camera",
};

/**
 * The serial the base station files a camera under: the last eight hex characters of its uuid. The
 * same camera therefore appears twice — once in the subscription payload, once as a type-21 sensor.
 */
export function cameraSerialOf(uuid: string) {
  return uuid.slice(-8);
}

export function cameraTypeOf(model: string | undefined): CameraType {
  return (model && CAMERA_MODELS[model]) || "unknown";
}

export const SYSTEM_STATES = [
  "ALARM",
  "ALARM_COUNT",
  "AWAY",
  "AWAY_COUNT",
  "ENTRY_DELAY",
  "ERROR",
  "EXIT_DELAY",
  "HOME",
  "HOME_COUNT",
  "OFF",
  "TEST",
  "UNKNOWN",
] as const;
export type SystemState = (typeof SYSTEM_STATES)[number];

/** The API reports state as a free-form string; an unfamiliar one is UNKNOWN, not a crash. */
export function systemStateOf(raw: string | undefined): SystemState {
  const upper = (raw ?? "").toUpperCase();
  return (SYSTEM_STATES as readonly string[]).includes(upper) ? (upper as SystemState) : "UNKNOWN";
}

// --------------------------------------------------------------------------------------------
// Websocket events
// --------------------------------------------------------------------------------------------

/** SimpliSafe's contact-ID event codes. Ported verbatim from simplipy/websocket.py. */
const EVENT_NAMES: Record<number, string> = {
  1110: "alarm_triggered",
  1120: "alarm_triggered",
  1132: "alarm_triggered",
  1134: "alarm_triggered",
  1154: "alarm_triggered",
  1159: "alarm_triggered",
  1162: "alarm_triggered",
  1170: "camera_motion_detected",
  1301: "power_outage",
  1344: "rf_interference_detected",
  1350: "connection_lost",
  1381: "sensor_not_responding",
  1400: "disarmed_by_keypad",
  1406: "alarm_canceled",
  1407: "disarmed_by_remote",
  1409: "secret_alert_triggered",
  1429: "entry_delay",
  1458: "doorbell_detected",
  1531: "sensor_paired_and_named",
  1601: "user_initiated_test",
  1602: "automatic_test",
  1604: "device_test",
  1609: "user_initiated_camera_recording",
  3301: "power_restored",
  3344: "rf_interference_stopped",
  3350: "connection_restored",
  3381: "sensor_restored",
  3401: "armed_away_by_keypad",
  3407: "armed_away_by_remote",
  3441: "armed_home",
  3481: "armed_away",
  3487: "armed_away",
  3491: "armed_home",
  9401: "away_exit_delay_by_keypad",
  9407: "away_exit_delay_by_remote",
  9441: "home_exit_delay",
  9700: "lock_unlocked",
  9701: "lock_locked",
  9703: "lock_error",
  9903: "base_station_update_succeeded",
};

export interface MediaUrls {
  imageUrl?: string;
  clipUrl?: string;
  hlsUrl?: string;
  flvUrl?: string;
}

export interface SimpliSafeEvent {
  /** The contact-ID code. Kept even when unmapped, so a new event type can be identified. */
  cid: number;
  /** The mapped name, or "unknown" for a code SimpliSafe has not documented to anyone. */
  type: string;
  info: string;
  systemId: number;
  timestamp: Date;
  changedBy?: string;
  sensorName?: string;
  sensorSerial?: string;
  sensorType?: DeviceType;
  mediaUrls?: MediaUrls;
}

interface RawEventPayload {
  type?: string;
  data?: {
    eventCid?: number;
    info?: string;
    sid?: number;
    eventTimestamp?: number;
    pinName?: string;
    sensorName?: string;
    sensorSerial?: string;
    sensorType?: number;
    videoStartedBy?: string;
    video?: Record<string, { _links?: Record<string, { href?: string } | undefined> }>;
  };
}

function mediaUrlsFrom(data: NonNullable<RawEventPayload["data"]>): MediaUrls | undefined {
  const uuid = data.videoStartedBy;
  const links = uuid ? data.video?.[uuid]?._links : undefined;
  if (!links) return undefined;
  return {
    imageUrl: links["snapshot/jpg"]?.href,
    clipUrl: links["download/mp4"]?.href,
    hlsUrl: links["playback/hls"]?.href,
    flvUrl: links["playback/flv"]?.href,
  };
}

/** Turns one `com.simplisafe.event.standard` frame into an event. Tolerant of every field. */
export function eventFrom(payload: RawEventPayload): SimpliSafeEvent {
  const data = payload.data ?? {};
  const cid = data.eventCid ?? -1;
  return {
    cid,
    type: EVENT_NAMES[cid] ?? "unknown",
    info: data.info ?? "",
    systemId: data.sid ?? -1,
    // SimpliSafe sends seconds since the epoch.
    timestamp: new Date((data.eventTimestamp ?? 0) * 1000),
    changedBy: data.pinName || undefined,
    sensorName: data.sensorName || undefined,
    sensorSerial: data.sensorSerial || undefined,
    sensorType: data.sensorType === undefined ? undefined : deviceTypeOf(data.sensorType),
    mediaUrls: mediaUrlsFrom(data),
  };
}

/** The live FLV stream for a camera. Needs the bearer token, so fetch it through `media()`. */
export function videoUrl(uuid: string, { width = 1280, audioEncoding = "AAC" } = {}) {
  return `${MEDIA}/${uuid}/flv?${new URLSearchParams({ x: String(width), audioEncoding })}`;
}

// --------------------------------------------------------------------------------------------
// Domain types
// --------------------------------------------------------------------------------------------

export interface Camera {
  uuid: string;
  name: string;
  model: string;
  type: CameraType;
  status: string;
  subscriptionEnabled: boolean;
  /** The privacy shutter per system state. `"open"` means the lens can see. */
  shutterOpenWhenOff: boolean;
  shutterOpenWhenHome: boolean;
  shutterOpenWhenAway: boolean;
}

export interface Notification {
  id: string;
  text: string;
  category: string;
  code: string;
  timestamp: Date;
}

export interface System {
  sid: number;
  version: number;
  name: string;
  serial: string;
  state: SystemState;
  alarmGoingOff: boolean;
  isOffline: boolean;
  powerOutage: boolean;
  address?: string;
  /** Base-station temperature in °F, as SimpliSafe reports it. Absent on some plans. */
  temperature?: number;
  cameras: Camera[];
  notifications: Notification[];
}

export interface Sensor {
  serial: string;
  name: string;
  type: DeviceType;
  /**
   * Entry sensors report this as open/closed and it is the only live state the REST API carries.
   * Motion sensors send an empty `status` block, so theirs is always false: their state exists
   * only as websocket events, and only while the system is armed.
   */
  triggered: boolean;
  error: boolean;
  lowBattery: boolean;
  offline: boolean;
  /** The untouched payload, so a sensor whose type we cannot name is still fully inspectable. */
  raw: Record<string, unknown>;
}

export type ArmState = "off" | "home" | "away";

// --------------------------------------------------------------------------------------------
// Wire types
// --------------------------------------------------------------------------------------------

interface RawCamera {
  uuid?: string;
  model?: string;
  status?: string;
  subscription?: { enabled?: boolean };
  cameraSettings?: { cameraName?: string; shutterOff?: string; shutterHome?: string; shutterAway?: string };
}

interface RawMessage {
  id?: string;
  text?: string;
  category?: string;
  code?: string;
  timestamp?: number;
}

interface RawSubscription {
  sid?: number;
  status?: { hasBaseStation?: boolean };
  location?: {
    street1?: string;
    system?: {
      version?: number;
      serial?: string;
      alarmState?: string;
      isAlarming?: boolean;
      isOffline?: boolean;
      powerOutage?: boolean;
      temperature?: number | null;
      cameras?: RawCamera[];
      messages?: RawMessage[];
    };
  };
}

interface RawSensor {
  serial?: string;
  name?: string;
  type?: number;
  status?: { malfunction?: boolean; triggered?: boolean };
  flags?: { lowBattery?: boolean; offline?: boolean };
  [key: string]: unknown;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** Saved payloads, so the client, the tests and `check-simplisafe` run with no account. */
interface Fixture {
  authCheck?: { userId?: number };
  subscriptions?: RawSubscription[];
  /** Keyed by subscription id, as a string, because JSON keys are strings. */
  sensors?: Record<string, RawSensor[]>;
  /** Raw websocket frames, replayed by the tests and by `check-simplisafe --watch`. */
  events?: RawEventPayload[];
}

// --------------------------------------------------------------------------------------------
// Token exchange and storage
// --------------------------------------------------------------------------------------------

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(`${AUTH}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`SimpliSafe token request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

/** Exchange the one-time authorization code from the browser redirect for tokens. */
export function exchangeCode(code: string, verifier: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code_verifier: verifier,
    code,
    redirect_uri: REDIRECT_URI,
  });
}

export function refreshTokens(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken });
}

export function tokenStorePath() {
  return DEFAULT_TOKEN_PATH();
}

/**
 * Whether SimpliSafe is configured at all. The token normally lives in the store rather than the
 * environment, so presence of the file counts — `size` is 0 for a file that does not exist.
 */
export function isConfigured(env: Record<string, string | undefined> = process.env) {
  if (env.SIMPLISAFE_FIXTURE || env.SIMPLISAFE_REFRESH_TOKEN) return true;
  const path = env.SIMPLISAFE_TOKEN_PATH ?? `${env.MATTER_STORAGE_PATH ?? ".matter-storage"}/simplisafe-token.json`;
  return Bun.file(path).size > 0;
}

export async function saveRefreshToken(refreshToken: string, path = DEFAULT_TOKEN_PATH()) {
  await Bun.write(path, JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() }, null, 2));
  return path;
}

export async function loadRefreshToken(path = DEFAULT_TOKEN_PATH()) {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const { refreshToken } = (await file.json()) as { refreshToken?: string };
  return refreshToken || undefined;
}

// --------------------------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------------------------

export class SimpliSafeClient {
  /** Set when SIMPLISAFE_FIXTURE is configured: no network, no credentials, writes are logged. */
  readonly #fixturePath?: string;
  readonly #tokenPath: string;
  readonly #envRefreshToken: string;
  readonly #aborter = new AbortController();
  #fixture?: Fixture;
  #refreshToken?: string;
  #token?: { value: string; expiresAt: number };
  #userId?: number;
  #closed = false;

  #socket?: WebSocket;
  #watchdog?: ReturnType<typeof setTimeout>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #reconnectDelay = RECONNECT_MIN_MS;

  /** Realtime callbacks, in the shape DysonClient uses: assignable, not an emitter. */
  onEvent?: (event: SimpliSafeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#fixturePath = env.SIMPLISAFE_FIXTURE;
    this.#tokenPath = env.SIMPLISAFE_TOKEN_PATH ?? `${env.MATTER_STORAGE_PATH ?? ".matter-storage"}/simplisafe-token.json`;
    this.#envRefreshToken = env.SIMPLISAFE_REFRESH_TOKEN ?? "";

    // `size` is 0 for a file that does not exist, which is the only check a constructor can do
    // without going async. The token itself is read lazily.
    const hasStoredToken = Bun.file(this.#tokenPath).size > 0;
    if (!this.#fixturePath && !this.#envRefreshToken && !hasStoredToken) {
      throw new Error(
        "Missing SimpliSafe credentials: no SIMPLISAFE_REFRESH_TOKEN and no token at " +
          `${this.#tokenPath}. Run \`bun run simplisafe-auth\` (or set SIMPLISAFE_FIXTURE).`,
      );
    }
  }

  get isFixture() {
    return this.#fixturePath !== undefined;
  }

  get tokenPath() {
    return this.#tokenPath;
  }

  /**
   * Abort anything in flight and drop the socket. Without this a poll waiting on SimpliSafe — or
   * the open websocket — keeps the process alive after the Matter node has shut down.
   */
  close() {
    this.#closed = true;
    clearTimeout(this.#watchdog);
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = undefined;
    this.#aborter.abort(new Error("Bridge shutting down"));
  }

  get #signal() {
    return AbortSignal.any([this.#aborter.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  }

  async #loadFixture() {
    this.#fixture ??= (await Bun.file(this.#fixturePath!).json()) as Fixture;
    return this.#fixture;
  }

  async #currentRefreshToken() {
    this.#refreshToken ??= (await loadRefreshToken(this.#tokenPath)) ?? this.#envRefreshToken;
    if (!this.#refreshToken) throw new Error("No SimpliSafe refresh token; run `bun run simplisafe-auth`");
    return this.#refreshToken;
  }

  /** Mints an access token, persisting the rotated refresh token before the caller sees anything. */
  async #accessToken(force = false) {
    if (!force && this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;

    const tokens = await refreshTokens(await this.#currentRefreshToken());
    if (tokens.refresh_token && tokens.refresh_token !== this.#refreshToken) {
      // SimpliSafe rotates on every refresh. Persist before returning: a crash between here and
      // the next call would otherwise leave the stored token already spent, and re-auth by hand.
      this.#refreshToken = tokens.refresh_token;
      await saveRefreshToken(tokens.refresh_token, this.#tokenPath);
    }
    // Refresh a minute early so an in-flight request never races the expiry.
    this.#token = { value: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
    return tokens.access_token;
  }

  /**
   * SimpliSafe sometimes answers `application/json` with a bare quoted string (`"Unauthorized"`),
   * which parses as JSON but is not an object. Fold that into the error text instead of returning it.
   */
  static #parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }

  async #request<T>(path: string, init: RequestInit = {}, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let refreshed = false;
    for (let conflicts = 0; ; ) {
      const response = await fetch(url, {
        ...init,
        signal: this.#signal,
        headers: {
          ...init.headers,
          authorization: `Bearer ${await this.#accessToken(refreshed)}`,
          "content-type": "application/json; charset=utf-8",
          "user-agent": USER_AGENT,
        },
      });

      if (response.ok) {
        const body = await response.text();
        return (body ? SimpliSafeClient.#parse(body) : {}) as T;
      }

      // A stale access token: refresh once and retry. Twice would just be a credential problem.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      // The base station synchronises itself with the cloud on its own schedule and answers 409
      // while it does. Waiting it out is the only option.
      if (response.status === 409 && conflicts < CONFLICT_RETRIES) {
        conflicts += 1;
        await Bun.sleep(500 * 2 ** conflicts);
        continue;
      }
      throw new Error(`SimpliSafe ${path} failed: ${response.status} ${await response.text()}`);
    }
  }

  async #currentUserId() {
    if (this.#fixturePath) return (await this.#loadFixture()).authCheck?.userId ?? 0;
    this.#userId ??= (await this.#request<{ userId?: number }>("api/authCheck")).userId;
    if (this.#userId === undefined) throw new Error("SimpliSafe authCheck returned no userId");
    return this.#userId;
  }

  /**
   * Every active system on the account, cameras included: SimpliSafe ships camera data inside the
   * subscription payload rather than with the other devices, so this one call covers both.
   */
  async systems(): Promise<System[]> {
    const subscriptions = this.#fixturePath
      ? ((await this.#loadFixture()).subscriptions ?? [])
      : (
          await this.#request<{ subscriptions?: RawSubscription[] }>(
            `users/${await this.#currentUserId()}/subscriptions`,
            {},
            { activeOnly: "true" },
          )
        ).subscriptions ?? [];

    const systems: System[] = [];
    for (const subscription of subscriptions) {
      const system = subscription.location?.system;
      // A subscription with no base station, or no system block at all, has nothing to read.
      if (!subscription.sid || !system || !subscription.status?.hasBaseStation) continue;
      systems.push({
        sid: subscription.sid,
        version: system.version ?? 3,
        // SimpliSafe sends "" for an address it has no value for, and null for a missing reading,
        // so `||` and `?? undefined` both earn their keep over a plain `??`.
        name: subscription.location?.street1 || String(subscription.sid),
        serial: system.serial || String(subscription.sid),
        state: systemStateOf(system.alarmState),
        alarmGoingOff: system.isAlarming ?? false,
        isOffline: system.isOffline ?? false,
        powerOutage: system.powerOutage ?? false,
        address: subscription.location?.street1 || undefined,
        temperature: system.temperature ?? undefined,
        cameras: (system.cameras ?? [])
          .filter(camera => camera.uuid)
          .map(camera => ({
            uuid: camera.uuid!,
            name: camera.cameraSettings?.cameraName ?? camera.uuid!,
            model: camera.model ?? "",
            type: cameraTypeOf(camera.model),
            status: camera.status ?? "unknown",
            subscriptionEnabled: camera.subscription?.enabled ?? false,
            shutterOpenWhenOff: camera.cameraSettings?.shutterOff === "open",
            shutterOpenWhenHome: camera.cameraSettings?.shutterHome === "open",
            shutterOpenWhenAway: camera.cameraSettings?.shutterAway === "open",
          })),
        notifications: (system.messages ?? [])
          .filter(message => message.id)
          .map(message => ({
            id: message.id!,
            text: message.text ?? "",
            category: message.category ?? "",
            code: message.code ?? "",
            timestamp: new Date((message.timestamp ?? 0) * 1000),
          })),
      });
    }
    return systems;
  }

  /**
   * Every sensor paired to a system. Rows whose type we cannot name are returned anyway, with the
   * raw payload attached — this is the whole point: simplisafe-python treats an unlisted type as an
   * error, and one unrecognised device takes the rest of the account down with it.
   */
  async sensors(sid: number): Promise<Sensor[]> {
    const raw = this.#fixturePath
      ? ((await this.#loadFixture()).sensors?.[String(sid)] ?? [])
      : (
          await this.#request<{ sensors?: RawSensor[] }>(
            `ss3/subscriptions/${sid}/sensors`,
            {},
            // Cached deliberately. forceUpdate=true makes the base station go and read every sensor
            // before answering, which measured slower than the 20s request timeout and is plainly
            // not something to do on a loop. The cached view trails the real door by 5-10s, which
            // is the accuracy ceiling here — see the poll interval in index.ts.
            { forceUpdate: "false" },
          )
        ).sensors ?? [];

    return raw
      .filter(sensor => sensor.serial)
      .map(sensor => ({
        serial: sensor.serial!,
        name: sensor.name || sensor.serial!,
        type: deviceTypeOf(sensor.type),
        triggered: sensor.status?.triggered === true,
        error: sensor.status?.malfunction ?? false,
        lowBattery: sensor.flags?.lowBattery ?? false,
        offline: sensor.flags?.offline ?? false,
        raw: sensor as Record<string, unknown>,
      }));
  }

  /** Arm or disarm. The only write this client makes. */
  async setState(sid: number, state: ArmState) {
    if (this.#fixturePath) {
      console.log(`[fixture] set system ${sid} to ${state}`);
      return;
    }
    await this.#request(`ss3/subscriptions/${sid}/state/${state}`, { method: "POST" });
  }

  /** Fetch a snapshot or clip — something finite. A live stream never ends; use `stream`. */
  async media(url: string): Promise<Uint8Array> {
    const response = await this.stream(url);
    if (!response.ok) throw new Error(`SimpliSafe media failed: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Open a media URL and hand back the response unread, so a live stream can be piped straight
   * through. Deliberately not on `#signal`: its 20s timeout would cut an FLV stream off mid-frame.
   * Pass the consumer's own signal so a viewer hanging up closes the upstream too.
   */
  async stream(url: string, signal?: AbortSignal): Promise<Response> {
    return fetch(url, {
      signal: signal ? AbortSignal.any([this.#aborter.signal, signal]) : this.#aborter.signal,
      headers: { authorization: `Bearer ${await this.#accessToken()}`, "user-agent": USER_AGENT },
    });
  }

  // ------------------------------------------------------------------------------------------
  // Realtime
  // ------------------------------------------------------------------------------------------

  /**
   * Subscribe to the event stream. Motion, doorbell presses and alarms arrive here and nowhere
   * else — the REST API reports arm state and settings, never the moment something happened.
   */
  async connect() {
    if (this.#closed) return;

    if (this.#fixturePath) {
      // Replay the saved frames so the whole path can be exercised with no account.
      this.onConnectionChange?.(true);
      for (const payload of (await this.#loadFixture()).events ?? []) this.onEvent?.(eventFrom(payload));
      return;
    }

    // The identify frame carries the access token, so it has to be fresh at connect time.
    const token = await this.#accessToken();
    const userId = await this.#currentUserId();
    const socket = new WebSocket(SOCKET);
    this.#socket = socket;

    socket.onopen = () => {
      const now = new Date();
      socket.send(
        JSON.stringify({
          datacontenttype: "application/json",
          type: "com.simplisafe.connection.identify",
          time: `${now.toISOString().slice(0, -1)}Z`,
          id: `ts:${now.getTime()}`,
          specversion: "1.0",
          source: USER_AGENT,
          data: { auth: { schema: "bearer", token }, join: [`uid:${userId}`] },
        }),
      );
      this.#reconnectDelay = RECONNECT_MIN_MS;
      this.#petWatchdog();
      this.onConnectionChange?.(true);
    };

    socket.onmessage = message => {
      this.#petWatchdog();
      let payload: RawEventPayload;
      try {
        payload = JSON.parse(String(message.data)) as RawEventPayload;
      } catch (error) {
        console.error("SimpliSafe: unparsable websocket message:", error);
        return;
      }
      if (payload.type === "com.simplisafe.event.standard") this.onEvent?.(eventFrom(payload));
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where the reconnect lives.
    };

    socket.onclose = () => {
      this.onConnectionChange?.(false);
      this.#scheduleReconnect();
    };
  }

  #petWatchdog() {
    clearTimeout(this.#watchdog);
    if (this.#closed || this.#fixturePath) return;
    // SimpliSafe can leave a socket open but silent. Nothing for five minutes means reconnect.
    this.#watchdog = setTimeout(() => this.#socket?.close(), WATCHDOG_MS);
    this.#watchdog.unref();
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      void this.connect().catch(error => {
        if (!this.#closed) console.error("SimpliSafe websocket reconnect failed:", error);
        this.#scheduleReconnect();
      });
    }, delay);
    // A pending reconnect is not a reason to keep the process alive.
    this.#reconnectTimer.unref();
  }
}
