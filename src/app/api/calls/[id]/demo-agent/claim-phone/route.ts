import { NextResponse } from "next/server";
import { claimPhoneForDemo } from "@/lib/demo-agent";
import { appUrl } from "@/lib/http";
import { logEvent } from "@/lib/db";

export const runtime = "nodejs";

/** Point the shared cold-calling number's inbound routing at this demo agent. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  try {
    await claimPhoneForDemo(callId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("demo_agent.phone_claim_failed", `Failed to claim the phone for call ${callId}: ${detail}`, { callId });
    return NextResponse.json({ error: `Couldn't repoint the number: ${detail}` }, { status: 502 });
  }

  return NextResponse.redirect(appUrl(request, `/calls/${callId}`), { status: 303 });
}
