/**
 * Storing calls and driving the analysis.
 *
 * The webhook writes a row immediately with the mechanical facts (who, when,
 * how it ended). The summary and pre-call brief are generated straight after
 * and written onto the same row — so a call is never lost just because the
 * Anthropic key is missing or a summary fails.
 */

import { db, logEvent } from "./db";
import { formatSydney } from "./calling-hours";
import { formatAuPhone } from "./phone";
import { featureStatus } from "./env";
import { sendAlertSms } from "./sms";
import { buildBookingSms, findBookedEvent } from "./calendar-event";
import { suppress } from "./suppression";
import { checkQuoteAgainstTable, formatMoney, type QuoteCheck } from "./pricing";
import {
  analyseCall,
  refineOutcome,
  trivialSummary,
  type CallAnalysis,
} from "./brief";
import {
  bookingWasCreated,
  classifyOutcome,
  type TranscriptTurn,
  type Outcome,
  type WebhookCallData,
} from "./outcomes";

export interface CallRow {
  id: number;
  conversation_id: string;
  lead_id: number | null;
  run_id: number | null;
  business_name: string | null;
  phone: string | null;
  started_at: number | null;
  duration_secs: number | null;
  outcome: Outcome | null;
  termination_reason: string | null;
  cost: number | null;
  booked: number;
  transcript_json: string | null;
  raw_json: string | null;
  summary: string | null;
  analysis_json: string | null;
  analysis_error: string | null;
  analysed_at: number | null;
  alert_sent_at: number | null;
  created_at: number;
}

/** Match an incoming call to the lead it belongs to. */
function findLead(data: WebhookCallData): { leadId: number | null; runId: number | null; businessName: string | null; phone: string | null } {
  const database = db();
  const dynamic = data.conversation_initiation_client_data?.dynamic_variables ?? {};

  // First choice: the lead_id we attached when dispatching the batch.
  const rawLeadId = dynamic.lead_id;
  if (rawLeadId !== undefined && rawLeadId !== null) {
    const leadId = Number(rawLeadId);
    if (Number.isFinite(leadId)) {
      const lead = database
        .prepare("SELECT id, business_name, phone FROM leads WHERE id = ?")
        .get(leadId) as { id: number; business_name: string; phone: string } | undefined;
      if (lead) {
        const runId = Number(dynamic.run_id);
        return {
          leadId: lead.id,
          runId: Number.isFinite(runId) ? runId : null,
          businessName: lead.business_name,
          phone: lead.phone,
        };
      }
    }
  }

  // Fallback: match the conversation id recorded when we polled the batch.
  const viaRun = database
    .prepare(
      `SELECT rl.lead_id, rl.run_id, l.business_name, l.phone
         FROM run_leads rl JOIN leads l ON l.id = rl.lead_id
        WHERE rl.conversation_id = ?`,
    )
    .get(data.conversation_id) as
    | { lead_id: number; run_id: number; business_name: string; phone: string }
    | undefined;

  if (viaRun) {
    return {
      leadId: viaRun.lead_id,
      runId: viaRun.run_id,
      businessName: viaRun.business_name,
      phone: viaRun.phone,
    };
  }

  return {
    leadId: null,
    runId: null,
    businessName: typeof dynamic.business_name === "string" ? dynamic.business_name : null,
    phone: null,
  };
}

