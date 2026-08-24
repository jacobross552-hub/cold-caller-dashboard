/**
 * Weekly auto-learning (Segment 6).
 *
 * THREE TIERS, per the brief — but tier 1 doesn't get a new pipeline, it
 * reuses what already exists:
 *
 *   1. CHEAP MODEL, PER-CALL CLASSIFICATION. Already happens today, for every
 *      non-trivial call, as a side effect of brief.ts's analyseCall() — this
 *      job reads the analysis already stored on each call row rather than
 *      re-running anything. Worth being honest about one deviation from the
 *      literal brief: that existing pass runs on config.anthropicModel
 *      (Opus 5 by default), not a genuinely cheap model — that was an
 *      earlier decision made for pre-call-brief quality, and changing it is
 *      outside this segment's job.
 *   2. PLAIN CODE, AGGREGATION. aggregateWeek() below — SQL and arithmetic,
 *      no model call. Pulls from every segment: calls, deals (Won/Lost +
 *      reasons), the price-table check already stored per call, the
 *      conversion funnel, and finance.
 *   3. STRONGER MODEL, SYNTHESIS. One call to config.anthropicModel, reading
 *      ONLY the aggregated JSON — never raw transcripts — plus the CURRENT
 *      live agent prompt (fetched fresh, never a stale local copy) and the
 *      list of previously rejected proposals, so a rejected idea isn't
 *      re-proposed without new evidence.
 *
 * THE SAFETY MECHANISM. Only category='script' proposals can auto-apply to
 * anything live, and only through elevenlabs.ts's updateAgentPrompt, which
 * does a full read-modify-write specifically so a prompt change can never
 * silently detach a tool. The model outputs the COMPLETE new prompt text,
 * never a fragment or a patch instruction — the diff shown in the UI is
 * computed by plain code (computeDiff, below) from the two full strings, so
 * what's displayed can never drift from what accept actually applies. Every
 * accepted script change stores the exact previous prompt text, so revert is
 * exact, not a best-effort reconstruction. A rejection requires a reason,
 * which is fed back into the next run's synthesis prompt.
 *
 * Pricing/lead-targeting/other proposals are advisory only — "Accept" just
 * marks them acknowledged. See the code comment on acceptProposal for why.
 */

import { db, logEvent } from "./db";
import { required } from "./env";
import { getAgentConfig, currentPromptText, updateAgentPrompt } from "./elevenlabs";
import { conversionFunnelInWindow } from "./funnel";
import { windowFinance } from "./finance";
import { bandForWeeklyFigure } from "./pricing";
import { priceAnthropicUsage } from "./costs";
import { zoneClock } from "./calling-hours";
import { synthesizeProposals, MIN_PRICING_SAMPLE, type PriorRejection } from "./learning-synthesis";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------------
 * Tier 2 — aggregation
 * ------------------------------------------------------------------------ */

export interface WeeklyStats {
  windowStart: number;
  windowEnd: number;
  callsAnalysed: number;
  outcomeBreakdown: Record<string, number>;
  furthestStageBreakdown: Record<string, number>;
  askedIfAiCount: number;
  figureAgreedBreakdown: Record<string, number>;
  objectionCounts: Record<string, number>;
  agentSlips: string[];
  quoteCheckBreakdown: Record<string, number>;
  pricingVsActual: Array<{
    band: string;
    recommendedSetup: number;
    recommendedRetainer: number;
    actualSetup: number;
    actualRetainer: number;
  }>;
  funnel: ReturnType<typeof conversionFunnelInWindow>;
  finance: Awaited<ReturnType<typeof windowFinance>>;
}

interface StoredAnalysis {
  analysis?: {
    furthest_stage?: string;
    asked_if_ai?: boolean;
    figure_agreed?: string;
    objections?: Array<{ objection?: string }>;
    agent_slips?: string[];
    discounted_weekly_loss?: number | null;
    prospect_own_figure?: number | null;
  };
  quoteCheck?: { status?: string };
}

