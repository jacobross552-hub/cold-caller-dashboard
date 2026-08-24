import { NextResponse } from "next/server";
import { revertProposal } from "@/lib/learning";
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
    await revertProposal(proposalId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("learning.revert_failed", `Failed to revert proposal ${proposalId}: ${detail}`, { proposalId });
    return NextResponse.json({ error: `Couldn't revert this change: ${detail}` }, { status: 502 });
  }

  return NextResponse.redirect(appUrl(request, "/learning"), { status: 303 });
}