/** Write (or update) the call row from a post-call webhook payload. */
export function recordCall(data: WebhookCallData): { callId: number; outcome: Outcome } {
  const database = db();
  const { leadId, runId, businessName, phone } = findLead(data);
  const outcome = classifyOutcome(data);

  const startedAt = data.metadata?.start_time_unix_secs
    ? data.metadata.start_time_unix_secs * 1000
    : Date.now();

  // Only a SUCCESSFUL create_event counts. An errored one means no event
  // exists, so flagging it as booked would put a phantom demo on the
  // meetings page.
  const bookedByTool = bookingWasCreated(data.transcript) ? 1 : 0;

  database
    .prepare(
      `INSERT INTO calls (
         conversation_id, lead_id, run_id, business_name, phone, started_at,
         duration_secs, outcome, termination_reason, cost, booked,
         transcript_json, raw_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         lead_id            = COALESCE(excluded.lead_id, calls.lead_id),
         run_id             = COALESCE(excluded.run_id, calls.run_id),
         business_name      = COALESCE(excluded.business_name, calls.business_name),
         phone              = COALESCE(excluded.phone, calls.phone),
         started_at         = excluded.started_at,
         duration_secs      = excluded.duration_secs,
         outcome            = excluded.outcome,
         termination_reason = excluded.termination_reason,
         cost               = excluded.cost,
         booked             = MAX(calls.booked, excluded.booked),
         transcript_json    = excluded.transcript_json,
         raw_json           = excluded.raw_json`,
    )
    .run(
      data.conversation_id,
      leadId,
      runId,
      businessName,
      phone,
      startedAt,
      data.metadata?.call_duration_secs ?? null,
      outcome,
      data.metadata?.termination_reason ?? null,
      data.metadata?.cost ?? null,
      bookedByTool,
      JSON.stringify(data.transcript ?? []),
      JSON.stringify(data),
      Date.now(),
    );

  const row = database
    .prepare("SELECT id FROM calls WHERE conversation_id = ?")
    .get(data.conversation_id) as { id: number };

  // Mark the lead as called and close off its slot in the run.
  if (leadId) {
    database
      .prepare("UPDATE run_leads SET status = 'done', conversation_id = ? WHERE lead_id = ? AND run_id = ?")
      .run(data.conversation_id, leadId, runId);
  }

  logEvent(
    "call.received",
    `Call with ${businessName ?? phone ?? "unknown"} — ${outcome.replace(/_/g, " ")}` +
      (bookedByTool ? " (booking made)" : ""),
    { conversationId: data.conversation_id, outcome },
  );

  return { callId: row.id, outcome };
}

/**
 * Generate the summary and pre-call brief for a call.
 * Never throws — failures are recorded on the row so they show in the UI.
 */
