import { NextResponse } from "next/server";
import { getCall } from "@/lib/calls";
import { provisionDemoAgent } from "@/lib/demo-agent";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

/** Manual "Build now" / "Retry" — the normal path is automatic, this backs the UI's fallback button. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  const call = getCall(callId);
  if (!call || call.booked !== 1) {
    return NextResponse.json({ error: "This call has no booked meeting to build a demo agent for." }, {
      status: 400,
    });
  }

  await provisionDemoAgent(callId);

  return NextResponse.redirect(appUrl(request, `/calls/${callId}`), { status: 303 });
}
