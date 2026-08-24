/**
 * What the whole system has cost, since the day it started, broken down by
 * where the money went.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. Every figure says where it came from. The provenances are never blended
 *    into one number without saying so:
 *
 *      measured    Summed from what the PROVIDER itself charged, per event.
 *                  Auditable, and unaffected by a later price change.
 *      rated       Real recorded usage times a rate. The usage is real; the
 *                  price is a rate, not an invoice line.
 *      included    Real metered usage covered by an allowance already paid
 *                  for. Costs nothing extra. Counted against a pool, NEVER
 *                  added to cash.
 *      configured  A flat subscription the dashboard cannot see.
 *
 * 2. Unpriced stays unpriced. A figure we cannot get shows as "not set" or
 *    "pending", never as $0. A missing number and a genuinely free line item
 *    are different things.
 *
 * 3. METERED IS NOT CHARGED. This is the subtle one, and it is the same class
 *    of error as reading ElevenLabs credits as dollars. The platform_price in
 *    a post-call payload is the metered value of the call at the overage rate
 *    — but the plan includes 275 agent-minutes a month, and while usage sits
 *    inside that pool the invoice reads $0.00. Summing metered value as spend
 *    overstates the bill by the entire value of the included pool, every
 *    month, until the pool is actually exceeded. So the cash line is
 *    max(0, overage beyond the pool), the pool is reported separately, and the
 *    plan fee that buys the pool is counted once as Configured. The same
 *    minutes are never counted twice.
 *
 * 4. NO EXCHANGE RATE IS EVER STORED. Every provider reports money in its own
 *    currency: ElevenLabs and Anthropic in USD, Twilio in whatever this
 *    account bills in, which is read off price_unit and never assumed.
 *    Amounts are held natively and converted once, here, at display time. An
 *    FX rate applied at write time bakes in a number that is wrong tomorrow
 *    and unrecoverable afterwards.
 *
 * See README "Costs" for the same explanation in prose.
 */

import { db } from "./db";
import { config, optional } from "./env";
import { money } from "./lead-finder/cost";
import { fetchNumberRental, twilioConfigured } from "./twilio";

// Re-exported so the payload reader and the aggregation stay one import for
// callers. It lives in its own module because db.ts needs it during migration,
// and db.ts cannot import this file without a cycle.
export { extractCallCost, type CallFiatCost } from "./call-cost";

/** How a figure was arrived at. */
export type Provenance = "measured" | "rated" | "included" | "configured";

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  measured: "Measured",
  rated: "Rated",
  included: "Included",
  configured: "Configured",
};

export const PROVENANCE_BLURB: Record<Provenance, string> = {
  measured: "Summed from what the provider itself charged, per event.",
  rated: "Real recorded usage times a rate — not an invoice line.",
  included: "Real usage covered by an allowance already paid for. No extra cash.",
  configured: "A flat subscription the dashboard can't see. Whatever you set in .env.",
};

/** An amount in the currency the provider actually reported it in. */
export interface Money {
  amount: number;
  currency: string;
}

/* ---------------------------------------------------------------------------
 * Rates
 * ------------------------------------------------------------------------ */

/**
 * Anthropic list prices, USD per MILLION tokens.
 *
 * VERIFIED 19 Aug 2026 against platform.claude.com/docs/en/about-claude/pricing.
 * Cache reads are 0.1x the input rate; 5-minute cache writes are 1.25x.
 *
 * The dashboard sets no cache breakpoints anywhere, so both cache terms are
 * always zero and the two multipliers below are DEFENSIVE, not load-bearing —
 * audited 19 Aug 2026. If caching is ever added, note that a 1-HOUR write is
 * 2x rather than 1.25x and the usage payload does not distinguish the two, so
 * pricing a 1h write with the constant below would understate it.
 *
 * The ElevenLabs agent's own model is deliberately absent from this table: it
 * is billed by ElevenLabs, which reports the price directly in the payload, so
 * pricing that side ourselves would mean inventing a number we were handed.
 *
 * If Anthropic changes its prices, change them HERE and nowhere else. Rows
 * already in ai_usage keep the price they were charged at.
 */
