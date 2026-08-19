/**
 * What the whole system has cost, since the day it started, broken down by
 * where the money went.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. Every figure on the costs page says where
 * it came from, and the three provenances are never blended into one number
 * without saying so:
 *
 *   measured    Summed from per-event figures the PROVIDER itself reported.
 *               Auditable. Survives a price change, because the price that
 *               applied is stored on the row.
 *   rated       A real recorded event COUNT (or duration) multiplied by a rate
 *               configured here. The usage is real; the price is our figure,
 *               not a billed one.
 *   configured  A flat subscription the dashboard cannot see at all. It is
 *               whatever you typed into `.env`, prorated across the months the
 *               system has been running. Zero until you set it.
 *
 * Anything we cannot measure and you have not configured shows as "not set"
 * rather than as $0 — a missing figure and a genuinely free line item are
 * different things, and a lifetime total that quietly omits your hosting bill
 * is worse than one that admits it.
 *
 * See README "Costs" for the same explanation in prose.
 */

import { db } from "./db";
import { config, optional } from "./env";
import { money, usdToAud } from "./lead-finder/cost";

// Re-exported so the payload reader and the aggregation stay one import for
// callers. It lives in its own module because db.ts needs it during migration,
// and db.ts cannot import this file without a cycle.
export { extractCallCost, type CallFiatCost } from "./call-cost";

/** How confident we are in a line item, and why. */
export type Provenance = "measured" | "rated" | "configured";

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  measured: "Measured",
  rated: "Rated",
  configured: "Configured",
};

export const PROVENANCE_BLURB: Record<Provenance, string> = {
  measured: "Summed from per-event figures the provider itself reported.",
  rated: "Real recorded usage, priced at a rate set in .env — not a billed figure.",
  configured: "A flat subscription the dashboard can't see. Whatever you set in .env.",
};

/* ---------------------------------------------------------------------------
 * Rates
 * ------------------------------------------------------------------------ */

/**
 * Anthropic list prices, USD per MILLION tokens.
 *
 * VERIFIED 19 Aug 2026 against Anthropic's published pricing. Cache reads are
 * 0.1x the input rate; cache writes are 1.25x for the 5-minute TTL (the
 * default) and 2x for the 1-hour TTL. The dashboard sets no cache breakpoints,
 * so in practice the cache columns stay at zero — they are here so the figure
 * stays right if that ever changes.
 *
 * If Anthropic changes its prices, change them HERE and nowhere else. Rows
 * already written to `ai_usage` keep the cost they were priced at.
 */
const ANTHROPIC_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Unknown model ids fall back to the model the dashboard actually defaults to. */
const ANTHROPIC_FALLBACK_MODEL = "claude-opus-5";

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Price one Anthropic call from the tokens it reported. */
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

/**
 * Twilio rates, USD. Both default to 0, which means "not set" — NOT "free".
 *
 * They have to be configured because Twilio's Australian pricing is
 * account-specific and destination-dependent, and the dashboard has no
 * visibility into the bill. Read the real figures off your Twilio console.
 *
 * The per-minute rate matters more than it looks: ElevenLabs dials through
 * YOUR Twilio number, so Twilio bills you for every call minute SEPARATELY
 * from what ElevenLabs charges. That spend is invisible here until you set it.
 */
function twilioSmsUsd(): number {
  return numberFromEnv("TWILIO_SMS_COST_USD", 0);
}

function twilioPerMinuteUsd(): number {
  return numberFromEnv("TWILIO_CALL_COST_USD_PER_MIN", 0);
}

/** Flat monthly subscriptions, AUD. Both default to 0 — "not set". */
function elevenLabsMonthlyAud(): number {
  return numberFromEnv("ELEVENLABS_PLAN_MONTHLY_AUD", 0);
}

