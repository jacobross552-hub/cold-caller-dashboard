/**
 * The lead_runs record: what was asked for, what happened, what it cost.
 *
 * COST IS NEVER STORED AS A TOTAL. Every external call writes its own row to
 * `lead_api_calls` with the price that applied at the time, and the run's cost
 * is summed from those rows on read. That means the figure on screen is always
 * derived from calls that actually happened — a crash mid-run leaves an honest
 * partial cost rather than a stale total, and a run from six months ago still
 * shows what it really cost even after Google changes its prices.
 */

import { db } from "../db";
import { money, usdToAud, SKU_LABEL, type Sku } from "./cost";
import type { ApiCallRecord } from "./places";

export type LeadRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface LeadRunRow {
  id: number;
  requester: string | null;
  verticals_json: string;
  locations_json: string;
  target_count: number;
  status: LeadRunStatus;
  stage: string | null;
  queries_json: string | null;
  query_cursor: number;
  candidates_seen: number;
  leads_found: number;
  duplicates_skipped: number;
  suppressed_skipped: number;
  rejected_skipped: number;
  estimated_cost_aud: number | null;
  fx_rate: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
}

export interface CostBreakdownLine {
  sku: Sku;
  label: string;
  calls: number;
  costUsd: number;
  costAud: number;
}

export function createLeadRun(params: {
  verticals: string[];
  locations: string[];
  targetCount: number;
  queries: unknown[];
  estimatedCostAud: number;
  fxRate: number;
  requester?: string;
}): LeadRunRow {
  const info = db()
    .prepare(
      `INSERT INTO lead_runs
         (requester, verticals_json, locations_json, target_count, status, stage,
          queries_json, estimated_cost_aud, fx_rate, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    )
    .run(
      params.requester ?? null,
      JSON.stringify(params.verticals),
      JSON.stringify(params.locations),
      params.targetCount,
      "Queued.",
      JSON.stringify(params.queries),
      params.estimatedCostAud,
      params.fxRate,
      Date.now(),
    );

  return getLeadRun(Number(info.lastInsertRowid))!;
}

export function getLeadRun(id: number): LeadRunRow | null {
  return (db().prepare("SELECT * FROM lead_runs WHERE id = ?").get(id) ?? null) as LeadRunRow | null;
}

export function listLeadRuns(limit = 25): LeadRunRow[] {
  return db()
    .prepare("SELECT * FROM lead_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as LeadRunRow[];
}

/** The run currently working, if any. Only one runs at a time. */
export function activeLeadRun(): LeadRunRow | null {
  return (db()
    .prepare(
      "SELECT * FROM lead_runs WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT 1",
    )
    .get() ?? null) as LeadRunRow | null;
}

export function markRunning(id: number, stage: string) {
  const now = Date.now();
  db()
    .prepare(
      `UPDATE lead_runs
          SET status = 'running', stage = ?, heartbeat_at = ?,
              started_at = COALESCE(started_at, ?)
        WHERE id = ?`,
    )
    .run(stage, now, now, id);
}

/**
 * Save progress. Called after every page of results, which is what makes the
 * auto-refreshing progress panel show real numbers rather than a spinner.
 */
export function saveProgress(
  id: number,
  progress: {
    stage?: string;
    queryCursor?: number;
    candidatesSeen?: number;
    leadsFound?: number;
    duplicatesSkipped?: number;
    suppressedSkipped?: number;
    rejectedSkipped?: number;
  },
) {
  const sets: string[] = ["heartbeat_at = ?"];
  const values: unknown[] = [Date.now()];

  const put = (column: string, value: number | string | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };

  put("stage", progress.stage);
  put("query_cursor", progress.queryCursor);
  put("candidates_seen", progress.candidatesSeen);
  put("leads_found", progress.leadsFound);
  put("duplicates_skipped", progress.duplicatesSkipped);
  put("suppressed_skipped", progress.suppressedSkipped);
  put("rejected_skipped", progress.rejectedSkipped);

  values.push(id);
  db().prepare(`UPDATE lead_runs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
}

export function finishLeadRun(id: number, status: LeadRunStatus, error?: string) {
  db()
    .prepare("UPDATE lead_runs SET status = ?, finished_at = ?, error = ?, stage = ? WHERE id = ?")
    .run(status, Date.now(), error ?? null, describeFinish(status), id);
}

function describeFinish(status: LeadRunStatus): string {
  switch (status) {
    case "completed":
      return "Finished — found everything that was asked for.";
    case "partial":
      return "Finished — ran out of search coverage before hitting the target.";
    case "cancelled":
      return "Cancelled.";
    case "failed":
      return "Stopped with an error.";
    default:
      return "";
  }
}

/** Record one external call, with the price that applied at the time. */
export function logApiCall(runId: number, record: ApiCallRecord, provider: string) {
  db()
    .prepare(
      `INSERT INTO lead_api_calls
         (lead_run_id, provider, sku, detail, http_status, result_count, unit_cost_usd, called_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      provider,
      record.sku,
      record.detail.slice(0, 300),
      record.httpStatus,
      record.resultCount,
      record.unitCostUsd,
      Date.now(),
    );
}

/** Total spent on a run so far, summed from the real call rows. */
export function runCostUsd(runId: number): number {
  const row = db()
    .prepare("SELECT COALESCE(SUM(unit_cost_usd), 0) AS total FROM lead_api_calls WHERE lead_run_id = ?")
    .get(runId) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function runCallCount(runId: number): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM lead_api_calls WHERE lead_run_id = ?")
    .get(runId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Per-SKU breakdown for the results table. */
export function runCostBreakdown(runId: number, fxRate: number): CostBreakdownLine[] {
  const rows = db()
    .prepare(
      `SELECT sku, COUNT(*) AS calls, COALESCE(SUM(unit_cost_usd), 0) AS usd
         FROM lead_api_calls
        WHERE lead_run_id = ?
        GROUP BY sku
        ORDER BY usd DESC`,
    )
    .all(runId) as unknown as Array<{ sku: Sku; calls: number; usd: number }>;

  return rows.map((row) => ({
    sku: row.sku,
    label: SKU_LABEL[row.sku] ?? row.sku,
    calls: row.calls,
    costUsd: money(row.usd),
    costAud: money(usdToAud(row.usd, fxRate)),
  }));
}

/** Everything the UI needs about a run, in one call. */
export function leadRunSummary(runId: number) {
  const run = getLeadRun(runId);
  if (!run) return null;

  const costUsd = runCostUsd(runId);
  return {
    run,
    verticals: JSON.parse(run.verticals_json) as string[],
    locations: JSON.parse(run.locations_json) as string[],
    totalQueries: run.queries_json ? (JSON.parse(run.queries_json) as unknown[]).length : 0,
    apiCalls: runCallCount(runId),
    costUsd: money(costUsd),
    costAud: money(usdToAud(costUsd, run.fx_rate)),
    breakdown: runCostBreakdown(runId, run.fx_rate),
  };
}
