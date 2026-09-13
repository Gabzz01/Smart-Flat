/**
 * Mints a Google refresh token for the Smart Device Management API.
 *
 * Consent goes through Device Access, not Google's usual OAuth screen — that is the step which
 * links your Nest account to the SDM project, so a token minted anywhere else authenticates fine
 * and then sees no devices.
 *
 *   bun run google-auth                  # prints a URL, asks for the code from the redirect
 *   bun run google-auth --code <code>    # already have one
 *
 * Refresh tokens expire after 7 days while the OAuth consent screen is still in Testing. If you
 * find yourself running this weekly, publish the app instead: Google Cloud Console → APIs &
 * Services → OAuth consent screen → Publish app. Unverified is fine for a personal project.
 */

import { authorizationCodeFrom, authUrl, exchangeCode, REDIRECT_URI } from "../src/sdm.ts";

function flag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const projectId = process.env.SDM_PROJECT_ID;
const clientId = process.env.GOOGLE_CLIENT_ID;
const missing = [
  ["SDM_PROJECT_ID", projectId],
  ["GOOGLE_CLIENT_ID", clientId],
  ["GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET],
].filter(([, value]) => !value);
if (missing.length) {
  console.error(`Missing in .env: ${missing.map(([key]) => key).join(", ")}`);
  console.error("They come from Device Access: https://developers.google.com/nest/device-access");
  process.exit(1);
}

let code = flag("code");
if (code) {
  // Authorization codes are single-use and short-lived, so one kept from earlier is likely dead.
  console.log("Using the code given on the command line.\n");
} else {
  console.log("Open this in a browser, pick the Nest devices to share, and approve:\n");
  console.log(authUrl(projectId!, clientId!));
  console.log(
    `\nGoogle then redirects to ${REDIRECT_URI}, which is a dead end by design — nothing is` +
      "\nlistening. Copy that URL out of the address bar (or just the code= value) and paste it here.\n",
  );
  process.stdout.write("Code or redirect URL: ");
  for await (const line of console) {
    code = line;
    break;
  }
}

code = authorizationCodeFrom(code ?? "");
if (!code) {
  console.error("No code given.");
  process.exit(1);
}

const tokens = await exchangeCode(code).catch((error: unknown) => {
  const message = String(error);
  console.error(message);
  if (message.includes("invalid_grant")) {
    console.error("\nCodes are single-use and expire in minutes. Re-run with no arguments for a fresh one.");
  }
  process.exit(1);
});

if (!tokens.refresh_token) {
  // Without prompt=consent Google reissues nothing when the account has already granted access.
  console.error("Google returned no refresh token. Re-run with no arguments to consent again.");
  process.exit(1);
}

// Printed rather than written: .env is yours, and this is the one line in it worth not clobbering.
console.log("\nPut this in .env, replacing the old value:\n");
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log("\nThen check it, and redeploy — the bridge reads the token once, at startup:\n");
console.log("  bun run check-google");
console.log("  ansible-playbook -i deploy/inventory.ini deploy/matter-bridge.yaml -e bridge_env_file=.env");
