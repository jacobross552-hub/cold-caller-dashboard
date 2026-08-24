/**
 * The conversion funnel: answered → booked → bought.
 *
 * Every stage carries its raw count alongside whatever percentage is derived
 * from it — a percentage is never shown without the N behind it, and a stage
 * with nothing recorded yet says so rather than rendering as 0%. Booked and
 * bought both come from tables that exist for their own reasons (calls,
 * deals) — this module only aggregates, it collects no new data itself.
 */

import { db } from "./db";
import { callStats } from "./calls";
import { ANSWERED_OUTCOMES } from "./outcomes";
import { dealStats, dealStatsInWindow, type DealStats } from "./deals";

export interface ConversionFunnel {
  dialled: number;
  answered: number;
  booked: number;
  deals: DealStats;
}

export function conversionFunnel(): ConversionFunnel {
  const stats = callStats();
  const answered = ANSWERED_OUTCOMES.reduce((sum, outcome) => sum + (stats.byOutcome[outcome] ?? 0), 0);
  return {
    dialled: stats.total,
    answered,
    booked: stats.booked,
    deals: dealStats(),
  };
}

/**
 * Same funnel, scoped to calls created in [start, end) — the weekly learning
 * job's input. Excludes outcome='failed' throughout, same as callStats() —
 * see that function's doc comment for why.
 */
export function conversionFunnelInWindow(start: number, end: number): ConversionFunnel {
  const database = db();
  const notFailed = "(outcome IS NULL OR outcome != 'failed')";

  const dialled = (
    database
      .prepare(`SELECT COUNT(*) AS n FROM calls WHERE created_at >= ? AND created_at < ? AND ${notFailed}`)
      .get(start, end) as { n: number }
  ).n;

  const rows = database
    .prepare(
      `SELECT outcome, COUNT(*) AS n FROM calls WHERE created_at >= ? AND created_at < ? AND ${notFailed} GROUP BY outcome`,
    )
    .all(start, end) as unknown as Array<{ outcome: string; n: number }>;
  const byOutcome: Record<string, number> = {};
  for (const row of rows) byOutcome[row.outcome] = row.n;
  const answered = ANSWERED_OUTCOMES.reduce((sum, outcome) => sum + (byOutcome[outcome] ?? 0), 0);

  const booked = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM calls WHERE created_at >= ? AND created_at < ? AND booked = 1 AND ${notFailed}`,
      )
      .get(start, end) as { n: number }
  ).n;

  return { dialled, answered, booked, deals: dealStatsInWindow(start, end) };
}

/** `null` when there's nothing to divide by — the caller renders that as "not enough data yet". */
export function pct(n: number, of: number): number | null {
  if (of <= 0) return null;
  return Math.round((n / of) * 1000) / 10;
}
