# matter-bridge

A Matter bridge for devices that speak everything except Matter: Google Nest thermostats (via the
Smart Device Management API), a Dyson purifying fan (via its local MQTT broker), an Octopus Energy
account's smart meters (via the Octopus REST API) and a SimpliSafe alarm's sensors and cameras (via
the SimpliSafe cloud). Any Matter controller — Apple Home, Alexa, Home Assistant — reads and
controls them natively.

Each Nest device becomes two bridged endpoints — a thermostat and a humidity sensor — added
directly to the aggregator, so every endpoint carries exactly one device type. Ambient temperature
gets no endpoint of its own: the Thermostat cluster already reports it as `localTemperature`, and a
separate thermometer only counts the same room twice in a controller's climate summary. State is
polled from Google every 60s; mode, setpoint and Eco changes made from a controller are
pushed back with `ThermostatMode.SetMode`, `ThermostatTemperatureSetpoint.Set*` and
`ThermostatEco.SetMode`.

The thermostat endpoint publishes what the Nest actually reports: ambient temperature, the active
setpoint, `ThermostatRunningState` (so a controller shows "heating" while the boiler runs), the
9–32 °C setpoint limits Google enforces, and two presets — **Manual** and **Eco**. Activating the
Eco preset switches the real thermostat into Eco; the Manual preset keeps the setpoint the Nest had
before, since Google stops reporting it while Eco or Off.