export async function analyseAndStore(callId: number): Promise<void> {
  const database = db();
  const call = database.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as
    | CallRow
    | undefined;
  if (!call || !call.raw_json) return;

  const data = JSON.parse(call.raw_json) as WebhookCallData;
  const outcome = (call.outcome ?? "connected") as Outcome;

  // Calls with nothing said don't need a model.
  const canned = trivialSummary(data, outcome);
  if (canned) {
    database
      .prepare("UPDATE calls SET summary = ?, analysed_at = ?, analysis_error = NULL WHERE id = ?")
      .run(canned, Date.now(), callId);
    return;
  }

  if (!featureStatus().summaries) {
    database
      .prepare("UPDATE calls SET analysis_error = ? WHERE id = ?")
      .run(
        "No ANTHROPIC_API_KEY set, so no summary or pre-call brief was generated. The full transcript is still here.",
        callId,
      );
    return;
  }

  try {
    const { analysis, quoteCheck } = await analyseCall(data, {
      businessName: call.business_name,
      phone: call.phone,
    });

    const refined = refineOutcome(outcome, analysis);
    const booked = call.booked === 1 || analysis.booking.booked ? 1 : 0;

    database
      .prepare(
        `UPDATE calls
            SET summary = ?, analysis_json = ?, analysed_at = ?, analysis_error = NULL,
                outcome = ?, booked = ?
          WHERE id = ?`,
      )
      .run(
        analysis.summary,
        JSON.stringify({ analysis, quoteCheck }),
        Date.now(),
        refined,
        booked,
        callId,
      );

    // Honour a do-not-call request immediately.
    //
    // Two writes on purpose: the lead status stops THIS list dialling them
    // again, and the suppression list stops any FUTURE lead run sourcing the
    // same number back in. The second is the one that survives the lead row
    // being deleted or the list being rebuilt.
    if (analysis.do_not_call_requested) {
      if (call.lead_id) {
        database.prepare("UPDATE leads SET status = 'do_not_call' WHERE id = ?").run(call.lead_id);
      }
      if (call.phone) {
        suppress(call.phone, `Asked to be removed during a call on ${new Date().toDateString()}.`, {
          source: "call_analysis",
          addedBy: "agent",
        });
      }
      logEvent(
        "lead.do_not_call",
        `${call.business_name ?? "A prospect"} asked not to be called again — marked do-not-call and added to the permanent suppression list.`,
        { callId },
      );
    }

    if (quoteCheck.status === "off-table") {
      logEvent("pricing.off_table", `Off-table price quoted to ${call.business_name ?? "a prospect"}`, {
        callId,
        detail: quoteCheck.message,
      });
    }

    if (booked) await alertOnBooking(callId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    database
      .prepare("UPDATE calls SET analysis_error = ?, analysed_at = ? WHERE id = ?")
      .run(message, Date.now(), callId);
    logEvent("call.analysis_failed", `Couldn't summarise call ${callId}: ${message}`, { callId });

    // A booking still deserves a text even if the summary failed.
    if (call.booked === 1) await alertOnBooking(callId);
  }
}

/** Text Bob once, the moment a meeting books. */
export async function alertOnBooking(callId: number): Promise<void> {
  const database = db();
  const call = database.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as
    | CallRow
    | undefined;
  if (!call || call.alert_sent_at) return;

  const brief = parseAnalysis(call);
  const analysis = brief?.analysis;

  // The booked event carries the Google Meet link and the authoritative start
  // time. Falls back to whatever the model read out of the transcript when no
  // event was created, so this never throws on a link-less booking.
  const event = findBookedEvent(
    call.transcript_json ? (JSON.parse(call.transcript_json) as TranscriptTurn[]) : [],
  );

  // Google's own start time beats the model's reading of the conversation.
  const when = event?.startsAt
    ? formatSydney(new Date(event.startsAt))
    : analysis?.booking.day
      ? `${analysis.booking.day}${analysis.booking.time ? ` ${analysis.booking.time}` : ""}`
      : "check your calendar for the time";

  const body = buildBookingSms({
    business: call.business_name ?? call.phone ?? "Unknown business",
    when,
    figureLine: analysis?.discounted_weekly_loss
      ? `They agreed to about ${formatMoney(analysis.discounted_weekly_loss)}/wk in missed calls.`
      : undefined,
    event,
  });

  const result = await sendAlertSms(body);
  if (result.sent) {
    database.prepare("UPDATE calls SET alert_sent_at = ? WHERE id = ?").run(Date.now(), callId);
  }
}

export interface StoredBrief {
  analysis: CallAnalysis;
  quoteCheck: QuoteCheck;
}

export function parseAnalysis(call: CallRow): StoredBrief | null {
  if (!call.analysis_json) return null;
  try {
    const parsed = JSON.parse(call.analysis_json) as StoredBrief;
    // Re-check the quote against the live price table rather than trusting
    // whatever was stored, so a change to the table shows up immediately.
    parsed.quoteCheck = checkQuoteAgainstTable(
      parsed.analysis.discounted_weekly_loss ?? parsed.analysis.prospect_own_figure,
      parsed.analysis.quoted_setup_fee,
      parsed.analysis.quoted_monthly_retainer,
    );
    return parsed;
  } catch {
    return null;
  }
}

export function listCalls(limit = 200): CallRow[] {
  return db()
    .prepare("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?")
    .all(limit) as unknown as CallRow[];
}

export function listBookedCalls(): CallRow[] {
  return db()
    .prepare("SELECT * FROM calls WHERE booked = 1 ORDER BY started_at DESC")
    .all() as unknown as CallRow[];
}

export function getCall(id: number): CallRow | null {
  return (db().prepare("SELECT * FROM calls WHERE id = ?").get(id) ?? null) as CallRow | null;
}

export function callStats() {
  const rows = db()
    .prepare("SELECT outcome, COUNT(*) AS n FROM calls GROUP BY outcome")
    .all() as unknown as Array<{ outcome: string; n: number }>;

  const byOutcome: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byOutcome[row.outcome] = row.n;
    total += row.n;
  }

  const booked = (
    db().prepare("SELECT COUNT(*) AS n FROM calls WHERE booked = 1").get() as { n: number }
  ).n;

  return { total, booked, byOutcome };
}

/** Human-readable call heading used across the UI. */
export function describeCall(call: CallRow): string {
  const name = call.business_name ?? (call.phone ? formatAuPhone(call.phone) : "Unknown business");
  return `${name} — ${call.started_at ? formatSydney(call.started_at) : "time unknown"}`;
}