export async function aggregateWeek(windowStart: number, windowEnd: number): Promise<WeeklyStats> {
  const database = db();

  const calls = database
    .prepare(
      `SELECT outcome, analysis_json FROM calls WHERE created_at >= ? AND created_at < ? AND analysis_json IS NOT NULL`,
    )
    .all(windowStart, windowEnd) as unknown as Array<{ outcome: string | null; analysis_json: string }>;

  const outcomeBreakdown: Record<string, number> = {};
  const furthestStageBreakdown: Record<string, number> = {};
  const figureAgreedBreakdown: Record<string, number> = {};
  const objectionCounts: Record<string, number> = {};
  const quoteCheckBreakdown: Record<string, number> = {};
  const agentSlips: string[] = [];
  let askedIfAiCount = 0;

  for (const row of calls) {
    if (row.outcome) outcomeBreakdown[row.outcome] = (outcomeBreakdown[row.outcome] ?? 0) + 1;

    let parsed: StoredAnalysis;
    try {
      parsed = JSON.parse(row.analysis_json) as StoredAnalysis;
    } catch {
      continue;
    }
    const a = parsed.analysis;
    if (!a) continue;

    if (a.furthest_stage) furthestStageBreakdown[a.furthest_stage] = (furthestStageBreakdown[a.furthest_stage] ?? 0) + 1;
    if (a.figure_agreed) figureAgreedBreakdown[a.figure_agreed] = (figureAgreedBreakdown[a.figure_agreed] ?? 0) + 1;
    if (a.asked_if_ai) askedIfAiCount++;
    if (parsed.quoteCheck?.status) {
      quoteCheckBreakdown[parsed.quoteCheck.status] = (quoteCheckBreakdown[parsed.quoteCheck.status] ?? 0) + 1;
    }
    for (const objection of a.objections ?? []) {
      const label = (objection.objection ?? "").trim().toLowerCase();
      if (!label) continue;
      objectionCounts[label] = (objectionCounts[label] ?? 0) + 1;
    }
    for (const slip of a.agent_slips ?? []) {
      if (slip) agentSlips.push(slip);
    }
  }

  // Segment 3 vs Segment 2: what the table recommended for a Won deal's
  // originating call, against what was actually agreed — grouped by band.
  const wonWithFigures = database
    .prepare(
      `SELECT d.agreed_setup_fee, d.agreed_monthly_retainer, c.analysis_json
         FROM deals d JOIN calls c ON c.id = d.call_id
        WHERE d.status = 'won' AND d.recorded_at >= ? AND d.recorded_at < ?`,
    )
    .all(windowStart, windowEnd) as unknown as Array<{
    agreed_setup_fee: number | null;
    agreed_monthly_retainer: number | null;
    analysis_json: string | null;
  }>;

  const byBand = new Map<string, { recommendedSetup: number; recommendedRetainer: number; actualSetup: number[]; actualRetainer: number[] }>();
  for (const row of wonWithFigures) {
    if (!row.analysis_json || row.agreed_setup_fee === null || row.agreed_monthly_retainer === null) continue;
    let parsed: StoredAnalysis;
    try {
      parsed = JSON.parse(row.analysis_json) as StoredAnalysis;
    } catch {
      continue;
    }
    const figure = parsed.analysis?.discounted_weekly_loss ?? parsed.analysis?.prospect_own_figure;
    const band = bandForWeeklyFigure(figure ?? null);
    if (!band) continue;

    const bucket = byBand.get(band.label) ?? {
      recommendedSetup: band.setupFee,
      recommendedRetainer: band.monthlyRetainer,
      actualSetup: [],
      actualRetainer: [],
    };
    bucket.actualSetup.push(row.agreed_setup_fee);
    bucket.actualRetainer.push(row.agreed_monthly_retainer);
    byBand.set(band.label, bucket);
  }

  const pricingVsActual = [...byBand.entries()].map(([band, b]) => ({
    band,
    recommendedSetup: b.recommendedSetup,
    recommendedRetainer: b.recommendedRetainer,
    actualSetup: Math.round(b.actualSetup.reduce((s, n) => s + n, 0) / b.actualSetup.length),
    actualRetainer: Math.round(b.actualRetainer.reduce((s, n) => s + n, 0) / b.actualRetainer.length),
  }));

  const [funnel, finance] = await Promise.all([
    Promise.resolve(conversionFunnelInWindow(windowStart, windowEnd)),
    windowFinance(windowStart, windowEnd),
  ]);

  return {
    windowStart,
    windowEnd,
    callsAnalysed: calls.length,
    outcomeBreakdown,
    furthestStageBreakdown,
    askedIfAiCount,
    figureAgreedBreakdown,
    objectionCounts,
    agentSlips,
    quoteCheckBreakdown,
    pricingVsActual,
    funnel,
    finance,
  };
}

