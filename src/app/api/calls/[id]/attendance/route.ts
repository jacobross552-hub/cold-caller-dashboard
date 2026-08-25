import { NextResponse } from "next/server";
import { recordAttendance, getDemoBooking, type Attendance } from "@/lib/demo-booking";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

const ALLOWED = new Set<Attendance>(["joined", "no_show_called", "no_show_unreachable", "rescheduled"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const callId = Number(id);
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Bad call id." }, { status: 400 });
  }

  if (!getDemoBooking(callId)) {
    return NextResponse.json({ error: "No demo booking recorded for this call." }, { status: 400 });
  }

  const form = await request.formData();
  const attendance = String(form.get("attendance") ?? "");
  if (!ALLOWED.has(attendance as Attendance)) {
    return NextResponse.json({ error: "Unrecognised attendance value." }, { status: 400 });
  }

  const notesRaw = String(form.get("notes") ?? "").trim();
  recordAttendance(callId, attendance as Attendance, notesRaw === "" ? null : notesRaw);

  return NextResponse.redirect(appUrl(request, `/calls/${callId}`), { status: 303 });
}
