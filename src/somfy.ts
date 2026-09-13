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
 * that takes 20 seconds to travel.
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

/** The CC1101 transmitter: one process per command, one command at a time. */
export class SomfyRadio implements Transmitter {
  readonly #python: string;
  readonly #script: string;
  readonly #repeats: number;
  readonly #timeoutMs: number;
  readonly #rollDir?: string;
  /** No radio attached: log what would be sent. Lets the bridge run off the Pi. */
  readonly dryRun: boolean;
  /** Tail of the send queue. Never rejects, so one failure does not poison the next command. */
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#python = env.SOMFY_PYTHON ?? "python3";
    this.#script = env.SOMFY_SCRIPT ?? `${import.meta.dir}/../somfy-tx.py`;
    this.#repeats = Number(env.SOMFY_REPEATS ?? 2);
    this.#timeoutMs = Number(env.SOMFY_TIMEOUT_MS ?? 15_000);
    this.#rollDir = env.SOMFY_ROLL_DIR;
    this.dryRun = env.SOMFY_DRY_RUN === "1";
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

    const proc = Bun.spawn([this.#python, this.#script, command, String(this.#repeats)], {
      env: {
        ...process.env,
        SOMFY_ADDR: address,
        // Left unset, the script picks a file per remote id of its own.
        ...(this.#rollDir ? { SOMFY_ROLL_FILE: `${this.#rollDir}/somfy_roll_${address.slice(2)}.txt` } : {}),
      },
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
      // The script prints the rolling code it used, which is the only record that a frame went out.
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
