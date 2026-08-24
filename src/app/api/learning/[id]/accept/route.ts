import { NextResponse } from "next/server";
import { acceptProposal } from "@/lib/learning";
import { appUrl } from "@/lib/http";
import { logEvent } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const proposalId = Number(id);
  if (!Number.isFinite(proposalId)) {
    return NextResponse.json({ error: "Bad proposal id." }, { status: 400 });
  }

  try {
    await acceptProposal(proposalId);
  } catch (err) {
    // A failed apply must not look like a silent success — the proposal
    // stays 'pending' (acceptProposal never flips status until the write to
    // ElevenLabs succeeds), so retrying is exactly clicking Accept again.
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("learning.accept_failed", `Failed to apply proposal ${proposalId}: ${detail}`, { proposalId });
    return NextResponse.json({ error: `Couldn't apply this change: ${detail}` }, { status: 502 });
  }

  return NextResponse.redirect(appUrl(request, "/learning"), { status: 303 });
}
