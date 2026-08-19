/**
 * Central place for reading configuration. Nothing else in the app touches
 * process.env directly, so there is exactly one file to check when a
 * credential is missing.
 *
 * Secrets live in `.env` (gitignored). See `.env.example` for the full list.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Throws a plain-English error naming the missing variable. */
export function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(
      `Missing ${name} in your .env file. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Same as `num`, but keeps the decimals — exchange rates and money caps. */
function float(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  databasePath: optional("DATABASE_PATH") ?? "./data/dashboard.db",

  // Dialling limits.
  //
  // Raised 20 -> 250 on 18 Aug 2026 on request. Worth knowing before it moves
  // again: this is a throughput/cost guard, NOT a compliance one. No ACMA
  // instrument caps calls per day — the Telemarketing Standard 2017 binds
  // calling hours, caller-ID disclosure and terminating on request, and the
  // Do Not Call Register Act binds who may be rung at all. Neither limits
  // volume. What DOES bite is plan.md's risk table: carrier spam-flagging is
  // "not a real problem under 20 calls/day" but "becomes the dominant problem
  // above ~200/day". 250 sits in that zone, so if answer rates drop off a
  // cliff on the Twilio number, suspect this constant before blaming the script.
  maxCallsPerDay: num("MAX_CALLS_PER_DAY", 250),
  dispatchChunkSize: num("DISPATCH_CHUNK_SIZE", 5),
  callConcurrency: num("CALL_CONCURRENCY", 2),

  /**
   * Escape hatch for testing against your own mobile outside legal hours.
   * Must be the literal string "true" — anything else keeps the guard on.
   */
  allowOutsideCallingHours: optional("ALLOW_OUTSIDE_CALLING_HOURS") === "true",

  anthropicModel: optional("ANTHROPIC_MODEL") ?? "claude-opus-5",

  // --- Lead finder ---------------------------------------------------------
  /** Ceiling on one run, so a mis-typed 5000 can't become a 5000-lead run. */
  maxLeadsPerRun: num("MAX_LEADS_PER_RUN", 200),
  /**
   * Ceiling on one run's spend. Checked twice: the estimate must fit before
   * the run starts, and the running total is re-checked before every single
   * API call, so a bad pass rate can't walk past the budget mid-run.
   */
  maxCostPerRunAud: float("MAX_COST_PER_RUN_AUD", 25),
  /**
   * Google bills in USD; the dashboard shows AUD. The rate in force is stamped
   * onto each run when it starts, so editing this later never rewrites the
   * cost of a run that already happened.
   */
  usdAudRate: float("USD_AUD_RATE", 1.55),
} as const;

/**
 * Which optional integrations are wired up. The UI uses this to explain what
 * is switched off rather than failing silently.
 */
export function featureStatus() {
  return {
    calling: Boolean(
      optional("ELEVENLABS_API_KEY") &&
        optional("ELEVENLABS_AGENT_ID") &&
        optional("ELEVENLABS_PHONE_NUMBER_ID"),
    ),
    webhook: Boolean(optional("ELEVENLABS_WEBHOOK_SECRET")),
    summaries: Boolean(optional("ANTHROPIC_API_KEY")),
    smsAlerts: Boolean(
      optional("TWILIO_ACCOUNT_SID") &&
        optional("TWILIO_AUTH_TOKEN") &&
        optional("TWILIO_FROM_NUMBER") &&
        optional("ALERT_TO_NUMBER"),
    ),
    /** The lead finder can't search without a Places key. */
    leadFinder: Boolean(optional("GOOGLE_PLACES_API_KEY")),
    /** Optional: raises lead confidence and lets mobile numbers through. */
    abnCheck: Boolean(optional("ABN_LOOKUP_GUID")),
  };
}

export { optional };
