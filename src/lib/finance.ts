/**
 * Weekly profit: revenue this week minus costs this week, plus a reinvestment
 * calculator and a short revenue/cost/profit history for the graphs.
 *
 * Same discipline as costs.ts: every figure says where it came from, and
 * nothing is blended silently. Revenue is "measured" (real Stripe receipts)
 * only when Stripe is configured — otherwise it's "recorded" (what was typed
 * in when a deal was marked Won), and the page must say which one it's
 * showing. Cost reuses costs.ts's real subscription rates, prorated over the
 * shorter window, plus real per-event spend recorded in that window.
 */

import { db } from "./db";
import { config, optional } from "./env";
import { plan as subscriptionPlan, railwayMonthlyUsd } from "./costs";
import { money } from "./lead-finder/cost";
import { listWonDeals, type DealRow } from "./deals";
import { stripeConfigured, fetchRecentPayments, reconcileWonDeals, type ReconcileResult } from "./stripe";
import { conversionFunnel, type ConversionFunnel } from "./funnel";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.44;

/**
 * Same env var costs.ts already uses to override "running since" — reused
 * rather than adding a second, near-duplicate date knob. Setting it also
 * moves the /costs page's "months running" figure, which is the same
 * underlying fact (when the operation actually started), not a side effect
 * to work around.
 */
function financeSinceCutoff(): number | null {
  const raw = optional("COSTS_SINCE");
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export type RevenueProvenance = "measured" | "recorded";

export interface WindowFinance {
  windowStart: number;
  windowEnd: number;
  revenueAud: number;
  revenueProvenance: RevenueProvenance;
  revenueNote: string;
  costAud: number;
  costNote: string;
  profitAud: number;
}

/** Real per-event spend recorded inside [start, end), already in AUD. */
function measuredCostInWindow(start: number, end: number): number {
  const fx = config.usdAudRate;
  const database = db();

  const calls = database
    .prepare(`SELECT COALESCE(SUM(cost_fiat_usd), 0) AS usd FROM calls WHERE created_at >= ? AND created_at < ?`)
    .get(start, end) as { usd: number };

  const twilioCalls = database
    .prepare(
      `SELECT COALESCE(SUM(twilio_price), 0) AS usd FROM calls
        WHERE created_at >= ? AND created_at < ? AND twilio_price IS NOT NULL AND twilio_price_unit = 'USD'`,
    )
    .get(start, end) as { usd: number };

  const twilioSms = database
    .prepare(
      `SELECT COALESCE(SUM(price), 0) AS usd FROM sms_sends
        WHERE created_at >= ? AND created_at < ? AND price IS NOT NULL AND price_unit = 'USD'`,
    )
    .get(start, end) as { usd: number };

  const ai = database
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE created_at >= ? AND created_at < ?`)
    .get(start, end) as { usd: number };

  const leadSourcing = database
    .prepare(
      `SELECT COALESCE(SUM(unit_cost_usd), 0) AS usd FROM lead_api_calls WHERE called_at >= ? AND called_at < ?`,
    )
    .get(start, end) as { usd: number };

  // calls.cost_fiat_usd already includes the voice+LLM total ElevenLabs charged
  // for that call — but a call inside the included pool costs the plan fee
  // nothing extra. Prorating the plan fee below AND summing every call's full
  // fiat cost here would double-count the pool. So this line only counts what
  // Twilio, Anthropic and lead-sourcing actually charged — genuinely separate
  // bills — and leaves ElevenLabs' own per-call cost to the prorated plan
  // line, which is the honest way to attribute a pooled subscription over a
  // window shorter than the billing period.
  const usdTotal = twilioCalls.usd + twilioSms.usd + ai.usd + leadSourcing.usd;
  void calls; // read for completeness of intent, not summed — see comment above.
  return money(usdTotal * fx);
}

/**
 * The window's share of the flat monthly subscriptions (ElevenLabs plan fee,
 * Railway), prorated by days. This is the only way to put a number on "this
 * week's" cost of a bill that's actually billed monthly — it's an even split,
 * not a claim that the bill literally lands in seven equal pieces.
 */
function proratedSubscriptionCostInWindow(days: number): number {
  const p = subscriptionPlan();
  const share = days / DAYS_PER_MONTH;
  return money((p.monthlyUsd + railwayMonthlyUsd()) * share * config.usdAudRate);
}

/** Revenue actually recorded (deals marked Won) inside [start, end). "Recorded", not "measured" — see module doc. */
function recordedRevenueInWindow(start: number, end: number): number {
  const rows = db()
    .prepare(
      `SELECT COALESCE(SUM(agreed_setup_fee), 0) + COALESCE(SUM(agreed_monthly_retainer), 0) AS aud
         FROM deals WHERE status = 'won' AND recorded_at >= ? AND recorded_at < ?`,
    )
    .get(start, end) as { aud: number };
  return money(rows.aud);
}

/** Stripe payments actually received inside [start, end), converted to AUD. USD and AUD only — same limit as costs.ts's toAud. */
async function measuredRevenueInWindow(start: number, end: number): Promise<number | null> {
  if (!stripeConfigured()) return null;
  const payments = await fetchRecentPayments();
  const fx = config.usdAudRate;
  let aud = 0;
  for (const p of payments) {
    if (p.createdAt < start || p.createdAt >= end) continue;
    if (p.currency === "AUD") aud += p.amount;
    else if (p.currency === "USD") aud += p.amount * fx;
    // Any other currency is skipped rather than guessed at — same rule costs.ts follows.
  }
  return money(aud);
}

/** Revenue minus cost for an arbitrary window. Used both for "this week" and for the history series. */
export async function windowFinance(start: number, end: number): Promise<WindowFinance> {
  // Never look earlier than COSTS_SINCE — a window whose nominal start
  // predates it gets clamped to it, so the earliest reported window is
  // shorter rather than reaching back into pre-launch test data.
  const cutoff = financeSinceCutoff();
  const clampedStart = cutoff !== null ? Math.max(start, cutoff) : start;

  const days = (end - clampedStart) / MS_PER_DAY;
  const cost = measuredCostInWindow(clampedStart, end) + proratedSubscriptionCostInWindow(days);

  const measured = await measuredRevenueInWindow(clampedStart, end);
  const revenueAud = measured ?? recordedRevenueInWindow(clampedStart, end);
  const revenueProvenance: RevenueProvenance = measured !== null ? "measured" : "recorded";

  return {
    windowStart: clampedStart,
    windowEnd: end,
    revenueAud,
    revenueProvenance,
    revenueNote:
      revenueProvenance === "measured"
        ? "Actual payments received, from Stripe."
        : "What was recorded when a deal was marked Won — not yet confirmed against Stripe. Add STRIPE_SECRET_KEY to check it.",
    costAud: cost,
    costNote: `Real Twilio/Anthropic/lead-sourcing spend this window, plus this window's share (${days.toFixed(1)} of ~${DAYS_PER_MONTH.toFixed(0)} days) of the flat ElevenLabs and hosting subscriptions.`,
    profitAud: money(revenueAud - cost),
  };
}

