import { NextResponse } from "next/server";
import { releasePhoneClaim } from "@/lib/demo-agent";
import { appUrl } from "@/lib/http";
import { logEvent } from "@/lib/db";

export const runtime = "nodejs";

/** Point the shared cold-calling number back at Jacob. Releases whatever's currently claimed — a global action, not scoped to this call. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  try {
    await releasePhoneClaim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("demo_agent.phone_release_failed", `Failed to release the phone claim: ${detail}`, { callId });
    return NextResponse.json({ error: `Couldn't point the number back to Jacob: ${detail}` }, { status: 502 });
  }

  return NextResponse.redirect(appUrl(request, `/calls/${callId}`), { status: 303 });
}
