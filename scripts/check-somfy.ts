/**
 * Drives a shutter from SOMFY_SHUTTERS without the bridge, to check wiring and pairing.
 *
 *   bun run check-somfy                    # list the configured shutters
 *   bun run check-somfy "Living Room" up   # up | down | my | prog
 *
 * `prog` is the pairing command: hold PROG on the existing remote until the shutter jogs, then
 * send it to teach the shutter this virtual remote id.
 */

import { parseShutters, SomfyRadio, type SomfyCommand } from "../src/somfy.ts";

const COMMANDS: SomfyCommand[] = ["up", "down", "my", "prog"];

const shutters = parseShutters(process.env.SOMFY_SHUTTERS);
if (!shutters.length) {
  console.error("No shutters: set SOMFY_SHUTTERS in .env, e.g. SOMFY_SHUTTERS=Living Room:0x123457");
  process.exit(1);
}

const [name, command = "my"] = process.argv.slice(2);
if (!name) {
  console.log(`${shutters.length} shutter(s):`);
  for (const shutter of shutters) console.log(`  ${shutter.name}  ${shutter.address}`);
  console.log(`\nusage: bun run check-somfy "<name>" <${COMMANDS.join("|")}>`);
  process.exit(0);
}

const shutter = shutters.find(entry => entry.name.toLowerCase() === name.toLowerCase());
if (!shutter) {
  console.error(`No shutter named "${name}". Known: ${shutters.map(entry => entry.name).join(", ")}`);
  process.exit(1);
}
if (!COMMANDS.includes(command as SomfyCommand)) {
  console.error(`Unknown command "${command}". One of: ${COMMANDS.join(", ")}`);
  process.exit(1);
}

const radio = new SomfyRadio();
console.log(`${shutter.name} (${shutter.address}): ${command}${radio.dryRun ? " — SOMFY_DRY_RUN" : ""}`);
try {
  await radio.send(shutter.address, command as SomfyCommand);
} finally {
  radio.close();
}