/* ---------------------------------------------------------------------------
 * Diffing — plain code, so the UI can never show something other than what
 * accept actually applies.
 * ------------------------------------------------------------------------ */

export interface DiffLine {
  type: "same" | "added" | "removed";
  text: string;
}

/** Line-level diff. Simple LCS-based approach — prompts are hundreds of lines, not megabytes. */
export function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "removed", text: a[i] });
      i++;
    } else {
      result.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < n) result.push({ type: "removed", text: a[i++] });
  while (j < m) result.push({ type: "added", text: b[j++] });
  return result;
}

/* ---------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

export interface LearningRunRow {
  id: number;
  week_start: number;
  week_end: number;
  status: "running" | "completed" | "failed";
  stats_json: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface LearningProposalRow {
  id: number;
  run_id: number;
  category: "script" | "pricing" | "lead_targeting" | "other";
  title: string;
  reasoning: string;
  confidence: string;
  sample_size: number | null;
  previous_prompt_text: string | null;
  new_prompt_text: string | null;
  status: "pending" | "accepted" | "rejected";
  rejected_reason: string | null;
  decided_at: number | null;
  applied_at: number | null;
  reverted_at: number | null;
  created_at: number;
}

/**
 * Run the weekly job now, over [now - 7 days, now). Idempotent per week via
 * week_start's UNIQUE constraint — if a run already exists for this exact
 * window, does nothing rather than erroring, so the scheduler's once-a-minute
 * heartbeat landing inside the trigger window twice can't double-run it.
 */
