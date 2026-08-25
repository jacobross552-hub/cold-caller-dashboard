/**
 * Demo-meeting reminders and no-show tracking.
 *
 * ADDITIVE — the existing booking -> alertOnBooking -> SMS-to-Bob flow is
 * untouched. This sits alongside it.
 *
 * Two things happen once, at booking time (recordDemoBooking, called right
 * after alertOnBooking — same trigger point, doesn't modify it):
 *   1. The meeting time and Meet link are captured into their own row, so
 *      the reminder scheduler can query by time without re-parsing a
 *      transcript on every tick.
 *   2. The confirmation text ElevenLabs' own send_sms tool ALREADY sent
 *      during the call is found in the transcript and backfilled into
 *      sms_sends. It was never recorded anywhere before this — the agent
 *      calls Twilio directly, not through this app's own sms.ts — so its
 *      delivery status was never checkable. See build-log.md for how this
 *      was confirmed against a real transcript before writing this.
 *
 * Everything else — sending the two reminders, flagging a no-show — is
 * scheduler-driven: demoBookingTick(), called from dispatcher.ts's existing
 * one-minute heartbeat, same as every other timed check in this app.
 */

import { db, logEvent } from "./db";
import { optional } from "./env";
import { formatSydney } from "./calling-hours";
import { findBookedEvent } from "./calendar-event";
import type { TranscriptTurn } from "./outcomes";

const MS_PER_MIN = 60_000;
export const REMINDER_24H_MS = 24 * 60 * MS_PER_MIN;
export const REMINDER_1H_MS = 60 * MS_PER_MIN;
/** How long after the scheduled start a still-unmarked booking gets flagged. */
export const NO_SHOW_GRACE_MS = 5 * MS_PER_MIN;

export type Attendance = "joined" | "no_show_called" | "no_show_unreachable" | "rescheduled";

export const ATTENDANCE_LABELS: Record<Attendance, string> = {
  joined: "Joined",
  no_show_called: "No-show — called them",
  no_show_unreachable: "No-show — couldn't reach",
  rescheduled: "Rescheduled",
};

export interface DemoBookingRow {
  id: number;
  call_id: number;
  meeting_at: number;
  meet_link: string | null;
  reminder_24h_sent_at: number | null;
  reminder_24h_skipped: number;
  reminder_1h_sent_at: number | null;
  reminder_1h_skipped: number;
  attendance: Attendance | null;
  attendance_notes: string | null;
  attendance_marked_at: number | null;
  no_show_flagged_at: number | null;
  created_at: number;
}

export function getDemoBooking(callId: number): DemoBookingRow | null {
  return (db().prepare("SELECT * FROM demo_bookings WHERE call_id = ?").get(callId) ?? null) as
    | DemoBookingRow
    | null;
}

