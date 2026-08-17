/**
 * The single gate on the whole dashboard.
 *
 * Everything requires a valid session cookie except the login page itself and
 * the ElevenLabs webhook, which authenticates with its own HMAC signature
 * instead (ElevenLabs can't log in).
 */

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "./lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/webhooks/elevenlabs"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + "/"))) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fail closed. Without a secret we cannot verify anyone, so nobody gets in.
    return new NextResponse(
      "SESSION_SECRET is not set in .env — the dashboard is locked until it is. See .env.example.",
      { status: 500, headers: { "content-type": "text/plain" } },
    );
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifySessionToken(token, secret)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
