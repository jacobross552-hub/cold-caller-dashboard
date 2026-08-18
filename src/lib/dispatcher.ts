/**
 * The dialling layer.
 *
 * This is where the calling-hours guard actually bites. Pressing "start
 * calling" never dials anything directly — it queues a run. A ticker checks
 * every minute whether calls may legally go out and hands ElevenLabs a small
 * chunk at a time.
 *
 * That design is deliberate (plan.md step 9):
 *   - Queue in the evening and the calls sit until 9am, rather than firing.
 *   - A run that is mid-flight at 8pm stops and resumes the next morning
 *     instead of spilling past the legal window.
 *   - Every hold is written to the activity log with its reason.
 */

import { db, logEvent } from "./db";
import { config } from "./env";
import {
  checkCallingWindow,
  checkCallingWindowForState,
  sydneyDayStart,
  formatSydney,
} from "./calling-hours";
import { cancelBatch, getBatch, submitBatch, type BatchRecipient } from "./elevenlabs";
import { leadFinderTick } from "./lead-finder/orchestrator";

export interface RunRow {
  id: number;
  name: string;
  requested_count: number;
  status: "waiting_for_window" | "dispatching" | "completed" | "cancelled" | "failed";
  hold_reason: string | null;
  next_window_at: number | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Prevents the interval and a manual API call from ticking at the same time. */
let ticking = false;

export function activeRun(): RunRow | null {
  return (db()
    .prepare(
      "SELECT * FROM runs WHERE status IN ('waiting_for_window','dispatching') ORDER BY created_at ASC LIMIT 1",
    )
    .get() ?? null) as RunRow | null;
}

export function getRun(id: number): RunRow | null {
  return (db().prepare("SELECT * FROM runs WHERE id = ?").get(id) ?? null) as RunRow | null;
}

export function listRuns(limit = 25): RunRow[] {
  return db()
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as RunRow[];
}

export function runProgress(runId: number) {
  const rows = db()
    .prepare("SELECT status, COUNT(*) AS n FROM run_leads WHERE run_id = ? GROUP BY status")
    .all(runId) as unknown as Array<{ status: string; n: number }>;

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    total += row.n;
  }

  return {
    total,
    pending: counts.pending ?? 0,
    dispatched: counts.dispatched ?? 0,
    done: counts.done ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
  };
}

/** How many calls have gone out today, on the Australian calendar day. */
export function dispatchedToday(at: Date = new Date()): number {
  const since = sydneyDayStart(at).getTime();
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM run_leads WHERE dispatched_at IS NOT NULL AND dispatched_at >= ?")
    .get(since) as { n: number } | undefined;
  return row?.n ?? 0;
}

export class RunError extends Error {}

/**
 * Queue a run of `count` calls against the callable leads.
 * Never dials — the ticker does that, once the window allows it.
 */
export function startRun(count: number, name?: string): RunRow {
  const database = db();

  if (!Number.isFinite(count) || count < 1) {
    throw new RunError("Enter how many calls to make (at least 1).");
  }

  if (activeRun()) {
    throw new RunError(
      "There's already a run in progress. Cancel it before starting another one.",
    );
  }

  // Oldest leads first, never-called before previously-called.
  // The NOT EXISTS is not redundant with lead status: a number can land on the
  // do-not-contact list at any time, and that list is the authority.
  const leads = database
    .prepare(
      `SELECT id FROM leads
       WHERE status = 'new'
         AND NOT EXISTS (SELECT 1 FROM do_not_contact d WHERE d.phone = leads.phone)
       ORDER BY call_count ASC, created_at ASC
       LIMIT ?`,
    )
    .all(count) as unknown as Array<{ id: number }>;

  if (leads.length === 0) {
    throw new RunError(
      "No callable leads. Import some leads first, or check they're not all marked do-not-call.",
    );
  }

  const now = Date.now();
  const runName = name?.trim() || `Run ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`;

  const info = database
    .prepare(
      "INSERT INTO runs (name, requested_count, status, created_at) VALUES (?, ?, 'waiting_for_window', ?)",
    )
    .run(runName, leads.length, now);
  const runId = Number(info.lastInsertRowid);

  const link = database.prepare(
    "INSERT INTO run_leads (run_id, lead_id, status) VALUES (?, ?, 'pending')",
  );
  const claim = database.prepare("UPDATE leads SET status = 'queued' WHERE id = ?");

  for (const lead of leads) {
    link.run(runId, lead.id);
    claim.run(lead.id);
  }

  const window = checkCallingWindow();
  logEvent(
    "run.created",
    `Run "${runName}" queued with ${leads.length} call${leads.length === 1 ? "" : "s"}. ` +
      (window.allowed
        ? "Inside calling hours — dialling starts within a minute."
        : `Held: ${window.reason}${window.nextOpen ? ` Resumes ${formatSydney(window.nextOpen)}.` : ""}`),
    { runId, requested: count, queued: leads.length },
  );

  if (leads.length < count) {
    logEvent(
      "run.short",
      `Only ${leads.length} callable lead${leads.length === 1 ? "" : "s"} available — asked for ${count}.`,
      { runId },
    );
  }

  return getRun(runId)!;
}

