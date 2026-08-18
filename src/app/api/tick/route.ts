/**
 * Manual scheduler nudge — the "check now" button.
 *
 * Runs exactly the same code path as the automatic minute-tick, calling-hours
 * guard included. It cannot make a call go out early.
 */

import { NextResponse } from "next/server";
import { tick } from "@/lib/dispatcher";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await tick();
  const url = appUrl(request, "/");
  url.searchParams.set("tick", result);
  return NextResponse.redirect(url, { status: 303 });
}
