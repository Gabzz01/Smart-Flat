/**
 * Local MQTT transport for a Dyson purifying fan.
 *
 * The fan is its own MQTT broker on port 1883. It is advertised over mDNS as
 * `<type>_<serial>._dyson_mqtt._tcp`, and the SRV record points at `<serial>.local`, which the
 * system resolver already handles — so discovery needs no library, just the hostname. Set
 * DYSON_HOST when the host has no mDNS resolver (most Linux boxes without avahi/nss-mdns).
 *
 * Auth is the serial as username plus the device's local password (base64 of a SHA-512 digest),
 * both from .env.
 */

import mqtt, { type MqttClient } from "mqtt";

/** product-state as the fan reports it: values are strings, or [old, new] in a STATE-CHANGE. */
export type RawState = Record<string, string | [string, string]>;
export type DysonState = Record<string, string>;

/** STATE-CHANGE reports [previous, current]; CURRENT-STATE reports the value alone. */
export function normalizeState(raw: RawState | undefined): DysonState {
  const state: DysonState = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    state[key] = Array.isArray(value) ? (value[1] ?? "") : value;
  }
  return state;
}

interface DysonMessage {
  msg?: string;
  "product-state"?: RawState;
  data?: RawState;
  [key: string]: unknown;
}

/** Environment data sits under "data" on some firmwares and flat on others; accept both. */
export function environmentOf(message: DysonMessage): DysonState {
  const { msg, time, data, ...rest } = { ...message, ...message.data };
  void msg;
  void time;
  void data;
  return normalizeState(rest as RawState);
}

const PORT = 1883;
const REFRESH_INTERVAL_MS = Number(process.env.DYSON_POLL_INTERVAL_MS ?? 30_000);

export class DysonClient {
  readonly serial: string;
  readonly #password: string;
  readonly #host: string;
  readonly #productType: string;
  /** Set when DYSON_FIXTURE is configured: no network, no credentials, commands are logged only. */
  readonly #fixture?: string;
  #client?: MqttClient;
  #refreshTimer?: ReturnType<typeof setInterval>;
  #closed = false;

  onState?: (state: DysonState) => void;
  onEnvironment?: (environment: DysonState) => void;
  onConnectionChange?: (connected: boolean) => void;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#fixture = env.DYSON_FIXTURE;
    this.serial = env.DYSON_SERIAL || (this.#fixture ? "FIXTURE-0001" : "");
    this.#password = env.DYSON_PASSWORD ?? "";
    this.#host = env.DYSON_HOST ?? `${this.serial}.local`;
    this.#productType = env.DYSON_PRODUCT_TYPE ?? "438K";

    if (!this.#fixture) {
      const missing = (
        [
          ["DYSON_SERIAL", this.serial],
          ["DYSON_PASSWORD", this.#password],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length) {
        throw new Error(`Missing Dyson credentials: ${missing.join(", ")} (or set DYSON_FIXTURE)`);
      }
    }
  }

  get isFixture() {
    return this.#fixture !== undefined;
  }

  get host() {
    return this.#host;
  }

  get productType() {
    return this.#productType;
  }

  get #commandTopic() {
    return `${this.#productType}/${this.serial}/command`;
  }

  async connect() {
    if (this.#fixture) {
      const { state, environment } = (await Bun.file(this.#fixture).json()) as {
        state?: DysonMessage;
        environment?: DysonMessage;
      };
      this.onConnectionChange?.(true);
      if (state) this.onState?.(normalizeState(state["product-state"]));
      if (environment) this.onEnvironment?.(environmentOf(environment));
      return;
    }

    const client = await mqtt.connectAsync(`mqtt://${this.#host}:${PORT}`, {
      username: this.serial,
      password: this.#password,
      protocolVersion: 4, // the fan speaks MQTT 3.1.1 only
      clientId: `matter-bridge-${crypto.randomUUID().slice(0, 8)}`,
      keepalive: 30,
      reconnectPeriod: 10_000,
    });
    this.#client = client;

    client.on("message", (_topic, payload) => this.#handle(payload));
    client.on("connect", () => {
      this.onConnectionChange?.(true);
      void this.refresh();
    });
    client.on("close", () => this.onConnectionChange?.(false));
    client.on("error", error => {
      if (!this.#closed) console.error(`Dyson ${this.serial}: MQTT error:`, error);
    });

    // No wildcards: the fan's broker refuses any topic filter outside its own two topics, so the
    // product type has to be exactly right. A refused subscription is what a wrong one looks like.
    const topic = `${this.#productType}/${this.serial}/status/current`;
    try {
      await client.subscribeAsync(topic);
    } catch (error) {
      throw new Error(
        `Subscribing to ${topic} was refused. Set DYSON_PRODUCT_TYPE to the fan's actual type ` +
          `(438/438E/438K for a Purifier Cool, 527/527E/527K for a Hot+Cool). Cause: ${String(error)}`,
      );
    }
    this.onConnectionChange?.(true);
    this.refresh();

    this.#refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    // A pending refresh is not a reason to keep the process alive.
    this.#refreshTimer.unref();
  }

  #handle(payload: Buffer) {
    let message: DysonMessage;
    try {
      message = JSON.parse(payload.toString()) as DysonMessage;
    } catch (error) {
      console.error(`Dyson ${this.serial}: unparsable message:`, error);
      return;
    }

    switch (message.msg) {
      case "CURRENT-STATE":
      case "STATE-CHANGE":
        this.onState?.(normalizeState(message["product-state"]));
        break;
      case "ENVIRONMENTAL-CURRENT-SENSOR-DATA":
        this.onEnvironment?.(environmentOf(message));
        break;
    }
  }

  #publish(message: Record<string, unknown>) {
    if (this.#fixture) {
      console.log(`[fixture] ${JSON.stringify(message)}`);
      return;
    }
    this.#client?.publish(this.#commandTopic, JSON.stringify({ ...message, time: new Date().toISOString() }));
  }

  /** Ask for state and sensor readings. The fan pushes changes itself, but sensors only on request. */
  refresh() {
    this.#publish({ msg: "REQUEST-CURRENT-STATE" });
    this.#publish({ msg: "REQUEST-PRODUCT-ENVIRONMENT-CURRENT-SENSOR-DATA" });
  }

  /** Apply a product-state patch, e.g. { fpwr: "ON", fnsp: "0005" }. */
  setState(data: DysonState) {
    if (!Object.keys(data).length) return;
    this.#publish({ msg: "STATE-SET", "mode-reason": "LAPP", data });
  }

  /**
   * Drop the connection. The MQTT socket is an event-loop anchor, so without this SIGTERM appears
   * to hang once the Matter node is offline.
   */
  close() {
    this.#closed = true;
    clearInterval(this.#refreshTimer);
    this.#client?.end(true);
  }
}
