import { NextResponse } from "next/server";
import { COOKIE_NAME, SESSION_DAYS, createSessionToken, passwordMatches } from "@/lib/auth";
import { optional } from "@/lib/env";
import { appUrl, isSecureRequest } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const expected = optional("DASHBOARD_PASSWORD");
  const secret = optional("SESSION_SECRET");

  if (!expected || !secret) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD and SESSION_SECRET must both be set in .env." },
      { status: 500 },
    );
  }

  const form = await request.formData();
  const submitted = String(form.get("password") ?? "");

  if (!(await passwordMatches(submitted, expected))) {
    const url = appUrl(request, "/login");
    url.searchParams.set("error", "1");
    return NextResponse.redirect(url, { status: 303 });
  }

  const next = String(form.get("next") ?? "/");
  // Only ever redirect within this app.
  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const response = NextResponse.redirect(appUrl(request, target), { status: 303 });
  response.cookies.set(COOKIE_NAME, await createSessionToken(secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return response;
}
