/**
 * Regenerate the summary and pre-call brief for one call.
 * Useful when the Anthropic key was missing at the time, or a summary failed.
 */

import { NextResponse } from "next/server";
import { analyseAndStore } from "@/lib/calls";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);

  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  await analyseAndStore(callId);
  return NextResponse.redirect(new URL(`/calls/${callId}`, request.url), { status: 303 });
}