function railwayMonthlyAud(): number {
  return numberFromEnv("RAILWAY_MONTHLY_AUD", 0);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Exposed so the page can price an SMS row as it is written. */
export function smsUnitCostUsd(): number {
  return twilioSmsUsd();
}

/* ---------------------------------------------------------------------------
 * Aggregation
 * ------------------------------------------------------------------------ */

export interface CostLine {
  /** Stable key, for React and for tests. */
  key: string;
  /** What the money bought, in plain English. */
  label: string;
  /** Which company charges for it. */
  provider: string;
  provenance: Provenance;
  /** Lifetime spend, AUD. Null when the rate isn't set and we refuse to guess. */
  aud: number | null;
  /** The recorded usage behind the figure, e.g. "3 calls, 8m 19s". */
  basis: string;
  /** Shown when `aud` is null — what to do about it. */
  missing?: string;
}

export interface CostBreakdown {
  lines: CostLine[];
  /** Sum of every line we could price. */
  totalAud: number;
  /** True when at least one line is unpriced, so the total is a floor. */
  incomplete: boolean;
  /** Epoch ms of the first recorded activity, or null on an empty database. */
  since: number | null;
  /** Months the system has been running, minimum 1. Drives subscription lines. */
  monthsLive: number;
  fxRate: number;
}

/** Earliest recorded activity across every table that records time. */
function firstActivityAt(): number | null {
  const override = optional("COSTS_SINCE");
  if (override) {
    const parsed = Date.parse(override);
    if (Number.isFinite(parsed)) return parsed;
  }

  const database = db();
  const row = database
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

function duration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/**
 * Lifetime cost of the whole system, by source.
 *
 * Everything is summed in USD and converted once, at the CURRENT rate, except
 * the lead-finder line — those rows carry the rate that applied on the day, so
 * a past run keeps the cost it actually had.
 */
export function lifetimeCosts(): CostBreakdown {
  const database = db();
  const fxRate = config.usdAudRate;
  const since = firstActivityAt();
  const monthsLive = monthsSince(since);
  const lines: CostLine[] = [];

  /* --- ElevenLabs: measured, and split the way its webhook splits it ------ */

  const el = database
    .prepare(
      `SELECT COUNT(*)                     AS calls,
              COALESCE(SUM(platform_price_usd), 0) AS platform,
              COALESCE(SUM(llm_price_usd), 0)      AS llm,
              COALESCE(SUM(duration_secs), 0)      AS secs,
              SUM(CASE WHEN cost_fiat_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM calls`,
    )
    .get() as { calls: number; platform: number; llm: number; secs: number; unpriced: number };

  const unpricedNote =
    el.unpriced > 0
      ? ` ${plural(el.unpriced, "call")} not yet priced — run \`npm run backfill:costs\`.`
      : "";

  lines.push({
    key: "elevenlabs_platform",
    label: "Voice calls — speech, transcription, telephony",
    provider: "ElevenLabs",
    provenance: "measured",
    aud: money(usdToAud(el.platform, fxRate)),
    basis: `${plural(el.calls, "call")}, ${duration(el.secs)} of talk time.${unpricedNote}`,
  });

  lines.push({
    key: "elevenlabs_llm",
    label: "Voice agent's own LLM — what the agent thinks with",
    provider: "ElevenLabs",
    provenance: "measured",
    aud: money(usdToAud(el.llm, fxRate)),
    basis: `Billed by ElevenLabs, not by Anthropic. Separate from the dashboard's own model spend below.`,
  });

  /* --- Lead finder: measured, at the rate that applied on the day --------- */

  const places = database
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(unit_cost_usd), 0) AS usd
         FROM lead_api_calls WHERE provider = 'google_places'`,
    )
    .get() as { n: number; usd: number };

  // Each row is converted at its own run's rate, so an old run keeps its real
  // cost even after the exchange rate moves.
  const placesAud = database
    .prepare(
      `SELECT COALESCE(SUM(c.unit_cost_usd * r.fx_rate), 0) AS aud
         FROM lead_api_calls c JOIN lead_runs r ON r.id = c.lead_run_id
        WHERE c.provider = 'google_places'`,
    )
    .get() as { aud: number };

  lines.push({
    key: "google_places",
    label: "Lead sourcing — Google business searches",
    provider: "Google Places API",
    provenance: "measured",
    aud: money(placesAud.aud),
    basis:
      places.n === 0
        ? "No lead runs yet."
        : `${plural(places.n, "search call")}. Google's first 1,000 a month are free, so this is gross spend, not what you were billed.`,
  });

  const abn = database
    .prepare(`SELECT COUNT(*) AS n FROM lead_api_calls WHERE provider = 'abn_lookup'`)
    .get() as { n: number };

  lines.push({
    key: "abn_lookup",
    label: "Lead sourcing — ABN cross-checks",
    provider: "Australian Business Register",
    provenance: "measured",
    aud: 0,
    basis: `${plural(abn.n, "lookup")}. Free government service — logged so the count is auditable.`,
  });

  /* --- Anthropic: measured, from tokens the API reported ----------------- */

  const ai = database
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(cost_usd), 0)      AS usd,
              COALESCE(SUM(input_tokens), 0)  AS input,
              COALESCE(SUM(output_tokens), 0) AS output
         FROM ai_usage`,
    )
    .get() as { n: number; usd: number; input: number; output: number };

  lines.push({
    key: "anthropic",
    label: "Call summaries and pre-call briefings",
    provider: `Anthropic (${config.anthropicModel})`,
    provenance: "measured",
    aud: money(usdToAud(ai.usd, fxRate)),
    basis:
      ai.n === 0
        ? "No summaries generated since token recording was added."
        : `${plural(ai.n, "request")}, ${ai.input.toLocaleString()} in / ${ai.output.toLocaleString()} out tokens. Voicemails and no-answers skip the model entirely.`,
  });

  /* --- Twilio: real usage, our rate -------------------------------------- */

  const smsRate = twilioSmsUsd();
  const sms = database
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(segments), 0) AS segs FROM sms_sends`)
    .get() as { n: number; segs: number };

  lines.push({
    key: "twilio_sms",
    label: "Booking alert texts to your mobile",
    provider: "Twilio",
    provenance: "rated",
    aud: smsRate > 0 ? money(usdToAud(sms.segs * smsRate, fxRate)) : null,
    basis: `${plural(sms.n, "text")}, ${plural(sms.segs, "segment")}.`,
    missing:
      smsRate > 0
        ? undefined
        : "Set TWILIO_SMS_COST_USD to the per-segment price on your Twilio console.",
  });

  const perMin = twilioPerMinuteUsd();
  const minutes = el.secs / 60;

  lines.push({
    key: "twilio_voice",
    label: "Outbound call minutes on your Twilio number",
    provider: "Twilio",
    provenance: "rated",
    aud: perMin > 0 ? money(usdToAud(minutes * perMin, fxRate)) : null,
    basis: `${duration(el.secs)} of connected calls. Twilio bills these SEPARATELY from ElevenLabs — the two are not the same charge.`,
    missing:
      perMin > 0
        ? undefined
        : "Set TWILIO_CALL_COST_USD_PER_MIN from your Twilio console. Until you do, real call spend is missing from the total.",
  });

  /* --- Subscriptions: invisible to the app ------------------------------- */

  const elMonthly = elevenLabsMonthlyAud();
  lines.push({
    key: "elevenlabs_plan",
    label: "ElevenLabs plan fee",
    provider: "ElevenLabs",
    provenance: "configured",
    aud: elMonthly > 0 ? money(elMonthly * monthsLive) : null,
    basis: `${plural(monthsLive, "month")} running${elMonthly > 0 ? ` at $${elMonthly.toFixed(2)}/month` : ""}.`,
    missing:
      elMonthly > 0 ? undefined : "Set ELEVENLABS_PLAN_MONTHLY_AUD to your plan's monthly price.",
  });

  const railway = railwayMonthlyAud();
  lines.push({
    key: "railway",
    label: "Hosting",
    provider: "Railway",
    provenance: "configured",
    aud: railway > 0 ? money(railway * monthsLive) : null,
    basis: `${plural(monthsLive, "month")} running${railway > 0 ? ` at $${railway.toFixed(2)}/month` : ""}.`,
    missing: railway > 0 ? undefined : "Set RAILWAY_MONTHLY_AUD to what Railway actually bills you.",
  });

  const priced = lines.filter((l) => l.aud !== null) as Array<CostLine & { aud: number }>;

  return {
    lines,
    totalAud: money(priced.reduce((sum, l) => sum + l.aud, 0)),
    incomplete: lines.some((l) => l.aud === null),
    since,
    monthsLive,
    fxRate,
  };
}

/** Per-call and per-booking unit economics, for the summary tiles. */
export interface UnitCosts {
  calls: number;
  bookings: number;
  /** Lifetime total divided by calls. Null when there are no calls yet. */
  perCallAud: number | null;
  /** The number that decides whether the business works. */
  perBookingAud: number | null;
}

export function unitCosts(breakdown: CostBreakdown): UnitCosts {
  const database = db();
  const row = database
    .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(booked), 0) AS bookings FROM calls`)
    .get() as { calls: number; bookings: number };

  return {
    calls: row.calls,
    bookings: row.bookings,
    perCallAud: row.calls > 0 ? money(breakdown.totalAud / row.calls) : null,
    perBookingAud: row.bookings > 0 ? money(breakdown.totalAud / row.bookings) : null,
  };
}