const ANTHROPIC_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const ANTHROPIC_FALLBACK_MODEL = "claude-opus-5";
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Price one Anthropic call from the tokens it reported. Always USD. */
export function priceAnthropicUsage(model: string, usage: AnthropicUsage): number {
  const rate = ANTHROPIC_USD_PER_MTOK[model] ?? ANTHROPIC_USD_PER_MTOK[ANTHROPIC_FALLBACK_MODEL];
  const perToken = (n: number, usdPerMTok: number) => (n / 1_000_000) * usdPerMTok;

  return (
    perToken(usage.inputTokens, rate.input) +
    perToken(usage.outputTokens, rate.output) +
    perToken(usage.cacheReadTokens ?? 0, rate.input * CACHE_READ_MULTIPLIER) +
    perToken(usage.cacheWriteTokens ?? 0, rate.input * CACHE_WRITE_MULTIPLIER)
  );
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Null when unset, so "not configured" stays distinct from "configured as 0". */
function optionalNumberFromEnv(name: string): number | null {
  const raw = optional(name);
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/* ---------------------------------------------------------------------------
 * The ElevenLabs plan and its included pool
 * ------------------------------------------------------------------------ */

/**
 * The plan's shape, all configurable because it changes when the plan changes.
 *
 * Defaults are the Creator plan as read off the billing console on 19 Aug
 * 2026: $22 base + 10% GST = $24.20 charged monthly, 275 agent-minutes
 * included, $0.08/min beyond that, billing anchored to the 13th.
 */
/** Exported so src/lib/finance.ts can prorate the same real subscription rate over a shorter window, rather than re-reading .env itself. */
export function railwayMonthlyUsd(): number {
  return numberFromEnv("RAILWAY_MONTHLY_USD", 0);
}

/** Exported so src/lib/finance.ts can prorate the same real subscription rates over a shorter window, rather than re-reading .env itself. */
export function plan() {
  return {
    monthlyUsd: numberFromEnv("ELEVENLABS_PLAN_MONTHLY_USD", 24.2),
    includedMinutes: numberFromEnv("ELEVENLABS_INCLUDED_MINUTES_PER_MONTH", 275),
    overageUsdPerMin: numberFromEnv("ELEVENLABS_OVERAGE_USD_PER_MIN", 0.08),
    anchorDay: Math.min(28, Math.max(1, numberFromEnv("ELEVENLABS_BILLING_ANCHOR_DAY", 13))),
    /**
     * Deliberately unset by default. The plan clearly includes some LLM
     * allowance — the payload carries free_llm_dollars_consumed — but the
     * console does not state the figure, and the invoice shows $0.00 overage.
     * Guessing it would be exactly the fabrication this module exists to
     * prevent, so until it is set, agent LLM usage is reported as metered
     * value and excluded from cash.
     */
    includedLlmUsd: optionalNumberFromEnv("ELEVENLABS_INCLUDED_LLM_USD_PER_MONTH"),
  };
}

/** Start of the billing period containing `at`, given a monthly anchor day. */
function periodStart(at: number, anchorDay: number): number {
  const d = new Date(at);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), anchorDay, 0, 0, 0, 0));
  if (start.getTime() > at) start.setUTCMonth(start.getUTCMonth() - 1);
  return start.getTime();
}

export interface PoolPeriod {
  startedAt: number;
  minutesUsed: number;
  includedMinutes: number;
  overageMinutes: number;
  overageUsd: number;
  llmMeteredUsd: number;
}

/**
 * Bucket every call into its billing period and work out what actually cost
 * cash beyond the included pool.
 *
 * Minutes come from ElevenLabs' own billable-minute figure where we have it,
 * falling back to wall-clock duration only when we do not — and that fallback
 * runs slightly high, which is the safe direction for an overage calculation.
 */
