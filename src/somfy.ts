/**
 * Somfy RTS shutters, driven by the CC1101 transmitter in somfy-tx.py.
 *
 * RTS is one-way. The shutter never answers, nothing reports its position, and the wall remote
 * moves it without the bridge ever hearing about it. So this client only ever sends, and the
 * endpoints built on it only expose up/down/stop — see somfy-shutter.ts.
 *
 * One radio, one SPI bus, one pigpio waveform: two overlapping transmissions would interleave
 * pulses into a frame no shutter decodes, so every send is queued behind the last.
 *
 * The transmitter stays Python because that is where spidev and pigpio are. Spawning it per
 * command costs ~1s (CC1101 reset, wake-up frame, repeats), which is nothing next to a shutter
 * that takes 20 seconds to travel. It transmits and nothing else: the rolling codes live here, in
 * the Matter storage, with everything else that has to survive a restart.
 */

export type SomfyCommand = "up" | "down" | "my" | "prog";

export interface Shutter {
  name: string;
  /** Virtual remote id, normalised to `0x` + 6 hex digits. One per shutter. */
  address: string;
}

/** What the Matter endpoints need from the radio; lets them be tested without a CC1101. */
export interface Transmitter {
  send(address: string, command: SomfyCommand): Promise<void>;
}

const ADDRESS = /^(?:0x)?[0-9a-f]{6}$/i;

/**
 * Where somfy-tx.py is, given the module's own directory and the running executable.
 *
 * The script is spawned, not imported, so a compiled binary cannot read it back out of itself:
 * `import.meta.dir` is the embedded filesystem there, not a real path. Fall back to the directory
 * the executable sits in, which is where the build puts the script next to the binary.
 */
export function defaultScript(dir: string, execPath: string) {
  if (!dir.startsWith("/$bunfs/")) return `${dir}/../somfy-tx.py`;
  return `${execPath.slice(0, execPath.lastIndexOf("/"))}/somfy-tx.py`;
}

/**
 * Shutters from `SOMFY_SHUTTERS`, formatted `Living Room:0x123457,Bedroom:0x123458`.
 *
 * The address is the virtual remote the shutter was paired to with `prog`, not a serial the
 * hardware reports — nothing discovers these, so a typo silently drives the wrong shutter or
 * none at all. Hence the validation: a bad entry stops the bridge instead of going quiet.
 */
export function parseShutters(spec: string | undefined): Shutter[] {
  const shutters: Shutter[] = [];
  for (const entry of (spec ?? "").split(",")) {
    const text = entry.trim();
    if (!text) continue;
    // Last colon, so a name may contain one.
    const split = text.lastIndexOf(":");
    if (split < 0) throw new Error(`SOMFY_SHUTTERS needs "<name>:<address>" entries, got "${text}"`);

    const name = text.slice(0, split).trim();
    const address = text.slice(split + 1).trim().toLowerCase();
    if (!name) throw new Error(`SOMFY_SHUTTERS entry has no name: "${text}"`);
    if (!ADDRESS.test(address)) {
      throw new Error(`SOMFY_SHUTTERS address must be 3 hex bytes (e.g. 0x123457), got "${text}"`);
    }

    const normalised = `0x${address.replace(/^0x/, "")}`;
    // Two shutters on one remote id move together and share a rolling counter, which is a pairing
    // mistake rather than a configuration one. Either way it is not what the two names promise.
    if (shutters.some(shutter => shutter.address === normalised)) {
      throw new Error(`SOMFY_SHUTTERS lists ${normalised} twice; one virtual remote per shutter`);
    }
    shutters.push({ name, address: normalised });
  }
  return shutters;
}

/**
 * Rolling codes per virtual remote, persisted as JSON beside the Matter storage.
 *
 * The stored number is the code to send NEXT, not the last one sent, which is also what the
 * transmitter reports back as `next=`. One meaning on both sides of the boundary.
 *
 * A shutter accepts a frame only if its code is ahead of the last it accepted, and gaps are free
 * while repeats are fatal: skipping to 50 costs nothing, sending 42 twice means the second frame is
 * ignored. So {@link next} writes the file BEFORE the caller transmits. A crash mid-send then burns
 * one code instead of handing the same one out again.
 */
// somfy-tx.py rejects 0: the frame carries the code in 16 bits and a shutter only accepts one
// ahead of the last it saw, so counting starts at 1.
const FIRST_CODE = 1;

export class RollingCodes {
  readonly #path: string;
  readonly #codes: Record<string, number>;

