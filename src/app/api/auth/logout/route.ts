import { NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const response = NextResponse.redirect(appUrl(request, "/login"), { status: 303 });
  response.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return response;
}