export function poolPeriods(): PoolPeriod[] {
  const p = plan();
  const rows = db()
    .prepare(
      `SELECT started_at, created_at, platform_minutes, duration_secs, llm_price_usd FROM calls`,
    )
    .all() as unknown as Array<{
    started_at: number | null;
    created_at: number;
    platform_minutes: number | null;
    duration_secs: number | null;
    llm_price_usd: number | null;
  }>;

  const byPeriod = new Map<number, { minutes: number; llm: number }>();

  for (const row of rows) {
    const at = row.started_at ?? row.created_at;
    const minutes = row.platform_minutes ?? (row.duration_secs ?? 0) / 60;
    const key = periodStart(at, p.anchorDay);
    const bucket = byPeriod.get(key) ?? { minutes: 0, llm: 0 };
    bucket.minutes += minutes;
    bucket.llm += row.llm_price_usd ?? 0;
    byPeriod.set(key, bucket);
  }

  return [...byPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startedAt, bucket]) => {
      const overageMinutes = Math.max(0, bucket.minutes - p.includedMinutes);
      return {
        startedAt,
        minutesUsed: bucket.minutes,
        includedMinutes: p.includedMinutes,
        overageMinutes,
        overageUsd: overageMinutes * p.overageUsdPerMin,
        llmMeteredUsd: bucket.llm,
      };
    });
}

/* ---------------------------------------------------------------------------
 * Railway runway
 * ------------------------------------------------------------------------ */

export interface Runway {
  grantUsd: number;
  usedUsd: number;
  remainingUsd: number;
  /** Observed spend divided by the days it accrued over. */
  burnUsdPerDay: number | null;
  /** Epoch ms the credits are projected to run out. */
  exhaustedAt: number | null;
  daysRemaining: number | null;
  observedAt: number | null;
}

/**
 * How long the Railway credit grant lasts at the observed burn.
 *
 * NOT a cost line. Railway is a trial workspace with a ONE-TIME credit grant,
 * no card on file and no recurring fee, so its monthly cost is genuinely $0 —
 * booking that grant as a monthly charge would be a fabrication, and a
 * recurring one at that. The real risk is different and deserves its own
 * surface: Railway shuts deployments down when credits run out, so the live
 * dashboard goes off the air with no card on file to absorb it.
 *
 * The burn is computed from an observed usage reading rather than hardcoded,
 * so it tracks reality as the reading is updated.
 */
export function railwayRunway(systemStart: number | null): Runway | null {
  const grant = optionalNumberFromEnv("RAILWAY_CREDIT_GRANT_USD");
  const used = optionalNumberFromEnv("RAILWAY_CREDITS_USED_USD");
  if (grant === null || used === null) return null;

  const observedRaw = optional("RAILWAY_CREDITS_OBSERVED_AT");
  const observedAt = observedRaw ? Date.parse(observedRaw) : Date.now();
  if (!Number.isFinite(observedAt)) return null;

  const remaining = Math.max(0, grant - used);
  const accruedDays = systemStart ? (observedAt - systemStart) / 86_400_000 : null;

  // Under half a day of history cannot support a daily rate worth showing.
  const burn = accruedDays !== null && accruedDays >= 0.5 ? used / accruedDays : null;
  const daysRemaining = burn !== null && burn > 0 ? remaining / burn : null;

  return {
    grantUsd: grant,
    usedUsd: used,
    remainingUsd: remaining,
    burnUsdPerDay: burn,
    exhaustedAt: daysRemaining !== null ? Date.now() + daysRemaining * 86_400_000 : null,
    daysRemaining,
    observedAt,
  };
}

/* ---------------------------------------------------------------------------
 * Aggregation
 * ------------------------------------------------------------------------ */

export interface CostLine {
  key: string;
  label: string;
  provider: string;
  provenance: Provenance;
  /** The amount as the provider reported it. Null when we do not have one. */
  native: Money | null;
  /** `native` converted for display. Null when unpriced or unconvertible. */
  aud: number | null;
  /** The recorded usage behind the figure. */
  basis: string;
  /** Shown when there is no figure — what to do about it. */
  missing?: string;
  /**
   * True when this line is real usage covered by an allowance, so it must not
   * reach the cash total no matter what `native` says.
   */
  excludedFromTotal?: boolean;
}

export interface CostBreakdown {
  lines: CostLine[];
  /** Sum of every cash line we could price, in AUD. */
  totalAud: number;
  incomplete: boolean;
  since: number | null;
  monthsLive: number;
  fxRate: number;
  periods: PoolPeriod[];
  runway: Runway | null;
}

