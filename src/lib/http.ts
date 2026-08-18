/**
 * Building URLs that survive a reverse proxy.
 *
 * On Railway (and any other proxy) the app is reached at
 * https://something.up.railway.app but the container receives the request at
 * http://localhost:8080. `request.url` inside a route handler is the INTERNAL
 * address, so `new URL("/leads", request.url)` produces
 * `http://localhost:8080/leads` — and a 303 to that address sends the browser
 * somewhere that doesn't exist for them.
 *
 * Middleware doesn't have this problem (Next rewrites `request.url` there),
 * which is exactly why it hid: unauthenticated redirects looked correct while
 * every form POST was broken.
 *
 * The proxy tells us the real values in `x-forwarded-*`. Use these helpers for
 * anything the browser will act on.
 */

function forwarded(request: Request, header: string): string | undefined {
  // These headers can carry a comma-separated chain; the first entry is the
  // original client-facing value.
  return request.headers.get(header)?.split(",")[0]?.trim() || undefined;
}

/** The scheme the BROWSER used, which is not necessarily the container's. */
export function requestProtocol(request: Request): string {
  const proto = forwarded(request, "x-forwarded-proto");
  if (proto) return proto;
  try {
    return new URL(request.url).protocol.replace(":", "");
  } catch {
    return "http";
  }
}

/** True when the browser's connection is HTTPS, proxy or not. */
export function isSecureRequest(request: Request): boolean {
  return requestProtocol(request) === "https";
}

/**
 * An absolute URL on the public origin, for redirects.
 * Falls back to `request.url` when there are no proxy headers (local dev).
 */
export function appUrl(request: Request, path: string): URL {
  const host = forwarded(request, "x-forwarded-host") ?? request.headers.get("host") ?? undefined;
  if (host) {
    return new URL(path, `${requestProtocol(request)}://${host}`);
  }
  return new URL(path, request.url);
}
