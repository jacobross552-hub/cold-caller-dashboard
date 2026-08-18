import { NextResponse } from "next/server";
import { cancelRun, RunError } from "@/lib/dispatcher";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const runId = Number(id);

  const url = appUrl(request, "/");

  try {
    cancelRun(runId);
    url.searchParams.set("cancelled", String(runId));
  } catch (err) {
    url.searchParams.set("error", err instanceof RunError ? err.message : "Couldn't cancel that run.");
  }

  return NextResponse.redirect(url, { status: 303 });
}