/**
 * Put any never-dialled leads back on the callable list.
 *
 * Without this, a cancelled or failed run would leave its leads stuck on
 * 'queued' forever — they'd never be picked up by another run and would
 * silently vanish from the callable pool.
 */
function releasePendingLeads(runId: number): number {
  const database = db();

  const pending = database
    .prepare("SELECT lead_id FROM run_leads WHERE run_id = ? AND status = 'pending'")
    .all(runId) as unknown as Array<{ lead_id: number }>;

  const release = database.prepare("UPDATE leads SET status = 'new' WHERE id = ? AND status = 'queued'");
  for (const row of pending) release.run(row.lead_id);

  database
    .prepare("UPDATE run_leads SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'")
    .run(runId);

  return pending.length;
}

export function cancelRun(runId: number): void {
  const database = db();
  const run = getRun(runId);
  if (!run) throw new RunError("That run doesn't exist.");

  database
    .prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?")
    .run(Date.now(), runId);

  const pendingCount = releasePendingLeads(runId);

  // Best-effort cancel of anything already handed to ElevenLabs.
  const batches = database
    .prepare(
      "SELECT elevenlabs_batch_id FROM batches WHERE run_id = ? AND status IN ('pending','in_progress')",
    )
    .all(runId) as unknown as Array<{ elevenlabs_batch_id: string }>;

  for (const batch of batches) {
    cancelBatch(batch.elevenlabs_batch_id).catch((err) =>
      logEvent("batch.cancel_failed", `Couldn't cancel batch ${batch.elevenlabs_batch_id}`, String(err)),
    );
  }

  logEvent("run.cancelled", `Run "${run.name}" cancelled. ${pendingCount} call(s) never went out.`, {
    runId,
  });
}

function finishRun(run: RunRow, status: RunRow["status"], note: string) {
  db()
    .prepare("UPDATE runs SET status = ?, finished_at = ?, hold_reason = NULL WHERE id = ?")
    .run(status, Date.now(), run.id);
  logEvent(`run.${status}`, `Run "${run.name}": ${note}`, { runId: run.id });
}

function hold(run: RunRow, reason: string, nextOpen?: Date) {
  const previous = run.hold_reason;
  db()
    .prepare("UPDATE runs SET status = 'waiting_for_window', hold_reason = ?, next_window_at = ? WHERE id = ?")
    .run(reason, nextOpen ? nextOpen.getTime() : null, run.id);

  // Only log when the reason changes, so a run held overnight doesn't write
  // the same line to the activity log 600 times.
  if (previous !== reason) {
    logEvent("run.held", `Run "${run.name}" held: ${reason}`, {
      runId: run.id,
      resumesAt: nextOpen ? formatSydney(nextOpen) : null,
    });
  }
}

