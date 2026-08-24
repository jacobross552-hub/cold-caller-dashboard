import { NextResponse } from "next/server";
import { runWeeklyLearning } from "@/lib/learning";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

/** Manual "Run now" — the normal path is the Monday 6am scheduler trigger. */
export async function POST(request: Request) {
  await runWeeklyLearning();
  return NextResponse.redirect(appUrl(request, "/learning"), { status: 303 });
}