export function getDemoBookingsByCallIds(callIds: number[]): Map<number, DemoBookingRow> {
  const map = new Map<number, DemoBookingRow>();
  if (callIds.length === 0) return map;
  const placeholders = callIds.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM demo_bookings WHERE call_id IN (${placeholders})`)
    .all(...callIds) as unknown as DemoBookingRow[];
  for (const row of rows) map.set(row.call_id, row);
  return map;
}

/** Every booking still flagged, unmarked — what the "impossible to miss" banner is built from. */
export function listUnresolvedNoShows(): DemoBookingRow[] {
  return db()
    .prepare(`SELECT * FROM demo_bookings WHERE no_show_flagged_at IS NOT NULL AND attendance IS NULL ORDER BY meeting_at DESC`)
    .all() as unknown as DemoBookingRow[];
}

export interface SmsSendRow {
  id: number;
  call_id: number | null;
  purpose: string;
  provider_sid: string | null;
  segments: number;
  price: number | null;
  price_unit: string | null;
  status: string | null;
  status_error: string | null;
  created_at: number;
}

/** Every text tied to a booking — the original confirmation and both reminders — for the delivery-status display. */
export function listSmsForCall(callId: number): SmsSendRow[] {
  return db()
    .prepare(
      `SELECT * FROM sms_sends WHERE call_id = ? AND purpose IN ('demo_confirmation', 'demo_reminder_24h', 'demo_reminder_1h', 'agent_sms_other') ORDER BY created_at ASC`,
    )
    .all(callId) as unknown as SmsSendRow[];
}

export const SMS_PURPOSE_LABELS: Record<string, string> = {
  demo_confirmation: "Confirmation (sent live on the call)",
  demo_reminder_24h: "24h reminder",
  demo_reminder_1h: "1h reminder",
  agent_sms_other: "Other text sent on the call",
};

/* ---------------------------------------------------------------------------
 * Backfilling the agent's own confirmation text
 * ------------------------------------------------------------------------ */

interface AgentSmsResult {
  sid: string;
  to: string;
  body: string;
}

/**
 * Every successful send_sms tool result in the transcript. There can be more
 * than one — the live script also texts a callback number on request — so
 * this returns all of them rather than assuming exactly one.
 */
function extractAgentSmsSends(transcript: TranscriptTurn[]): AgentSmsResult[] {
  const found: AgentSmsResult[] = [];
  for (const turn of transcript) {
    const results = (turn as unknown as { tool_results?: unknown }).tool_results;
    if (!Array.isArray(results)) continue;
    for (const result of results as Array<Record<string, unknown>>) {
      if (result?.tool_name !== "send_sms" || result?.is_error === true) continue;
      const raw = typeof result.result_value === "string" ? result.result_value : "";
      try {
        const parsed = JSON.parse(raw) as { sid?: string; to?: string; body?: string };
        if (parsed.sid && parsed.to) {
          found.push({ sid: parsed.sid, to: parsed.to, body: parsed.body ?? "" });
        }
      } catch {
        // Unparseable result — nothing to backfill for this one send.
      }
    }
  }
  return found;
}

/**
 * Backfill every agent-sent text found in the transcript into sms_sends, so
 * twilio-reconcile.ts's existing polling picks up their delivery status the
 * same way it already does for everything else. The one whose body contains
 * the Meet link is labelled the confirmation; any others (e.g. a texted
 * callback number) are labelled generically — still tracked, just not the
 * one this feature was specifically asked to surface.
 */
function backfillAgentSms(callId: number, transcript: TranscriptTurn[]): void {
  const sends = extractAgentSmsSends(transcript);
  if (sends.length === 0) return;

  const insert = db().prepare(
    `INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, created_at) VALUES (?, ?, ?, 1, ?)`,
  );
  const now = Date.now();
  for (const send of sends) {
    const purpose = send.body.includes("meet.google.com") ? "demo_confirmation" : "agent_sms_other";
    insert.run(callId, purpose, send.sid, now);
  }

  logEvent(
    "demo_booking.confirmation_backfilled",
    `Backfilled ${sends.length} agent-sent text${sends.length === 1 ? "" : "s"} for call ${callId} into delivery tracking.`,
    { callId },
  );
}

/* ---------------------------------------------------------------------------
 * Recording the booking
 * ------------------------------------------------------------------------ */

/**
 * Idempotent — a demo_bookings row existing at all means this already ran
 * for this call, so it's safe to call from the same place alertOnBooking is
 * called without worrying about a redelivered webhook double-running it.
 *
 * Degrades honestly rather than guessing: a booking with no parseable start
 * time gets no reminders and no no-show tracking, logged plainly, same as
 * every other "couldn't gather this" gap elsewhere in the app.
 */
export function recordDemoBooking(callId: number): void {
  if (getDemoBooking(callId)) return;

  const call = db().prepare("SELECT transcript_json, created_at FROM calls WHERE id = ?").get(callId) as
    | { transcript_json: string | null; created_at: number }
    | undefined;
  if (!call) return;

  const transcript: TranscriptTurn[] = call.transcript_json ? (JSON.parse(call.transcript_json) as TranscriptTurn[]) : [];
  const event = findBookedEvent(transcript);

  if (!event?.created || !event.startsAt) {
    logEvent(
      "demo_booking.skipped",
      `Call ${callId} booked but no parseable meeting time was found — no reminders or no-show tracking possible for it.`,
      { callId },
    );
    return;
  }

  const meetingAt = Date.parse(event.startsAt);
  if (!Number.isFinite(meetingAt)) {
    logEvent("demo_booking.skipped", `Call ${callId}'s meeting time ("${event.startsAt}") couldn't be parsed.`, { callId });
    return;
  }

  // Bob's rule: don't attempt a reminder whose lead time is longer than the
  // gap between booking and the demo itself — a 24h reminder for a demo
  // booked 3 hours ago would either fire immediately (wrong) or never
  // (silently missing). Decided once, here, not re-evaluated later.
  const leadTime = meetingAt - call.created_at;
  const skip24h = leadTime < REMINDER_24H_MS ? 1 : 0;
  const skip1h = leadTime < REMINDER_1H_MS ? 1 : 0;

  db()
    .prepare(
      `INSERT INTO demo_bookings (call_id, meeting_at, meet_link, reminder_24h_skipped, reminder_1h_skipped, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(callId, meetingAt, event.meetLink ?? null, skip24h, skip1h, Date.now());

  backfillAgentSms(callId, transcript);

  logEvent(
    "demo_booking.recorded",
    `Demo booking recorded for call ${callId}: ${formatSydney(meetingAt)}${skip24h ? " (24h reminder skipped — booked too close to the demo)" : ""}${skip1h ? " (1h reminder skipped too)" : ""}.`,
    { callId },
  );
}