/** Poll ElevenLabs for batches we've already submitted, and record results. */
async function reconcileBatches(runId: number): Promise<{ stillRunning: number }> {
  const database = db();
  const open = database
    .prepare(
      "SELECT * FROM batches WHERE run_id = ? AND status IN ('pending','in_progress') ORDER BY created_at ASC",
    )
    .all(runId) as unknown as Array<{
    id: number;
    elevenlabs_batch_id: string;
    status: string;
  }>;

  let stillRunning = 0;

  for (const batch of open) {
    let job;
    try {
      job = await getBatch(batch.elevenlabs_batch_id);
    } catch (err) {
      logEvent("batch.poll_failed", `Couldn't read batch ${batch.elevenlabs_batch_id}`, String(err));
      stillRunning++;
      continue;
    }

    database
      .prepare("UPDATE batches SET status = ?, last_polled_at = ? WHERE id = ?")
      .run(job.status, Date.now(), batch.id);

    // Map each recipient back to its lead so the webhook can be matched even
    // if the phone number comes back formatted differently.
    for (const recipient of job.recipients ?? []) {
      if (!recipient.phone_number) continue;

      const terminal = ["completed", "failed", "cancelled", "voicemail"].includes(recipient.status);

      database
        .prepare(
          `UPDATE run_leads
             SET conversation_id = COALESCE(?, conversation_id),
                 status = CASE WHEN ? THEN 'done' ELSE status END
           WHERE run_id = ?
             AND lead_id = (SELECT id FROM leads WHERE phone = ?)`,
        )
        .run(recipient.conversation_id ?? null, terminal ? 1 : 0, runId, recipient.phone_number);
    }

    if (job.status === "pending" || job.status === "in_progress") stillRunning++;
  }

  return { stillRunning };
}

/**
 * One pass of the scheduler. Safe to call as often as you like.
 * Returns a short description of what it did, for the UI and the logs.
 */