/** This rolling 7-day window, ending now. */
export async function thisWeek(): Promise<WindowFinance> {
  const end = Date.now();
  return windowFinance(end - 7 * MS_PER_DAY, end);
}

export interface WeekPoint extends WindowFinance {
  label: string;
}

/** The last `weeks` rolling 7-day windows, oldest first, for the history graph. */
export async function financeSeries(weeks = 12): Promise<WeekPoint[]> {
  const end = Date.now();
  const cutoff = financeSinceCutoff();
  const points: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const windowEnd = end - i * 7 * MS_PER_DAY;
    const windowStart = windowEnd - 7 * MS_PER_DAY;
    // A week that ends before the cutoff didn't happen yet, business-wise —
    // skip it rather than showing a bar for a week before things started.
    if (cutoff !== null && windowEnd <= cutoff) continue;
    const w = await windowFinance(windowStart, windowEnd);
    points.push({
      ...w,
      // Labelled from w.windowStart (post-clamp), so the boundary week reads
      // as starting on the cutoff date rather than a nominal earlier one.
      label: new Date(w.windowStart).toLocaleDateString("en-AU", { day: "numeric", month: "short" }),
    });
  }
  return points;
}

export interface ReinvestmentScenario {
  pct: number;
  reinvestAud: number;
  drawAud: number;
}

/**
 * CALCULATOR ONLY. Moving through these percentages changes what's displayed
 * here and nowhere else — never a live system setting, never the daily call
 * cap, never anything ElevenLabs/Twilio-side. Per the standing decision.
 */
export function reinvestmentScenarios(profitAud: number): ReinvestmentScenario[] {
  const presets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const positive = Math.max(0, profitAud);
  return presets.map((pct) => ({
    pct,
    reinvestAud: money(positive * (pct / 100)),
    drawAud: money(positive * (1 - pct / 100)),
  }));
}

export interface FinanceOverview {
  week: WindowFinance;
  series: WeekPoint[];
  reinvestment: ReinvestmentScenario[];
  funnel: ConversionFunnel;
  reconciliation: ReconcileResult;
}

export async function financeOverview(): Promise<FinanceOverview> {
  const week = await thisWeek();
  const [series, reconciliation] = await Promise.all([
    financeSeries(12),
    reconcileWonDeals(listWonDeals() as unknown as Array<Pick<DealRow, "call_id" | "agreed_setup_fee" | "agreed_monthly_retainer" | "recorded_at">>),
  ]);

  return {
    week,
    series,
    reinvestment: reinvestmentScenarios(week.profitAud),
    funnel: conversionFunnel(),
    reconciliation,
  };
}
