/**
 * Builds the bridge into one standalone executable for deployment.
 *
 * The Pi Zero 2 has 512 MB of RAM and an SD card for a disk, so `bun install` on the device is
 * slow and `node_modules` is 200 MB of small files. A single binary with the runtime inside skips
 * both: copy it over with somfy-tx.py and run it.
 *
 * `node:sqlite` is stubbed because @matter/nodejs re-exports a SQLite storage backend from its
 * barrel, so the bundler pulls the module in even though the bridge only ever uses file storage.
 * Bun has no `node:sqlite` (as of 1.3), and the runtime gets away with it by never evaluating the
 * module; the bundler has to be told. The stub throws if anything ever does reach for it.
 *
 *   bun run build                  # ./dist for the host
 *   bun run build --target bun-linux-arm64
 */

import { parseArgs } from "node:util";
import type { Build } from "bun";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: "string" }, outdir: { type: "string", default: "dist" } },
});

const outdir = values.outdir!;
const name = "matter-bridge";

const result = await Bun.build({
  entrypoints: ["./index.ts"],
  target: "bun",
  compile: {
    outfile: `${outdir}/${name}`,
    ...(values.target ? { target: values.target as Build.CompileTarget } : {}),
  },
  // Neither minify nor bytecode, and both are deliberate. Minifying renames what matter.js reads
  // back at runtime, and the binary dies on startup with `Unsupported log format ""` -- 2 MB off
  // 66 is not worth that. Bytecode needs a CommonJS output, and index.ts is top-level await
  // throughout, so Bun rejects the combination with "Unexpected ." on the first await.
  plugins: [
    {
      name: "stub-node-sqlite",
      setup(build) {
        build.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: "node:sqlite", namespace: "sqlite-stub" }));
        build.onLoad({ filter: /.*/, namespace: "sqlite-stub" }, () => ({
          contents:
            'export class DatabaseSync { constructor() { throw new Error("SQLite storage is not bundled; the bridge uses file storage"); } }',
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Spawned rather than imported, so it has to travel next to the binary. See defaultScript().
await Bun.write(`${outdir}/somfy-tx.py`, Bun.file("somfy-tx.py"));
await Bun.write(`${outdir}/.env.example`, Bun.file(".env.example"));

const { size } = await Bun.file(`${outdir}/${name}`).stat();
console.log(`${outdir}/${name}  ${(size / 1024 / 1024).toFixed(1)} MB${values.target ? ` (${values.target})` : ""}`);