/* ---------------------------------------------------------------------------
 * Sending a reminder
 * ------------------------------------------------------------------------ */

function reminderBody(kind: "24h" | "1h", meetingAt: number, meetLink: string | null): string {
  const link = meetLink ? ` ${meetLink}` : "";
  if (kind === "24h") {
    return `Hi, it's Jacob — reminder your demo is ${formatSydney(meetingAt)}. Join here:${link}`;
  }
  return `Starting in an hour — join here:${link}`;
}

/**
 * Send one reminder text to the prospect (not Bob — this is the client-facing
 * send sms.ts's sendAlertSms deliberately isn't, per its own doc comment).
 * Same direct-Twilio-call pattern as sms.ts, same account, different
 * recipient and purpose.
 */
async function sendReminderSms(
  to: string,
  body: string,
  callId: number,
  purpose: "demo_reminder_24h" | "demo_reminder_1h",
): Promise<{ sent: boolean; detail: string }> {
  const accountSid = optional("TWILIO_ACCOUNT_SID");
  const authToken = optional("TWILIO_AUTH_TOKEN");
  const from = optional("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !from) {
    return { sent: false, detail: "Twilio isn't configured, so no reminder was sent." };
  }

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      logEvent("demo_booking.reminder_failed", `Reminder (${purpose}) failed for call ${callId} (${response.status})`, text.slice(0, 500));
      return { sent: false, detail: `Twilio rejected the message: ${text.slice(0, 200)}` };
    }

    let sid: string | null = null;
    let segments = 1;
    try {
      const payload = JSON.parse(text) as { sid?: string; num_segments?: string };
      sid = payload.sid ?? null;
      const parsed = Number(payload.num_segments);
      if (Number.isFinite(parsed) && parsed > 0) segments = parsed;
    } catch {
      // A send that worked but whose body we couldn't parse still counts as one message.
    }

    db()
      .prepare(`INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(callId, purpose, sid, segments, Date.now());

    logEvent("demo_booking.reminder_sent", `Reminder (${purpose}) texted for call ${callId}.`, { callId });
    return { sent: true, detail: `Texted ${to}.` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("demo_booking.reminder_failed", `Reminder (${purpose}) failed for call ${callId}`, detail);
    return { sent: false, detail };
  }
}

/* ---------------------------------------------------------------------------
 * Scheduler
 * ------------------------------------------------------------------------ */

interface DueRow {
  call_id: number;
  phone: string | null;
  meeting_at: number;
  meet_link: string | null;
}

/**
 * Called from dispatcher.ts's one-minute heartbeat. Three independent checks
 * each tick: send a due 24h reminder, send a due 1h reminder, flag a no-show.
 * All time-windowed so a late tick (a restart, a slow minute) still catches
 * up correctly rather than missing the window entirely — see the `< meeting_at`
 * upper bound on each reminder query, which only excludes sending a reminder
 * AFTER the meeting has already happened.
 */
export async function demoBookingTick(): Promise<void> {
  const now = Date.now();
  const database = db();

  const due24h = database
    .prepare(
      `SELECT db.call_id, c.phone, db.meeting_at, db.meet_link
         FROM demo_bookings db JOIN calls c ON c.id = db.call_id
        WHERE db.reminder_24h_sent_at IS NULL AND db.reminder_24h_skipped = 0
          AND db.meeting_at - ? <= ? AND db.meeting_at > ?`,
    )
    .all(now, REMINDER_24H_MS, now) as unknown as DueRow[];

  for (const row of due24h) {
    if (!row.phone) continue;
    const result = await sendReminderSms(
      row.phone,
      reminderBody("24h", row.meeting_at, row.meet_link),
      row.call_id,
      "demo_reminder_24h",
    );
    if (result.sent) {
      database.prepare("UPDATE demo_bookings SET reminder_24h_sent_at = ? WHERE call_id = ?").run(Date.now(), row.call_id);
    }
  }

  const due1h = database
    .prepare(
      `SELECT db.call_id, c.phone, db.meeting_at, db.meet_link
         FROM demo_bookings db JOIN calls c ON c.id = db.call_id
        WHERE db.reminder_1h_sent_at IS NULL AND db.reminder_1h_skipped = 0
          AND db.meeting_at - ? <= ? AND db.meeting_at > ?`,
    )
    .all(now, REMINDER_1H_MS, now) as unknown as DueRow[];

  for (const row of due1h) {
    if (!row.phone) continue;
    const result = await sendReminderSms(
      row.phone,
      reminderBody("1h", row.meeting_at, row.meet_link),
      row.call_id,
      "demo_reminder_1h",
    );
    if (result.sent) {
      database.prepare("UPDATE demo_bookings SET reminder_1h_sent_at = ? WHERE call_id = ?").run(Date.now(), row.call_id);
    }
  }

  const dueNoShow = database
    .prepare(
      `SELECT call_id FROM demo_bookings
        WHERE attendance IS NULL AND no_show_flagged_at IS NULL AND ? - meeting_at >= ?`,
    )
    .all(now, NO_SHOW_GRACE_MS) as unknown as Array<{ call_id: number }>;

  for (const row of dueNoShow) {
    database.prepare("UPDATE demo_bookings SET no_show_flagged_at = ? WHERE call_id = ?").run(now, row.call_id);
    logEvent("demo_booking.no_show_flagged", `Call ${row.call_id}'s demo passed its start time with nobody marked attended — flagged.`, {
      callId: row.call_id,
    });
  }
}

/** Manual outcome marking — clears the no-show flag by definition, since it's now resolved either way. */
export function recordAttendance(callId: number, attendance: Attendance, notes: string | null): void {
  db()
    .prepare(
      `UPDATE demo_bookings SET attendance = ?, attendance_notes = ?, attendance_marked_at = ? WHERE call_id = ?`,
    )
    .run(attendance, notes, Date.now(), callId);
  logEvent("demo_booking.attendance_recorded", `Call ${callId} marked: ${ATTENDANCE_LABELS[attendance]}.`, { callId });
}
