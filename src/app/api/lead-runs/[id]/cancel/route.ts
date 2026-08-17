import { NextResponse } from "next/server";
import { cancelLeadRun, LeadRunError } from "@/lib/lead-finder/orchestrator";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL("/find-leads", request.url);

  try {
    cancelLeadRun(Number(id));
    url.searchParams.set("cancelled", "1");
  } catch (err) {
    url.searchParams.set(
      "error",
      err instanceof LeadRunError ? err.message : "Couldn't cancel that run.",
    );
  }

  return NextResponse.redirect(url, { status: 303 });
}
