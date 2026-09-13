/**
 * Minimal Google Smart Device Management (SDM) API client.
 *
 * Auth is the OAuth refresh-token flow: the refresh token lives in .env, access tokens are fetched
 * on demand and cached in memory until shortly before they expire.
 */

export const THERMOSTAT_TYPE = "sdm.devices.types.THERMOSTAT";

export type ThermostatMode = "OFF" | "HEAT" | "COOL" | "HEATCOOL";

/** Only the traits this bridge reads; SDM sends more. */
export interface SdmTraits {
  "sdm.devices.traits.Info"?: { customName?: string };
  "sdm.devices.traits.Temperature"?: { ambientTemperatureCelsius?: number };
  "sdm.devices.traits.Humidity"?: { ambientHumidityPercent?: number };
  "sdm.devices.traits.Connectivity"?: { status?: "ONLINE" | "OFFLINE" };
  "sdm.devices.traits.ThermostatMode"?: { mode?: ThermostatMode; availableModes?: ThermostatMode[] };
  "sdm.devices.traits.ThermostatEco"?: {
    mode?: "OFF" | "MANUAL_ECO";
    heatCelsius?: number;
    coolCelsius?: number;
  };
  "sdm.devices.traits.ThermostatHvac"?: { status?: "OFF" | "HEATING" | "COOLING" };
  "sdm.devices.traits.ThermostatTemperatureSetpoint"?: { heatCelsius?: number; coolCelsius?: number };
}

export interface SdmDevice {
  /** enterprises/{project}/devices/{id} */
  name: string;
  type: string;
  traits: SdmTraits;
  parentRelations?: { parent: string; displayName?: string }[];
}

const API = "https://smartdevicemanagement.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/**
 * Consent goes through Device Access rather than Google's usual OAuth screen: it is what links the
 * Nest account to the SDM project, and a token minted anywhere else cannot see the devices.
 */
const PARTNER_URL = "https://nestservices.google.com/partnerconnections";
/** Nothing listens here. The code is read out of the address bar after Google redirects. */
export const REDIRECT_URI = "https://www.google.com";

/** Where to send the browser to mint a refresh token for this project. */
export function authUrl(projectId: string, clientId: string) {
  const query = new URLSearchParams({
    redirect_uri: REDIRECT_URI,
    // offline for a refresh token at all; consent to be issued a new one rather than be told the
    // account has already granted access and handed an access token only.
    access_type: "offline",
    prompt: "consent",
    client_id: clientId,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/sdm.service",
  });
  return `${PARTNER_URL}/${projectId}/auth?${query}`;
}

/** The `code` out of a pasted redirect URL, or the code itself if that is what was pasted. */
export function authorizationCodeFrom(pasted: string) {
  const text = pasted.trim();
  if (!text) return "";
  // Google percent-encodes the code in the redirect, so take it through URLSearchParams.
  const query = text.match(/[?&]code=([^&\s]+)/);
  return query ? decodeURIComponent(query[1]!) : text;
}

/** Exchanges an authorization code for tokens. The refresh token is the one worth keeping. */
export async function exchangeCode(code: string, env: Record<string, string | undefined> = process.env) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = (await response.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${body.error} ${body.error_description ?? ""}`.trim());
  }
  return body;
}
/** A request that hangs must not stall the poll loop, nor keep the process alive on shutdown. */
const REQUEST_TIMEOUT_MS = 20_000;

export class SdmClient {
  readonly #projectId: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  /** Set when SDM_FIXTURE is configured: no network, no credentials, commands are logged only. */
  readonly #fixture?: string;
  readonly #aborter = new AbortController();
  #token?: { value: string; expiresAt: number };

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#fixture = env.SDM_FIXTURE;
    this.#projectId = env.SDM_PROJECT_ID ?? "";
    this.#clientId = env.GOOGLE_CLIENT_ID ?? "";
    this.#clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
    this.#refreshToken = env.GOOGLE_REFRESH_TOKEN ?? "";

    if (!this.#fixture) {
      const missing = (
        [
          ["SDM_PROJECT_ID", this.#projectId],
          ["GOOGLE_CLIENT_ID", this.#clientId],
          ["GOOGLE_CLIENT_SECRET", this.#clientSecret],
          ["GOOGLE_REFRESH_TOKEN", this.#refreshToken],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length) {
        throw new Error(`Missing Google credentials: ${missing.join(", ")} (or set SDM_FIXTURE)`);
      }
    }
  }

  get isFixture() {
    return this.#fixture !== undefined;
  }

  /**
   * Abort any request in flight. Without this a poll that is waiting on Google keeps the process
   * alive after the Matter node has shut down, so SIGTERM appears to hang.
   */
  close() {
    this.#aborter.abort(new Error("Bridge shutting down"));
  }

  get #signal() {
    return AbortSignal.any([this.#aborter.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  }

  async #accessToken() {
    if (this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      signal: this.#signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        refresh_token: this.#refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
    }
    const { access_token, expires_in } = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    // Refresh a minute early so an in-flight request never races the expiry.
    this.#token = { value: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
    return access_token;
  }

  async #request(path: string, init?: RequestInit) {
    const response = await fetch(`${API}/${path}`, {
      ...init,
      signal: this.#signal,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${await this.#accessToken()}`,
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`SDM ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  /** All thermostats visible to the authenticated user. */
  async listThermostats(): Promise<SdmDevice[]> {
    const { devices } = this.#fixture
      ? ((await Bun.file(this.#fixture).json()) as { devices?: SdmDevice[] })
      : ((await this.#request(`enterprises/${this.#projectId}/devices`)) as { devices?: SdmDevice[] });
    return (devices ?? []).filter(device => device.type === THERMOSTAT_TYPE);
  }

  /** POST .../{deviceName}:executeCommand */
  async executeCommand(deviceName: string, command: string, params: Record<string, unknown>) {
    if (this.#fixture) {
      console.log(`[fixture] ${command} ${JSON.stringify(params)} on ${deviceName.split("/").pop()}`);
      return;
    }
    await this.#request(`${deviceName}:executeCommand`, {
      method: "POST",
      body: JSON.stringify({ command, params }),
    });
  }
}
