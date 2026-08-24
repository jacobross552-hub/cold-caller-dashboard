import { NextResponse } from "next/server";
import { getCall } from "@/lib/calls";
import { recordWon, recordLost, isLostReason } from "@/lib/deals";
import { teardownDemoAgent } from "@/lib/demo-agent";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

function parseMoney(raw: FormDataEntryValue | null): number | null {
  if (raw === null) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  const call = getCall(callId);
  if (!call) {
    return NextResponse.json({ error: "No such call." }, { status: 404 });
  }
  if (call.booked !== 1) {
    return NextResponse.json({ error: "This call has no booked meeting to record an outcome for." }, {
      status: 400,
    });
  }

  const form = await request.formData();
  const status = String(form.get("status") ?? "");

  if (status === "won") {
    const setupFee = parseMoney(form.get("setup_fee"));
    const retainer = parseMoney(form.get("retainer"));
    if (setupFee === null || retainer === null) {
      return NextResponse.json(
        { error: "Enter the actual setup fee and monthly retainer agreed, both as numbers." },
        { status: 400 },
      );
    }
    recordWon(callId, setupFee, retainer);
    await teardownDemoAgent(callId, "won");
  } else if (status === "lost") {
    const reason = String(form.get("lost_reason") ?? "");
    if (!isLostReason(reason)) {
      return NextResponse.json({ error: "Pick a reason from the list." }, { status: 400 });
    }
    const notesRaw = String(form.get("notes") ?? "").trim();
    if (reason === "other" && notesRaw === "") {
      return NextResponse.json(
        { error: "\"Other\" needs a note explaining why — that's the only way it's useful later." },
        { status: 400 },
      );
    }
    recordLost(callId, reason, notesRaw === "" ? null : notesRaw);
    await teardownDemoAgent(callId, "lost");
  } else {
    return NextResponse.json({ error: "Status must be won or lost." }, { status: 400 });
  }

  return NextResponse.redirect(appUrl(request, `/calls/${callId}`), { status: 303 });
}