/** Earliest recorded activity across every table that records time. */
function firstActivityAt(): number | null {
  const override = optional("COSTS_SINCE");
  if (override) {
    const parsed = Date.parse(override);
    if (Number.isFinite(parsed)) return parsed;
  }

  const row = db()
    .prepare(
      `SELECT MIN(t) AS first FROM (
         SELECT MIN(created_at) AS t FROM calls
         UNION ALL SELECT MIN(created_at) FROM lead_runs
         UNION ALL SELECT MIN(created_at) FROM runs
         UNION ALL SELECT MIN(created_at) FROM leads
       ) WHERE t IS NOT NULL`,
    )
    .get() as { first: number | null } | undefined;

  return row?.first ?? null;
}

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

function monthsSince(start: number | null): number {
  if (!start) return 1;
  return Math.max(1, Math.ceil((Date.now() - start) / MS_PER_MONTH));
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Convert to AUD for display only — never stored.
 *
 * Only USD is convertible, because USD_AUD_RATE is the only rate configured.
 * Anything else returns null rather than passing the amount through as if it
 * were already AUD, which would silently misreport a Twilio charge billed in
 * some third currency.
 */
function toAud(m: Money | null, fxRate: number): number | null {
  if (!m) return null;
  const currency = m.currency.toUpperCase();
  if (currency === "AUD") return money(m.amount);
  if (currency === "USD") return money(m.amount * fxRate);
  return null;
}

function usd(amount: number): Money {
  return { amount, currency: "USD" };
}

/**
 * Async because the Twilio number rental is read live from Twilio's Pricing
 * API rather than typed into .env — an AU mobile number rents for $8.25/mo
 * against $3.00 for a local one, and a typed rate goes stale silently. The
 * lookup carries its own timeout and degrades to an unpriced line.
 */
export async function lifetimeCosts(): Promise<CostBreakdown> {
  const database = db();
  const fxRate = config.usdAudRate;
  const since = firstActivityAt();
  const monthsLive = monthsSince(since);
  const p = plan();
  const periods = poolPeriods();
  const lines: CostLine[] = [];

  const push = (line: Omit<CostLine, "aud">) =>
    lines.push({ ...line, aud: line.excludedFromTotal ? null : toAud(line.native, fxRate) });

  /* --- ElevenLabs -------------------------------------------------------- */

  push({
    key: "elevenlabs_plan",
    label: "ElevenLabs plan fee",
    provider: "ElevenLabs",
    provenance: "configured",
    native: usd(p.monthlyUsd * monthsLive),
    basis: `${plural(monthsLive, "month")} at $${p.monthlyUsd.toFixed(2)} USD including GST. This is what buys the ${p.includedMinutes}-minute pool.`,
  });

  const el = database
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(platform_price_usd), 0) AS platform,
              COALESCE(SUM(llm_price_usd), 0)      AS llm,
              SUM(CASE WHEN cost_fiat_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM calls`,
    )
    .get() as { calls: number; platform: number; llm: number; unpriced: number };

  const totalOverage = periods.reduce((sum, x) => sum + x.overageUsd, 0);
  const totalMinutes = periods.reduce((sum, x) => sum + x.minutesUsed, 0);
  const overageMinutes = periods.reduce((sum, x) => sum + x.overageMinutes, 0);

  push({
    key: "elevenlabs_voice",
    label: "Voice minutes beyond the included pool",
    provider: "ElevenLabs",
    provenance: "measured",
    native: usd(totalOverage),
    basis:
      overageMinutes > 0
        ? `${overageMinutes.toFixed(1)} minutes over, across ${plural(periods.length, "billing period")}, at $${p.overageUsdPerMin.toFixed(2)}/min.`
        : `${totalMinutes.toFixed(1)} of ${p.includedMinutes} included minutes used. Nothing has gone past the pool, so nothing beyond the plan fee has been charged.`,
  });

  push({
    key: "elevenlabs_voice_pool",
    label: "Voice minutes inside the pool — metered value, not charged",
    provider: "ElevenLabs",
    provenance: "included",
    native: usd(Math.max(0, el.platform - totalOverage)),
    excludedFromTotal: true,
    basis: `What those minutes would have cost at the overage rate. The invoice reads $0.00 for them: the plan fee already paid for them. Shown so the pool's value is visible, never added to the total.${el.unpriced > 0 ? ` ${plural(el.unpriced, "call")} not yet priced.` : ""}`,
  });

  push({
    key: "elevenlabs_llm",
    label: "Voice agent's own LLM",
    provider: "ElevenLabs",
    provenance: p.includedLlmUsd === null ? "included" : "measured",
    native: usd(el.llm),
    excludedFromTotal: p.includedLlmUsd === null,
    basis: `$${el.llm.toFixed(4)} USD of metered value across ${plural(el.calls, "call")}. Billed by ElevenLabs, not Anthropic — a different bill from the summaries line below.`,
    missing:
      p.includedLlmUsd === null
        ? "The plan includes an LLM allowance the console doesn't state, and the invoice shows $0.00 overage — so this is treated as included rather than guessed at. Set ELEVENLABS_INCLUDED_LLM_USD_PER_MONTH if you ever learn the figure."
        : undefined,
  });

  /* --- Twilio: actuals, fetched back per SID ----------------------------- */

  const tw = database
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN twilio_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              COALESCE(SUM(twilio_price), 0) AS total,
              MAX(twilio_price_unit) AS unit
         FROM calls WHERE twilio_call_sid IS NOT NULL`,
    )
    .get() as { n: number; priced: number; total: number; unit: string | null };

  const twPending = tw.n - tw.priced;
  push({
    key: "twilio_voice",
    label: "Outbound call minutes on your Twilio number",
    provider: "Twilio",
    provenance: "measured",
    native: tw.priced > 0 ? { amount: tw.total, currency: tw.unit ?? "USD" } : null,
    basis:
      tw.n === 0
        ? "No calls with a Twilio id recorded yet."
        : `${plural(tw.priced, "call")} priced from Twilio${twPending > 0 ? `, ${twPending} still pending` : ""}. Twilio bills these separately from ElevenLabs — two charges for one call.`,
    missing:
      tw.priced === 0 && tw.n > 0
        ? "Twilio hasn't settled these prices yet. They're fetched back by call id and appear once it does."
        : undefined,
  });

  const sms = database
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              COALESCE(SUM(price), 0) AS total,
              COALESCE(SUM(segments), 0) AS segs,
              MAX(price_unit) AS unit
         FROM sms_sends`,
    )
    .get() as { n: number; priced: number; total: number; segs: number; unit: string | null };

  const smsPending = sms.n - sms.priced;
  push({
    key: "twilio_sms",
    label: "Booking alert texts to your mobile",
    provider: "Twilio",
    provenance: "measured",
    native: sms.priced > 0 ? { amount: sms.total, currency: sms.unit ?? "USD" } : null,
    basis:
      sms.n === 0
        ? "No texts sent yet."
        : `${plural(sms.n, "text")}, ${plural(sms.segs, "segment")}${smsPending > 0 ? `, ${smsPending} price${smsPending === 1 ? "" : "s"} still pending` : ""}.`,
    missing:
      sms.priced === 0 && sms.n > 0
        ? "Twilio hasn't settled these prices yet — Message.price isn't populated at send time."
        : undefined,
  });

  // Number rental. The rate is read live off Twilio's Pricing API for THIS
  // account, so it is never a stale typed figure — but it is still a monthly
  // rate multiplied by months running rather than an invoice line, which is
  // why it stays Rated rather than Measured.
  const country = optional("TWILIO_NUMBER_COUNTRY") ?? "AU";
  const numberType = optional("TWILIO_NUMBER_TYPE") ?? "mobile";
  const rental = twilioConfigured() ? await fetchNumberRental(country, numberType) : null;

  push({
    key: "twilio_number",
    label: "Twilio number rental",
    provider: "Twilio",
    provenance: "rated",
    native: rental ? { amount: rental.monthlyPrice * monthsLive, currency: rental.priceUnit } : null,
    basis: rental
      ? `${plural(monthsLive, "month")} at ${rental.monthlyPrice.toFixed(2)} ${rental.priceUnit}/month for a ${rental.numberType} number, read live from Twilio's pricing API for this account.`
      : `${plural(monthsLive, "month")} running. A ${numberType} number in ${country}.`,
    missing: rental
      ? undefined
      : twilioConfigured()
        ? `Couldn't read the ${numberType} rental rate for ${country} from Twilio's pricing API. It may not sell that number type there — check TWILIO_NUMBER_TYPE.`
        : "Twilio credentials aren't set, so the rental rate can't be read.",
  });

  /* --- Lead finder ------------------------------------------------------- */

  const places = database
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(unit_cost_usd), 0) AS usd
         FROM lead_api_calls WHERE provider = 'google_places'`,
    )
    .get() as { n: number; usd: number };

  push({
    key: "google_places",
    label: "Lead sourcing — Google business searches",
    provider: "Google Places API",
    provenance: "measured",
    native: usd(places.usd),
    basis:
      places.n === 0
        ? "No lead runs yet."
        : `${plural(places.n, "search call")}. Google's first 1,000 a month are free, so this is gross spend, not what you were billed.`,
  });

  const abn = database
    .prepare(`SELECT COUNT(*) AS n FROM lead_api_calls WHERE provider = 'abn_lookup'`)
    .get() as { n: number };

  push({
    key: "abn_lookup",
    label: "Lead sourcing — ABN cross-checks",
    provider: "Australian Business Register",
    provenance: "measured",
    native: usd(0),
    basis: `${plural(abn.n, "lookup")}. Free government service — logged so the count is auditable.`,
  });

  /* --- Anthropic --------------------------------------------------------- */

  const ai = database
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(cost_usd), 0)      AS usd,
              COALESCE(SUM(input_tokens), 0)  AS input,
              COALESCE(SUM(output_tokens), 0) AS output
         FROM ai_usage`,
    )
    .get() as { n: number; usd: number; input: number; output: number };

  push({
    key: "anthropic",
    label: "Call summaries and pre-call briefings",
    provider: `Anthropic (${config.anthropicModel})`,
    provenance: "measured",
    native: usd(ai.usd),
    basis:
      ai.n === 0
        ? "No summaries generated since token recording was added."
        : `${plural(ai.n, "request")}, ${ai.input.toLocaleString()} in / ${ai.output.toLocaleString()} out tokens. Voicemails and no-answers skip the model entirely.`,
  });

  /* --- Railway ----------------------------------------------------------- */

  push({
    key: "railway",
    label: "Hosting",
    provider: "Railway",
    provenance: "configured",
    native: usd(railwayMonthlyUsd() * monthsLive),
    basis:
      "Trial workspace: a one-time credit grant, no card on file, no recurring fee — so the monthly cost is genuinely zero. The risk is credits running out, not a bill. See the runway panel.",
  });

  const cash = lines.filter((l) => !l.excludedFromTotal);

  return {
    lines,
    totalAud: money(cash.reduce((sum, l) => sum + (l.aud ?? 0), 0)),
    incomplete: cash.some((l) => l.native === null || l.aud === null),
    since,
    monthsLive,
    fxRate,
    periods,
    runway: railwayRunway(since),
  };
}

export interface UnitCosts {
  calls: number;
  bookings: number;
  perCallAud: number | null;
  perBookingAud: number | null;
}

/**
 * The "calls" count here excludes outcome='failed' — a call that errored out
 * at the telephony layer (known issue, tracked separately) shouldn't drag
 * down the per-call average. The dollar total itself (breakdown.totalAud) is
 * untouched — real spend stays real spend regardless of which calls it came
 * from, only the denominator changes.
 */
export function unitCosts(breakdown: CostBreakdown): UnitCosts {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(booked), 0) AS bookings
         FROM calls WHERE outcome IS NULL OR outcome != 'failed'`,
    )
    .get() as { calls: number; bookings: number };

  return {
    calls: row.calls,
    bookings: row.bookings,
    perCallAud: row.calls > 0 ? money(breakdown.totalAud / row.calls) : null,
    perBookingAud: row.bookings > 0 ? money(breakdown.totalAud / row.bookings) : null,
  };
}