The Dyson fan becomes two bridged endpoints: an air purifier (speed 1-10, auto, oscillation,
airflow direction, night mode as the spec's `sleepWind` bit, HEPA filter life) and an air quality
sensor (PM2.5, PM10, VOC, NO2). Its temperature and humidity are deliberately not bridged — the fan
only measures while it runs, and a thermometer that reports intermittently drags every whole-home
climate summary with it. `bun run check-dyson` still prints them. The fan pushes `STATE-CHANGE` messages as it
happens, so controller state follows within a second; sensor readings are requested every 30s.

## Setup

```bash
bun install
cp .env.example .env   # fill in the Device Access + OAuth values
```

Credentials come from [Device Access](https://developers.google.com/nest/device-access): a project
id, an OAuth client, and a refresh token for the account that owns the thermostats.

Verify the credentials before commissioning anything:

```bash
bun run check-google
```

### Dyson

The fan is optional — leave `DYSON_SERIAL` empty and the bridge is Nest-only. It needs the serial
and the device's **local MQTT password**, which is not the Dyson account password: it is the value
the Dyson app provisions into the fan, retrievable from the Dyson cloud API (`LocalCredentials`) or
by sniffing the MQTT `CONNECT` packet on the LAN. Both are 88-character base64.

The fan is advertised as `<type>_<serial>._dyson_mqtt._tcp` and its SRV record points at
`<serial>.local:1883`, which macOS resolves natively, so `DYSON_HOST` is only needed where mDNS
resolution is missing. Confirm what is on the network with:

```bash
dns-sd -B _dyson_mqtt._tcp local          # macOS
avahi-browse -rt _dyson_mqtt._tcp         # Linux
bun run check-dyson                       # connects and prints the decoded state
```

A VPN is the usual reason `check-dyson` reports `connack timeout` while mDNS still works: multicast
stays on the local link, but the unicast route to the fan goes into the tunnel. Check with
`route -n get <fan ip>`.

### Octopus Energy

Also optional — leave `OCTOPUS_API_KEY` empty and the bridge skips the energy endpoints. The key
comes from [the API access page](https://octopus.energy/dashboard/new/accounts/personal-details/api-access)
and is sent as the HTTP Basic username with an empty password. It is read-only, but it exposes
consumption and account balance, so it belongs in `.env` and nowhere else.

Each import meter point on the account — electricity and gas — becomes two endpoints: an
`ElectricalMeter` (0x514) carrying cumulative and half-hourly imported energy, and an
`ElectricalEnergyTariff` (0x513) carrying the current unit price and the published forecast through
the `CommodityPrice` cluster. Export MPANs are skipped.

**What this bridges is history, not live power.** Octopus publishes half-hourly readings with a lag
of up to 24 hours, and near-real-time demand needs an Octopus Home Mini and a different (GraphQL)
API. So `activePower` reports `null` unless the newest reading is under 90 minutes old: a day-old
half-hour average presented as "right now" is worse than an empty field, because a controller has
no way to tell the difference. Apple Home's Energy tab (iOS 27+) is built around live wattage, so
expect it to show energy totals at best.

Cost is computed — usage at the rate in force for each half-hour, plus the standing charge per day —
and logged on every poll, but **it is not bridged**: no Matter cluster carries money spent.

Gas rides on the same two device types. matter.js has no gas meter device type and Matter's
`TariffUnit` admits only kWh, so gas volume is converted to kWh and the endpoint is labelled
"Gas Meter". A SMETS2 meter reports m³ and a SMETS1 meter reports kWh, and the API does not say
which, so `check-octopus` prints the reading both ways:

```bash
bun run check-octopus
```

Match its total against your bill, then set `OCTOPUS_GAS_UNITS` and `OCTOPUS_GAS_CALORIFIC_VALUE`
(the calorific value varies by region and day; the one your bill used is printed on it).

`ElectricalMeter` is Matter 1.6, new enough that a controller may not render it yet. If the meter
pairs but shows no figures, the known-working alternative is an `OnOffPlugInUnit` whose
`descriptor.deviceTypeList` also carries `ElectricalSensor` (0x510) — an Eve Energy's exact shape,
at the cost of a dead on/off switch on your grid supply. The device type is a single declaration
near the top of `src/octopus-energy.ts`.

### SimpliSafe

Optional — with no token the bridge runs without the alarm endpoints. Each device becomes one
endpoint:

| SimpliSafe | Matter | Fed by |
|---|---|---|
| Entry sensor (type 5) | Contact sensor (0x15) | REST poll, every 60s |
| Motion sensor (type 4/20) | Occupancy sensor (0x107) | websocket events |
| Camera | Occupancy sensor (0x107) | websocket events |

Sign in once; there is no username/password API, only Auth0 with PKCE:

```bash
bun run simplisafe-auth        # prints a URL, takes back the code from the redirect
bun run check-simplisafe       # what the account reports
bun run check-simplisafe --watch   # stays connected and prints events as they land
```

Already holding a code and verifier from elsewhere (`simplipy`'s `script/auth`, for instance)?
`bun run simplisafe-auth --code <code> --verifier <verifier>` skips the browser step. Authorization
codes are single-use and Auth0 expires them within about a minute, so an old one will fail — the
script says so and prints the command to retry with the same verifier. A refresh token you already
have needs no script at all: put it in `SIMPLISAFE_REFRESH_TOKEN`.

The refresh token lands in `.matter-storage/simplisafe-token.json` rather than `.env`, because
SimpliSafe issues a **new** refresh token on every refresh and the client rewrites the file each
time. `SIMPLISAFE_REFRESH_TOKEN` only seeds that file if it is missing. It is a live credential:
back the directory up, and treat it like `.env`.

**The two state sources are not equal, and it shows.** Entry sensors carry `status.triggered` over
REST, so polling is the source of truth for them and they work whatever the alarm is doing. Motion
sensors send an empty `status` block — their state exists only as websocket events, and their own
`setting` reads `off: 0, home: 0, away: 1`: SimpliSafe keeps them asleep unless the system is armed
Away. **A motion endpoint on a disarmed system will never fire.** That is the hardware, not a gap
here, and the bridge says so at startup rather than letting you wonder. Camera motion is not subject
to the same rule.

**Doors are polled, and there is a floor on how quickly one can be seen.** Opening a door while the
system is disarmed produces no websocket event whatsoever — measured, not assumed — so the poll is
the only thing that ever moves a contact sensor. It runs every 10s (`SIMPLISAFE_POLL_INTERVAL_MS`)
for that reason: at a minute, a door opened and shut between two ticks never existed as far as the
bridge is concerned, which looks exactly like a broken integration. Even at 10s there is a ceiling,
because SimpliSafe's own cached view trails the real door by 5–10s, so a door held open for barely a
second may still never appear. Forcing a fresh read (`forceUpdate=true`) is not the way out: the
base station takes longer than the 20s request timeout to answer one, and it is obviously not
something to do on a loop.

Neither source reports when motion *stops*, so occupancy is held for `SIMPLISAFE_MOTION_HOLD_MS`
(60s) and released on a timer. That is a knob, not a measurement — shorten it for a hallway,
lengthen it for a room you actually sit in.

**Unknown device types are not errors here.** `simplisafe-python` raises on any type id outside its
enum, and one unrecognised device takes the whole account down with it. `deviceTypeOf` keeps the
number and reports the device as `unknown` instead, and `check-simplisafe` ends by printing the full
raw payload of every id it could not name — which is how the id that broke `simplisafe-python`,
**21**, got identified: it is the **indoor camera**, which the base station files as a device of its
own in addition to the entry it already has in the subscription payload. Its serial is the last
eight hex characters of the camera's uuid (`cameraSerialOf` pairs the two back up), and its
`setting` block is per-mode motion arming, not sensor state. Its camera model reads `scout` rather
than an `SS`-code. Type 21 is therefore deliberately **not** bridged as a sensor: the camera it
duplicates already has an endpoint. Anything still unnamed goes in `DEVICE_TYPE_NAMES` in
`src/simplisafe.ts`; unmapped websocket event codes and unrecognised camera models behave the same
way.

#### Camera video

**Matter cannot carry it, so it is served over plain HTTP instead.** `CameraDevice` (0x142) mandates
`CameraAvStreamManagement` and `WebRtcTransportProvider` — the bridge would have to be a WebRTC peer
negotiating SDP and sending RTP — and there is no URL attribute anywhere in that model. matter.js
0.17.9 ships those clusters as empty stubs regardless (`WebRtcTransportProviderServer` is a
fourteen-line file with an empty body), so declaring 0x142 would pair and then do nothing. What is
real on that device type is its optional `OccupancySensing` cluster, which is exactly what a camera
can honestly report, so that is what each camera becomes.

The video itself comes from a small `Bun.serve()` that proxies SimpliSafe's FLV stream with the
bearer token attached:

```
http://127.0.0.1:5541/                       # index of cameras, with URLs
http://127.0.0.1:5541/camera/<uuid>          # live FLV — open in VLC, or point ffmpeg at it
```

Live view works **without** a camera subscription; only recordings and clips need a plan. A camera
SimpliSafe reports as offline answers 404, and that 404 is passed through rather than dressed up.

**Security: there is no authentication on that port** — anyone who can reach it can watch the
cameras. Adding a password would only move the credential problem, and SimpliSafe's own token must
never leave the process, so it binds to `127.0.0.1` by default. Set `SIMPLISAFE_STREAM_HOST=0.0.0.0`
only on a network you trust, and prefer an SSH tunnel or an authenticating reverse proxy over
exposing it directly.

Matter still has no alarm-panel device type, so arming and disarming are not bridged. The client
supports `setState`, so a controller-side switch is possible; nothing publishes it today.

## Run

```bash
bun run start   # or: bun run dev, which restarts on file changes
```

On first run it prints a QR link and a manual pairing code — commission it with any Matter
controller. Fabric state lives in `.matter-storage/`; delete that directory to reset pairing.

Without credentials, run against saved payloads:

```bash
SDM_FIXTURE=fixtures/devices.json DYSON_FIXTURE=fixtures/dyson-state.json \
  OCTOPUS_FIXTURE=fixtures/octopus.json SIMPLISAFE_FIXTURE=fixtures/simplisafe.json bun index.ts
```

Stop it with Ctrl-C or `SIGTERM`; it shuts the node down and exits within about a second, so it
works as a systemd service without a `KillMode` override. In-flight polls are aborted on the signal,
since a request waiting on Google, Octopus or SimpliSafe would otherwise hold the process open, as
would the SimpliSafe websocket and the camera stream server. Measured at 36ms with all four
integrations live. If the process is killed
outright — or signalled during the one-second startup window, where matter.js can throw
`MDNS service is closed` — the next start cleans up the stale storage lock on its own.

Logging defaults to `info`. Set `MATTER_LOG_LEVEL=debug` for the full matter.js trace — expect a
harmless `Error on closing socket ... kStateSymbol` on shutdown, which is Bun's `node:dgram` missing
an internal that matter.js's socket close path touches.

## Endpoints

Every endpoint is a direct child of the aggregator rather than a child composed under a shared
BridgedNode. Apple Home surfaces only one device type per composed node and chooses it
unpredictably: after each pairing a different Nest turned up as a humidity sensor with no thermostat
at all. One device type per endpoint removes the choice. matter.js recommends the same layout for
Alexa.

Endpoint numbers are assigned here rather than by matter.js: each device gets a slot of ten
numbers — `100`-`109` for the first, `110`-`119` for the next — and claims as many as it needs (two
each for a Nest, a Dyson and a meter point: thermostat and humidity, purifier and air quality, meter
and tariff; one each for a SimpliSafe sensor or camera). Slots are
persisted in `endpoint-slots.json` inside the storage directory. Controllers identify accessories
by number, so they must not shift when the device list changes. They are also kept to three digits,
because matter.js builds the descriptor `partsList` with a plain `numbers.sort()` — lexicographic —
so endpoints `9` and `10` would be published as `[10, 9]`.

Inspect what a controller sees, including the parts lists:

```bash
bun run dump-endpoints
```

## Test

```bash
bun test
```
