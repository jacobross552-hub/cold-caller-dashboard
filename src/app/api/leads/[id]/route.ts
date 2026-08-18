import { NextResponse } from "next/server";
import { setLeadStatus } from "@/lib/leads";
import { logEvent } from "@/lib/db";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

const ALLOWED = new Set(["new", "do_not_call"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const leadId = Number(id);
  if (!Number.isFinite(leadId)) {
    return NextResponse.json({ error: "Bad lead id." }, { status: 400 });
  }

  const form = await request.formData();
  const status = String(form.get("status") ?? "");

  if (!ALLOWED.has(status)) {
    return NextResponse.json({ error: "Unsupported status." }, { status: 400 });
  }

  setLeadStatus(leadId, status);
  logEvent("lead.status", `Lead ${leadId} set to ${status.replace(/_/g, "-")}.`);

  return NextResponse.redirect(appUrl(request, "/leads"), { status: 303 });
}