  private constructor(path: string, codes: Record<string, number>) {
    this.#path = path;
    this.#codes = codes;
  }

  static async open(path: string) {
    const file = Bun.file(path);
    const codes = (await file.exists()) ? ((await file.json()) as Record<string, number>) : {};
    return new RollingCodes(path, codes);
  }

  /** Takes the next code, persisting the one after it before the caller transmits. */
  async next(address: string) {
    const code = this.#codes[address] ?? FIRST_CODE;
    await this.#write(address, code + 1);
    return code;
  }

  /** What the transmitter reported as its next. Only ever moves the counter forward. */
  async advanceTo(address: string, code: number) {
    if (code <= (this.#codes[address] ?? FIRST_CODE)) return;
    await this.#write(address, code);
  }

  /** The code this remote will send with next, for `check-somfy` to print. */
  at(address: string) {
    return this.#codes[address] ?? FIRST_CODE;
  }

  async #write(address: string, code: number) {
    this.#codes[address] = code;
    await Bun.write(this.#path, `${JSON.stringify(this.#codes, null, 2)}\n`);
  }
}

/** Where the rolling codes live: beside the Matter storage, so one backup covers both. */
export const rollingCodePath = (env: Record<string, string | undefined> = process.env) =>
  env.SOMFY_ROLL_FILE ?? `${env.MATTER_STORAGE_PATH ?? ".matter-storage"}/somfy-rolling-codes.json`;

/** The CC1101 transmitter: one process per command, one command at a time. */
export class SomfyRadio implements Transmitter {
  readonly #python: string;
  readonly #script: string;
  readonly #repeats: number;
  readonly #timeoutMs: number;
  readonly #codes: RollingCodes;
  /** No radio attached: log what would be sent. Lets the bridge run off the Pi. */
  readonly dryRun: boolean;
  /** Tail of the send queue. Never rejects, so one failure does not poison the next command. */
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(codes: RollingCodes, env: Record<string, string | undefined> = process.env) {
    this.#codes = codes;
    this.#python = env.SOMFY_PYTHON ?? "python3";
    this.#script = env.SOMFY_SCRIPT ?? defaultScript(import.meta.dir, process.execPath);
    this.#repeats = Number(env.SOMFY_REPEATS ?? 2);
    this.#timeoutMs = Number(env.SOMFY_TIMEOUT_MS ?? 15_000);
    this.dryRun = env.SOMFY_DRY_RUN === "1";
  }

  /** Opens the rolling codes at {@link rollingCodePath} and wires them to a radio. */
  static async open(env: Record<string, string | undefined> = process.env) {
    return new SomfyRadio(await RollingCodes.open(rollingCodePath(env)), env);
  }

  /** Queue a transmission. Resolves once the radio is back in idle, rejects if it never got there. */
  send(address: string, command: SomfyCommand): Promise<void> {
    const sent = this.#queue.then(() => this.#transmit(address, command));
    this.#queue = sent.then(
      () => {},
      () => {},
    );
    return sent;
  }

  async #transmit(address: string, command: SomfyCommand) {
    if (this.#closed) return;
    if (this.dryRun) {
      console.log(`Somfy: ${command} to ${address} (SOMFY_DRY_RUN, nothing transmitted)`);
      return;
    }

    // Reserved and on disk before the frame goes out; see RollingCodes.
    const roll = await this.#codes.next(address);
    const proc = Bun.spawn([this.#python, this.#script, command, String(this.#repeats)], {
      env: { ...process.env, SOMFY_ADDR: address, SOMFY_ROLL: String(roll) },
      stdout: "pipe",
      stderr: "pipe",
    });

    // pigpiod down, a wedged SPI bus or a missing rolling-code file must not hold the queue (and
    // every later command) forever.
    const timer = setTimeout(() => proc.kill(), this.#timeoutMs);
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(`somfy-tx.py ${command} ${address} exited ${code}: ${(err || out).trim() || "no output"}`);
      }
      // The transmitter reports the code to send next. It agrees with the reservation in the normal
      // case; honouring it anyway means a future change to how the script consumes codes cannot
      // silently leave the counter behind the shutter.
      const next = out.match(/\bnext=(\d+)\b/);
      if (next) await this.#codes.advanceTo(address, Number(next[1]));
      console.log(`Somfy: ${out.trim() || `${command} to ${address}`}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop transmitting. In-flight commands finish; queued ones become no-ops. */
  close() {
    this.#closed = true;
  }
}
