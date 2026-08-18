import { NextResponse } from "next/server";
import { RunError, startRun, tick } from "@/lib/dispatcher";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const count = Number(form.get("count") ?? 0);
  const name = String(form.get("name") ?? "").trim() || undefined;

  try {
    const run = startRun(count, name);

    // Nudge the scheduler so an in-hours run starts immediately rather than
    // waiting for the next minute-tick. If it's out of hours, this just
    // records the hold — it never bypasses the guard.
    void tick().catch(() => {});

    const url = appUrl(request, "/");
    url.searchParams.set("started", String(run.id));
    return NextResponse.redirect(url, { status: 303 });
  } catch (err) {
    const message = err instanceof RunError ? err.message : "Couldn't start the run.";
    const url = appUrl(request, "/");
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  }
}
