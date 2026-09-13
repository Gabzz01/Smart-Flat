import { expect, test } from "bun:test";
import { authorizationCodeFrom, authUrl, REDIRECT_URI } from "./sdm.ts";

/** A token minted off the plain OAuth screen authenticates and then sees no devices. */
test("the auth url goes through Device Access and asks for an offline refresh token", () => {
  const url = new URL(authUrl("proj-123", "client-abc"));
  expect(url.origin + url.pathname).toBe("https://nestservices.google.com/partnerconnections/proj-123/auth");
  expect(url.searchParams.get("client_id")).toBe("client-abc");
  // offline for a refresh token at all, consent to be issued a new one rather than just an access
  // token on an account that has already granted access.
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/sdm.service");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
});

test("the code is read out of a pasted redirect url, percent-decoded", () => {
  // What the address bar actually holds: the code contains a slash, which Google encodes.
  expect(authorizationCodeFrom("https://www.google.com/?code=4%2F0AX4XfWi-abc&scope=https%3A%2F%2Fx")).toBe(
    "4/0AX4XfWi-abc",
  );
  expect(authorizationCodeFrom("  4/0AX4XfWi-abc  ")).toBe("4/0AX4XfWi-abc");
  expect(authorizationCodeFrom("")).toBe("");
});