export async function tick(): Promise<string> {
  if (ticking) return "Already running.";
  ticking = true;

  try {
    const run = activeRun();
    if (!run) return "Nothing queued.";

    const database = db();
    const progress = runProgress(run.id);

    // Any batches still in flight? Don't stack more on top.
    const { stillRunning } = await reconcileBatches(run.id);

    if (progress.pending === 0) {
      if (stillRunning > 0) return "Waiting for the last calls to finish.";
      finishRun(run, "completed", `all ${progress.total} call(s) dispatched.`);
      return "Run complete.";
    }

    const usedToday = dispatchedToday();
    if (usedToday >= config.maxCallsPerDay) {
      const tomorrow = checkCallingWindow(new Date(Date.now() + 6 * 60 * 60 * 1000));
      hold(
        run,
        `Daily cap reached (${usedToday}/${config.maxCallsPerDay} calls today). Resumes tomorrow.`,
        tomorrow.nextOpen,
      );
      return "Held: daily cap reached.";
    }

    if (stillRunning > 0) {
      return "Calls already in flight — waiting for them to finish.";
    }

    const remainingToday = config.maxCallsPerDay - usedToday;
    const chunkSize = Math.min(config.dispatchChunkSize, remainingToday, progress.pending);

    // Pull a wider pool than we need: each lead is judged against its own
    // state's clock, so the ones eligible right now may not be the first
    // few in the queue.
    const candidates = database
      .prepare(
        // THE LAST GATE BEFORE A CALL GOES OUT.
        // A lead can be queued into a run and then opt out before its turn
        // comes round — runs span hours or days once the calling-hours guard
        // pauses them overnight. Re-checking here, rather than trusting the
        // status captured at queue time, is what makes an opt-out take effect
        // immediately instead of after the current run drains.
        `SELECT rl.id AS run_lead_id, l.id AS lead_id, l.phone, l.business_name, l.state
           FROM run_leads rl
           JOIN leads l ON l.id = rl.lead_id
          WHERE rl.run_id = ? AND rl.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM do_not_contact d WHERE d.phone = l.phone)
          ORDER BY rl.id ASC
          LIMIT ?`,
      )
      .all(run.id, Math.max(chunkSize * 20, 100)) as unknown as Array<{
      run_lead_id: number;
      lead_id: number;
      phone: string;
      business_name: string;
      state: string | null;
    }>;

    if (candidates.length === 0) return "Nothing to dispatch.";

    // ---- The guard. Nothing below this line runs outside legal hours. ----
    // Checked per lead, in the lead's own timezone.
    const chunk: typeof candidates = [];
    let soonestReopen: Date | undefined;
    let blockedReason = "";

    for (const lead of candidates) {
      const window = checkCallingWindowForState(lead.state);
      if (window.allowed) {
        chunk.push(lead);
        if (chunk.length >= chunkSize) break;
      } else if (!blockedReason) {
        blockedReason = window.reason;
        soonestReopen = window.nextOpen;
      } else if (window.nextOpen && soonestReopen && window.nextOpen < soonestReopen) {
        blockedReason = window.reason;
        soonestReopen = window.nextOpen;
      }
    }

    if (chunk.length === 0) {
      hold(run, blockedReason || "Outside calling hours.", soonestReopen);
      return `Held: ${blockedReason}`;
    }

    const recipients: BatchRecipient[] = chunk.map((lead) => ({
      phone_number: lead.phone,
      conversation_initiation_client_data: {
        // Echoed back on the post-call webhook, which is how a call gets
        // matched to its lead without relying on phone-number formatting.
        dynamic_variables: {
          lead_id: String(lead.lead_id),
          business_name: lead.business_name,
          run_id: String(run.id),
          // The number we are dialling, so the agent's send_sms tool has a
          // correct `To` without having to ask the prospect for it mid-call.
          // Without this the model fills `To` from whatever number is in its
          // context — which is the callback number in its own system prompt,
          // i.e. our Twilio number, texting ourselves. Reference it in the
          // tool config as {{prospect_phone}}.
          prospect_phone: lead.phone,
        },
      },
    }));

    const batchName = `${run.name} — ${chunk.length} call${chunk.length === 1 ? "" : "s"}`;

    let job;
    try {
      job = await submitBatch({
        name: batchName,
        recipients,
        concurrency: config.callConcurrency,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      database
        .prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(message, Date.now(), run.id);

      // Hand the leads back so a failed run doesn't strand them as 'queued'.
      const released = releasePendingLeads(run.id);

      logEvent(
        "run.failed",
        `Run "${run.name}" failed to dispatch: ${message} — ${released} lead(s) put back on the list.`,
        { runId: run.id },
      );
      return `Dispatch failed: ${message}`;
    }

    const now = Date.now();

    database
      .prepare(
        "INSERT INTO batches (run_id, elevenlabs_batch_id, call_count, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(run.id, job.id, chunk.length, job.status ?? "pending", now);

    const markDispatched = database.prepare(
      "UPDATE run_leads SET status = 'dispatched', batch_id = ?, dispatched_at = ? WHERE id = ?",
    );
    const touchLead = database.prepare(
      "UPDATE leads SET status = 'called', call_count = call_count + 1, last_called_at = ? WHERE id = ?",
    );

    for (const lead of chunk) {
      markDispatched.run(job.id, now, lead.run_lead_id);
      touchLead.run(now, lead.lead_id);
    }

    database
      .prepare(
        "UPDATE runs SET status = 'dispatching', hold_reason = NULL, next_window_at = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?",
      )
      .run(now, run.id);

    logEvent(
      "run.dispatched",
      `Dialling ${chunk.length} call${chunk.length === 1 ? "" : "s"} for run "${run.name}" (${usedToday + chunk.length}/${config.maxCallsPerDay} today).`,
      { runId: run.id, batchId: job.id, businesses: chunk.map((c) => c.business_name) },
    );

    return `Dispatched ${chunk.length} call(s).`;
  } finally {
    ticking = false;
  }
}

let interval: ReturnType<typeof setInterval> | null = null;

/** Started from src/instrumentation.ts when the server boots. */
export function startScheduler() {
  if (interval) return;

  logEvent("scheduler.started", "Calling-hours scheduler started — checking every minute.");

  interval = setInterval(() => {
    tick().catch((err) => {
      logEvent("scheduler.error", "Scheduler tick failed", String(err));
      console.error("[scheduler]", err);
    });

    // Same heartbeat drives the lead finder's recovery pass. It only acts on a
    // run that has stalled — a healthy run is left alone.
    try {
      leadFinderTick();
    } catch (err) {
      logEvent("scheduler.error", "Lead-finder tick failed", String(err));
      console.error("[scheduler:lead-finder]", err);
    }
  }, 60_000);

  // Kick once shortly after boot so a queued run doesn't wait a full minute.
  setTimeout(() => {
    tick().catch(() => {});
  }, 3_000);
}
