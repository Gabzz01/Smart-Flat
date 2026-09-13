/**
 * A local HTTP front door for SimpliSafe camera video.
 *
 * Matter cannot carry it. CameraDevice (0x142) mandates CameraAvStreamManagement and
 * WebRtcTransportProvider — the bridge would have to be a WebRTC peer negotiating SDP and sending
 * RTP — and there is no URL attribute anywhere in that model. So the stream is served the ordinary
 * way instead: this proxies SimpliSafe's FLV, attaching the bearer token the bridge already holds,
 * and hands out a URL that VLC, ffmpeg or a Home Assistant `generic` camera can open.
 *
 * SECURITY: anyone who can reach this port can watch the cameras. There is no authentication —
 * adding one would just move the credential problem, and SimpliSafe's own token must not leave the
 * process. So it binds to 127.0.0.1 by default. Set SIMPLISAFE_STREAM_HOST=0.0.0.0 only on a
 * network you trust, and prefer an SSH tunnel or a reverse proxy that does authenticate.
 *
 * Live view works without a camera subscription; recordings and clips do not. A camera SimpliSafe
 * reports as offline answers 404, and that 404 is passed straight through rather than dressed up.
 */

import { videoUrl } from "./simplisafe.ts";
import type { Camera, SimpliSafeClient } from "./simplisafe.ts";

export const DEFAULT_PORT = 5541;
/** Loopback: the safe default. See the SECURITY note above before changing it. */
export const DEFAULT_HOST = "127.0.0.1";

/** `/camera/<uuid>` -> the uuid, or undefined. Accepts a trailing slash and nothing else. */
export function cameraUuidFrom(pathname: string) {
  const match = /^\/camera\/([A-Za-z0-9-]+)\/?$/.exec(pathname);
  return match?.[1];
}

function indexPage(cameras: Camera[], origin: string) {
  const rows = cameras
    .map(camera => {
      const url = `${origin}/camera/${camera.uuid}`;
      const offline = camera.status === "offline" ? " — offline, will 404" : "";
      return `<li><a href="${url}">${camera.name}</a> (${camera.type}${offline})<br><code>${url}</code></li>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>SimpliSafe cameras</title>
<h1>SimpliSafe cameras</h1>
<p>FLV live streams. Open one in VLC, or point ffmpeg at it.</p>
<ul>${rows}</ul>`;
}

/**
 * Serve the cameras of one system. Returns the running server; call `.stop()` on shutdown.
 * `cameras` is read on every request, so a camera list refreshed by a poll is picked up live.
 */
export function serveCameras(
  client: SimpliSafeClient,
  cameras: () => Camera[],
  env: Record<string, string | undefined> = process.env,
) {
  const port = Number(env.SIMPLISAFE_STREAM_PORT ?? DEFAULT_PORT);
  const hostname = env.SIMPLISAFE_STREAM_HOST ?? DEFAULT_HOST;

  return Bun.serve({
    port,
    hostname,
    // A viewer may hold a stream open for hours; the default would cut it off.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(indexPage(cameras(), url.origin), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const uuid = cameraUuidFrom(url.pathname);
      const camera = uuid ? cameras().find(candidate => candidate.uuid === uuid) : undefined;
      if (!camera) return new Response("No such camera\n", { status: 404 });

      // Pass the viewer's signal through: hanging up must close the upstream stream too, or the
      // bridge keeps pulling video from SimpliSafe for a browser tab that is already gone.
      const upstream = await client.stream(videoUrl(camera.uuid), request.signal);
      if (!upstream.ok) {
        const reason = camera.status === "offline" ? " (SimpliSafe reports this camera offline)" : "";
        return new Response(`SimpliSafe returned ${upstream.status}${reason}\n`, { status: upstream.status });
      }
      return new Response(upstream.body, {
        headers: { "content-type": "video/x-flv", "cache-control": "no-store" },
      });
    },
  });
}
