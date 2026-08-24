import { NextResponse } from "next/server";
import { rejectProposal } from "@/lib/learning";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const proposalId = Number(id);
  if (!Number.isFinite(proposalId)) {
    return NextResponse.json({ error: "Bad proposal id." }, { status: 400 });
  }

  const form = await request.formData();
  const reason = String(form.get("reason") ?? "").trim();
  if (reason === "") {
    return NextResponse.json(
      { error: "A reason is required — it feeds back into future weekly runs so the same idea isn't proposed again blind." },
      { status: 400 },
    );
  }

  rejectProposal(proposalId, reason);

  return NextResponse.redirect(appUrl(request, "/learning"), { status: 303 });
}
