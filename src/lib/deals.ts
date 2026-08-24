/**
 * Demo outcomes — Won or Lost, recorded once the demo call for a booked
 * meeting has actually happened.
 *
 * This is the prerequisite Segments 3 and 6 read from. On a Won deal, the
 * agreed setup fee and retainer are captured as they ACTUALLY were, which may
 * differ from src/lib/pricing.ts's recommendation for that call's weekly
 * figure — that gap is expected and useful, not a data-quality problem.
 */

import { db, logEvent } from "./db";

export type DealStatus = "won" | "lost";

/** Fixed list per the standing decision — free text only accompanies "other". */
export const LOST_REASONS = {
  price_too_high: "Price too high",
  bad_timing: "Bad timing",
  doesnt_trust_ai: "Doesn't trust AI",
  chose_competitor: "Chose a competitor",
  no_budget: "No budget",
  no_perceived_need: "Didn't see the need",
  other: "Other",
} as const;

export type LostReason = keyof typeof LOST_REASONS;

export function isLostReason(value: string): value is LostReason {
  return Object.prototype.hasOwnProperty.call(LOST_REASONS, value);
}

export interface DealRow {
  id: number;
  call_id: number;
  status: DealStatus;
  lost_reason: LostReason | null;
  lost_notes: string | null;
  agreed_setup_fee: number | null;
  agreed_monthly_retainer: number | null;
  recorded_at: number;
}

export function getDeal(callId: number): DealRow | null {
  return (db().prepare("SELECT * FROM deals WHERE call_id = ?").get(callId) ?? null) as DealRow | null;
}

/** Same shape as dealStats(), scoped to deals RECORDED in [start, end) — the weekly learning job's input. */
export function dealStatsInWindow(start: number, end: number): DealStats {
  const database = db();
  const bookedTotal = (
    database
      .prepare("SELECT COUNT(*) AS n FROM calls WHERE booked = 1 AND created_at >= ? AND created_at < ?")
      .get(start, end) as { n: number }
  ).n;

  const rows = database
    .prepare(
      "SELECT status, lost_reason, agreed_setup_fee, agreed_monthly_retainer FROM deals WHERE recorded_at >= ? AND recorded_at < ?",
    )
    .all(start, end) as unknown as Array<{
    status: DealStatus;
    lost_reason: LostReason | null;
    agreed_setup_fee: number | null;
    agreed_monthly_retainer: number | null;
  }>;

  let won = 0;
  let lost = 0;
  let setupFees = 0;
  let monthlyRetainers = 0;
  const lostByReason: Partial<Record<LostReason, number>> = {};

  for (const row of rows) {
    if (row.status === "won") {
      won++;
      setupFees += row.agreed_setup_fee ?? 0;
      monthlyRetainers += row.agreed_monthly_retainer ?? 0;
    } else {
      lost++;
      if (row.lost_reason) lostByReason[row.lost_reason] = (lostByReason[row.lost_reason] ?? 0) + 1;
    }
  }

  return {
    pending: Math.max(0, bookedTotal - won - lost),
    won,
    lost,
    bookedTotal,
    wonRevenue: { setupFees, monthlyRetainers },
    lostByReason,
  };
}

/** Every Won deal, most recent first — the reconciliation input for src/lib/stripe.ts. */
export function listWonDeals(): DealRow[] {
  return db()
    .prepare("SELECT * FROM deals WHERE status = 'won' ORDER BY recorded_at DESC")
    .all() as unknown as DealRow[];
}

export function getDealsByCallIds(callIds: number[]): Map<number, DealRow> {
  const map = new Map<number, DealRow>();
  if (callIds.length === 0) return map;
  const placeholders = callIds.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM deals WHERE call_id IN (${placeholders})`)
    .all(...callIds) as unknown as DealRow[];
  for (const row of rows) map.set(row.call_id, row);
  return map;
}

/** Record (or correct) a Won outcome. Overwrites any prior outcome for this meeting. */
export function recordWon(callId: number, setupFee: number, monthlyRetainer: number): void {
  db()
    .prepare(
      `INSERT INTO deals (call_id, status, agreed_setup_fee, agreed_monthly_retainer, recorded_at)
       VALUES (?, 'won', ?, ?, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         status = 'won',
         agreed_setup_fee = excluded.agreed_setup_fee,
         agreed_monthly_retainer = excluded.agreed_monthly_retainer,
         lost_reason = NULL,
         lost_notes = NULL,
         recorded_at = excluded.recorded_at`,
    )
    .run(callId, setupFee, monthlyRetainer, Date.now());
  logEvent(
    "deal.won",
    `Deal on call ${callId} recorded as won — $${setupFee} setup, $${monthlyRetainer}/mo.`,
    { callId, setupFee, monthlyRetainer },
  );
}

/** Record (or correct) a Lost outcome. Overwrites any prior outcome for this meeting. */
export function recordLost(callId: number, reason: LostReason, notes: string | null): void {
  db()
    .prepare(
      `INSERT INTO deals (call_id, status, lost_reason, lost_notes, recorded_at)
       VALUES (?, 'lost', ?, ?, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         status = 'lost',
         lost_reason = excluded.lost_reason,
         lost_notes = excluded.lost_notes,
         agreed_setup_fee = NULL,
         agreed_monthly_retainer = NULL,
         recorded_at = excluded.recorded_at`,
    )
    .run(callId, reason, notes, Date.now());
  logEvent("deal.lost", `Deal on call ${callId} recorded as lost — ${LOST_REASONS[reason]}.`, {
    callId,
    reason,
  });
}

export interface DealStats {
  /** Booked meetings with no outcome recorded yet — distinct from a real 0. */
  pending: number;
  won: number;
  lost: number;
  bookedTotal: number;
  /** Sums of the ACTUAL agreed price on won deals, not the recommendation. */
  wonRevenue: { setupFees: number; monthlyRetainers: number };
  lostByReason: Partial<Record<LostReason, number>>;
}

export function dealStats(): DealStats {
  const bookedTotal = (
    db().prepare("SELECT COUNT(*) AS n FROM calls WHERE booked = 1").get() as { n: number }
  ).n;

  const rows = db()
    .prepare("SELECT status, lost_reason, agreed_setup_fee, agreed_monthly_retainer FROM deals")
    .all() as unknown as Array<{
    status: DealStatus;
    lost_reason: LostReason | null;
    agreed_setup_fee: number | null;
    agreed_monthly_retainer: number | null;
  }>;

  let won = 0;
  let lost = 0;
  let setupFees = 0;
  let monthlyRetainers = 0;
  const lostByReason: Partial<Record<LostReason, number>> = {};

  for (const row of rows) {
    if (row.status === "won") {
      won++;
      setupFees += row.agreed_setup_fee ?? 0;
      monthlyRetainers += row.agreed_monthly_retainer ?? 0;
    } else {
      lost++;
      if (row.lost_reason) {
        lostByReason[row.lost_reason] = (lostByReason[row.lost_reason] ?? 0) + 1;
      }
    }
  }

  return {
    pending: Math.max(0, bookedTotal - won - lost),
    won,
    lost,
    bookedTotal,
    wonRevenue: { setupFees, monthlyRetainers },
    lostByReason,
  };
}