export async function runWeeklyLearning(windowEnd: number = Date.now()): Promise<LearningRunRow | null> {
  const windowStart = windowEnd - 7 * MS_PER_DAY;
  const database = db();

  const existing = database.prepare("SELECT * FROM learning_runs WHERE week_start = ?").get(windowStart) as
    | LearningRunRow
    | undefined;
  if (existing) return existing;

  // created_at anchors to windowEnd (the reference instant the whole window is
  // computed from) rather than a separately-sampled Date.now() — in normal
  // operation windowEnd IS effectively now, so this changes nothing live, but
  // it keeps one function call internally consistent about what "now" means.
  const runId = database
    .prepare("INSERT INTO learning_runs (week_start, week_end, status, created_at) VALUES (?, ?, 'running', ?)")
    .run(windowStart, windowEnd, windowEnd).lastInsertRowid as number;

  try {
    const agentId = required("ELEVENLABS_AGENT_ID");
    const [stats, agentConfig] = await Promise.all([aggregateWeek(windowStart, windowEnd), getAgentConfig(agentId)]);
    const liveScript = currentPromptText(agentConfig);

    const priorRejections = database
      .prepare(
        `SELECT category, title, reasoning, rejected_reason FROM learning_proposals
          WHERE status = 'rejected' ORDER BY created_at DESC LIMIT 20`,
      )
      .all() as unknown as PriorRejection[];

    const { proposals: rawProposals, usage } = await synthesizeProposals(stats, liveScript, priorRejections);

    // Code-level backstop, not just a prompt instruction — a pricing proposal
    // below the stated minimum sample is dropped rather than trusted at face
    // value, same principle as calling-hours.ts enforcing outside the prompt:
    // a rule stated only to the model can be missed. Lives here rather than
    // inside synthesizeProposals so it applies no matter what the model
    // returns, and so it's independently testable from the LLM call itself.
    const priced = rawProposals.filter((p) => p.category !== "pricing" || (p.sample_size ?? 0) >= MIN_PRICING_SAMPLE);

    // Second backstop: at most one script proposal survives even if the
    // model returns more than one despite the prompt instruction — each one
    // costs a full copy of the live prompt to generate, which is exactly
    // what caused a real truncated-JSON failure before MAX_OUTPUT_TOKENS was
    // raised. Keep the first, drop the rest, rather than trusting the model
    // to have honoured the "at most one" rule.
    let keptScriptOne = false;
    const proposals = priced.filter((p) => {
      if (p.category !== "script") return true;
      if (keptScriptOne) return false;
      keptScriptOne = true;
      return true;
    });

    // Same rule as calls.ts's per-call analysis: every Anthropic call this
    // app makes gets logged here, or the dashboard's own spend goes invisible
    // on /costs. Priced now at today's rate and frozen on the row.
    database
      .prepare(
        `INSERT INTO ai_usage (call_id, purpose, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (NULL, 'weekly_learning', ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        priceAnthropicUsage(usage.model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
        Date.now(),
      );

    const insertProposal = database.prepare(
      `INSERT INTO learning_proposals
         (run_id, category, title, reasoning, confidence, sample_size, previous_prompt_text, new_prompt_text, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const p of proposals) {
      insertProposal.run(
        runId,
        p.category,
        p.title,
        p.reasoning,
        p.confidence,
        p.sample_size,
        p.category === "script" ? liveScript : null,
        p.category === "script" ? p.new_prompt_text : null,
        Date.now(),
      );
    }

    database
      .prepare("UPDATE learning_runs SET status = 'completed', stats_json = ?, completed_at = ? WHERE id = ?")
      .run(JSON.stringify(stats), Date.now(), runId);

    logEvent(
      "learning.run_completed",
      `Weekly learning run produced ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}.`,
      { runId },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    database.prepare("UPDATE learning_runs SET status = 'failed', error = ? WHERE id = ?").run(detail, runId);
    logEvent("learning.run_failed", `Weekly learning run failed: ${detail}`, { runId });
  }

  return database.prepare("SELECT * FROM learning_runs WHERE id = ?").get(runId) as unknown as LearningRunRow;
}

/**
 * Accept a proposal.
 *
 * Only category='script' auto-applies to anything live — it PATCHes
 * ElevenLabs via the read-modify-write in elevenlabs.ts. Pricing/
 * lead-targeting/other proposals are advisory: accepting just marks them
 * acknowledged. Reasoning kept in the code, not just here: pricing.ts's own
 * header comment is an existing, deliberate decision from Bob ("If Bob
 * changes his pricing, it changes in those files first and then here — never
 * the other way round") — auto-writing to the live price table would reverse
 * that without being asked to. Flagged to Bob rather than assumed either way.
 */
export async function acceptProposal(proposalId: number): Promise<void> {
  const database = db();
  const proposal = database.prepare("SELECT * FROM learning_proposals WHERE id = ?").get(proposalId) as
    | LearningProposalRow
    | undefined;
  if (!proposal || proposal.status !== "pending") return;

  if (proposal.category === "script") {
    if (!proposal.new_prompt_text) throw new Error("Script proposal has no new prompt text to apply.");
    const agentId = required("ELEVENLABS_AGENT_ID");
    await updateAgentPrompt(agentId, proposal.new_prompt_text);
  }

  const now = Date.now();
  database
    .prepare("UPDATE learning_proposals SET status = 'accepted', decided_at = ?, applied_at = ? WHERE id = ?")
    .run(now, now, proposalId);

  logEvent("learning.proposal_accepted", `Accepted proposal ${proposalId}: ${proposal.title}`, { proposalId });
}

export function rejectProposal(proposalId: number, reason: string): void {
  const database = db();
  const proposal = database.prepare("SELECT * FROM learning_proposals WHERE id = ?").get(proposalId) as
    | LearningProposalRow
    | undefined;
  if (!proposal || proposal.status !== "pending") return;

  database
    .prepare("UPDATE learning_proposals SET status = 'rejected', rejected_reason = ?, decided_at = ? WHERE id = ?")
    .run(reason, Date.now(), proposalId);

  logEvent("learning.proposal_rejected", `Rejected proposal ${proposalId}: ${proposal.title} — ${reason}`, {
    proposalId,
  });
}

/**
 * One-click revert of an applied script change — restores the EXACT prompt
 * text that was live before this proposal was accepted, via the same
 * read-modify-write PATCH.
 */
export async function revertProposal(proposalId: number): Promise<void> {
  const database = db();
  const proposal = database.prepare("SELECT * FROM learning_proposals WHERE id = ?").get(proposalId) as
    | LearningProposalRow
    | undefined;
  if (!proposal || proposal.status !== "accepted" || proposal.category !== "script" || proposal.reverted_at) return;
  if (!proposal.previous_prompt_text) throw new Error("No previous prompt text stored — cannot revert exactly.");

  const agentId = required("ELEVENLABS_AGENT_ID");
  await updateAgentPrompt(agentId, proposal.previous_prompt_text);

  database.prepare("UPDATE learning_proposals SET reverted_at = ? WHERE id = ?").run(Date.now(), proposalId);
  logEvent("learning.proposal_reverted", `Reverted proposal ${proposalId}: ${proposal.title}`, { proposalId });
}

export function pendingProposals(): Array<LearningProposalRow & { run: LearningRunRow }> {
  const database = db();
  const rows = database
    .prepare(
      `SELECT p.*, r.week_start as run_week_start, r.week_end as run_week_end
         FROM learning_proposals p JOIN learning_runs r ON r.id = p.run_id
        WHERE p.status = 'pending' ORDER BY p.created_at DESC`,
    )
    .all() as unknown as Array<LearningProposalRow & { run_week_start: number; run_week_end: number }>;

  return rows.map((row) => ({
    ...row,
    run: { week_start: row.run_week_start, week_end: row.run_week_end } as LearningRunRow,
  }));
}

/** Applied history, separate from this week's pending proposals — script changes only, since that's the only category with a live effect to show a timeline of. */
export function appliedHistory(): LearningProposalRow[] {
  return db()
    .prepare(
      `SELECT * FROM learning_proposals WHERE category = 'script' AND status = 'accepted' ORDER BY applied_at DESC`,
    )
    .all() as unknown as LearningProposalRow[];
}

export function latestRun(): LearningRunRow | null {
  return (
    (db().prepare("SELECT * FROM learning_runs ORDER BY week_start DESC LIMIT 1").get() as LearningRunRow | undefined) ??
    null
  );
}

/**
 * Called from dispatcher.ts's existing one-minute heartbeat — no separate
 * cron mechanism. Fires Monday 6am Sydney (before the work day starts, per
 * the standing decision), with a 10-minute grace window in case the exact
 * top-of-hour tick is missed (a restart, a slow tick). Deduped by checking
 * whether ANY run was created in the last 20 hours — safely inside the grace
 * window (won't re-fire on minute 2 having already fired on minute 0) and
 * safely outside next week's window (won't block it 6+ days later).
 * learning_runs.week_start's UNIQUE constraint is the final backstop.
 */
export async function weeklyLearningTick(at: Date = new Date()): Promise<void> {
  const clock = zoneClock(at, "Australia/Sydney");
  if (clock.weekday !== 1 || clock.hour !== 6 || clock.minute >= 10) return;

  const recentRun = db()
    .prepare("SELECT id FROM learning_runs WHERE created_at > ?")
    .get(at.getTime() - 20 * 60 * 60 * 1000);
  if (recentRun) return;

  await runWeeklyLearning(at.getTime());
}
