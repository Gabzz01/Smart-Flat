/**
 * One-time SimpliSafe login. SimpliSafe has no username/password API: you sign in to Auth0 in a
 * browser and paste back the code from the redirect, which this exchanges for a refresh token.
 *
 * Already hold a code and verifier from elsewhere (simplipy's `script/auth`, say)? Pass them:
 *   bun run simplisafe-auth --code <code> --verifier <verifier>
 * Have only a verifier? Pass --verifier alone and this reuses it for a fresh browser round.
 */

import {
  authorizationCodeFrom,
  authUrl,
  codeChallenge,
  codeVerifier,
  exchangeCode,
  saveRefreshToken,
  tokenStorePath,
} from "../src/simplisafe.ts";

function flag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const verifier = flag("verifier") ?? codeVerifier();
let code = flag("code");

if (code) {
  // Authorization codes are single-use and Auth0 expires them within a couple of minutes, so a code
  // kept from an earlier session is very likely dead. The exchange below says so if it is.
  console.log("Using the code and verifier given on the command line.\n");
} else {
  console.log("Open this in a browser and sign in to SimpliSafe:\n");
  console.log(authUrl(await codeChallenge(verifier)));
  console.log(
    "\nThe browser will refuse to follow the final redirect to com.simplisafe.mobile://... — that is" +
      "\nexpected. Copy that URL out of the address bar (or just the code= value) and paste it here.\n",
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

const tokens = await exchangeCode(code, verifier).catch((error: unknown) => {
  const message = String(error);
  console.error(message);
  if (message.includes("invalid_grant") || message.includes("403")) {
    console.error(
      "\nThat usually means the code was already used or has expired — they are single-use and last" +
        "\nabout a minute. Re-run with no arguments for a fresh one:\n" +
        `\n  bun run simplisafe-auth --verifier ${verifier}\n`,
    );
  }
  process.exit(1);
});

if (!tokens.refresh_token) {
  console.error("SimpliSafe returned no refresh token. Re-run for a fresh code.");
  process.exit(1);
}

const path = await saveRefreshToken(tokens.refresh_token);
console.log(`\nSaved to ${path}.`);
console.log("The bridge reads it from there and rewrites it as SimpliSafe rotates it. To keep a");
console.log("copy in .env as well (it seeds the store if the file is ever lost):\n");
console.log(`SIMPLISAFE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log(`\nDefault store location: ${tokenStorePath()}`);
