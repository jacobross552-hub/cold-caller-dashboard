/**
 * The lead-finding job: search -> filter -> ABN check -> score -> dedup -> import.
 *
 * WHY IT'S A BACKGROUND JOB. Even a 50-lead run is dozens of HTTP calls with
 * pagination and back-off. Pressing "Go" writes a `lead_runs` row and returns
 * straight away; the work happens after the response has gone.
 *
 * No queue, no Redis, no new dependency — the same shape the calling
 * dispatcher already uses. The run row IS the job record: its `heartbeat_at`
 * is refreshed after every page, and `leadFinderTick()` (hung off the existing
 * minute scheduler) restarts any run whose heartbeat has gone stale. So a run
 * interrupted by a server restart picks itself back up rather than sitting
 * half-finished forever.
 *
 * THREE THINGS THAT CANNOT BE SKIPPED, checked before every single API call:
 *   1. Has the run been cancelled?
 *   2. Would this call take the run past MAX_COST_PER_RUN_AUD?
 *   3. Have we already got what was asked for?
 */

import { logEvent } from "../db";
import { config } from "../env";
import { importLeads, leadExists, type IncomingLead } from "../leads";
import { isSuppressed } from "../suppression";
import { lookupAbn, type AbnStatus } from "./abn";
import {
  estimateRunCost,
  maxCallsWithinBudget,
  money,
  usdToAud,
  MAX_RESULTS_PER_QUERY,
  RESULTS_PER_SEARCH_CALL,
} from "./cost";
import { scoreCandidate, verticalById, customVertical, type Candidate, type VerticalDefinition } from "./icp";
import { PlacesError, type PlaceResult } from "./places";
import { googlePlacesSource, type LeadSource } from "./source";
import { planQueries, type PlannedQuery } from "./queries";
import {
  createLeadRun,
  finishLeadRun,
  getLeadRun,
  logApiCall,
  markRunning,
  runCostUsd,
  saveProgress,
  activeLeadRun,
  type LeadRunRow,
} from "./runs";

export class LeadRunError extends Error {}

/** Runs being worked by THIS process. Stops the ticker double-starting one. */
const activeWorkers = new Set<number>();

/** A run whose heartbeat is older than this is presumed dead and restarted. */
const STALE_AFTER_MS = 3 * 60 * 1000;

/** Politeness gap between Google calls. Nowhere near the rate limit. */
const CALL_SPACING_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the vertical ids and free-typed terms the form submitted into real
 * definitions. Unknown ids become custom verticals rather than errors, so a
 * typo costs a worse score, not a failed run.
 */
export function resolveVerticals(ids: string[], custom: string[]): VerticalDefinition[] {
  const resolved: VerticalDefinition[] = [];

  for (const id of ids) {
    const known = verticalById(id);
    if (known) resolved.push(known);
  }
  for (const term of custom) {
    const clean = term.trim();
    if (clean) resolved.push(customVertical(clean));
  }

  return resolved;
}

/**
 * Validate and queue a run. Never calls Google — that happens in the worker.
 *
 * Throws LeadRunError with a message meant to be shown to the user as-is.
 */
export function startLeadRun(params: {
  verticals: VerticalDefinition[];
  locations: string[];
  targetCount: number;
  requester?: string;
  /** Deliberate override of the cost cap. Logged loudly. */
  overrideCostCap?: boolean;
}): LeadRunRow {
  if (params.verticals.length === 0) {
    throw new LeadRunError("Pick at least one type of business to look for.");
  }
  if (params.locations.length === 0) {
    throw new LeadRunError("Enter at least one suburb, postcode or region.");
  }
  if (!Number.isFinite(params.targetCount) || params.targetCount < 1) {
    throw new LeadRunError("Enter how many leads you want (at least 1).");
  }
  if (params.targetCount > config.maxLeadsPerRun) {
    throw new LeadRunError(
      `That's more than the ${config.maxLeadsPerRun}-lead cap for a single run. ` +
        `Raise MAX_LEADS_PER_RUN in .env if you really want a bigger one.`,
    );
  }
  if (activeLeadRun()) {
    throw new LeadRunError(
      "A lead run is already going. Wait for it to finish, or cancel it, before starting another.",
    );
  }

  const fxRate = config.usdAudRate;
  const estimate = estimateRunCost(params.targetCount, fxRate);

  if (estimate.highAud > config.maxCostPerRunAud && !params.overrideCostCap) {
    throw new LeadRunError(
      `That run could cost up to $${estimate.highAud.toFixed(2)} AUD, over the ` +
        `$${config.maxCostPerRunAud.toFixed(2)} cap. Ask for fewer leads, or tick "spend up to the ` +
        `estimate anyway" if you meant it.`,
    );
  }

  const queries = planQueries(params.verticals, params.locations);
  if (queries.length === 0) {
    throw new LeadRunError("Those verticals and locations didn't produce any searches to run.");
  }

  const run = createLeadRun({
    verticals: params.verticals.map((v) => v.label),
    locations: params.locations,
    targetCount: params.targetCount,
    queries,
    estimatedCostAud: estimate.highAud,
    fxRate,
    requester: params.requester,
  });

  logEvent(
    "lead_run.created",
    `Lead run #${run.id} queued: ${params.targetCount} lead(s) across ` +
      `${params.verticals.length} vertical(s) and ${params.locations.length} location(s). ` +
      `Estimated $${estimate.lowAud.toFixed(2)}–$${estimate.highAud.toFixed(2)} AUD.`,
    { runId: run.id, queries: queries.length, overrideCostCap: params.overrideCostCap ?? false },
  );

  return run;
}

/** Reasons a run stops before reaching its target. */
type StopReason = "target_reached" | "cancelled" | "budget" | "exhausted" | null;

/**
 * Do the work. Safe to call twice — the second call returns immediately.
 * Never throws; failures are recorded on the run row.
 *
 * `source` is injectable so the whole pipeline can be exercised offline with a
 * fake provider — see scripts/test-lead-run.ts. Production always uses the
 * default.
 */
export async function runLeadFinder(
  runId: number,
  source: LeadSource = googlePlacesSource,
): Promise<void> {
  if (activeWorkers.has(runId)) return;
  activeWorkers.add(runId);

  try {
    const run = getLeadRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    markRunning(runId, "Starting.");

    const queries = JSON.parse(run.queries_json ?? "[]") as PlannedQuery[];
    const callCeiling = maxCallsWithinBudget(config.maxCostPerRunAud, run.fx_rate);

    // Running totals, flushed to the run row after every page.
    let leadsFound = run.leads_found;
    let candidatesSeen = run.candidates_seen;
    let duplicates = run.duplicates_skipped;
    let suppressed = run.suppressed_skipped;
    let rejected = run.rejected_skipped;
    let searchCalls = 0;

    /** Business name -> how many times seen. The chain detector. */
    const nameTally = new Map<string, number>();

    let stop: StopReason = null;

    for (let index = run.query_cursor; index < queries.length; index++) {
      if (stop) break;

      const planned = queries[index];
      let pageToken: string | undefined;
      let pagesThisQuery = 0;
      const maxPages = Math.ceil(MAX_RESULTS_PER_QUERY / RESULTS_PER_SEARCH_CALL);

      while (pagesThisQuery < maxPages) {
        // ---- The three checks, before anything is spent -------------------
        const current = getLeadRun(runId);
        if (!current || current.status === "cancelled") {
          stop = "cancelled";
          break;
        }
        if (leadsFound >= run.target_count) {
          stop = "target_reached";
          break;
        }
        if (searchCalls >= callCeiling) {
          stop = "budget";
          break;
        }
        const spentAud = usdToAud(runCostUsd(runId), run.fx_rate);
        if (spentAud >= config.maxCostPerRunAud) {
          stop = "budget";
          break;
        }

        saveProgress(runId, {
          stage: `Searching: ${planned.query}${pagesThisQuery > 0 ? ` (page ${pagesThisQuery + 1})` : ""}`,
          queryCursor: index,
        });

        let page: { results: PlaceResult[]; nextPageToken?: string };
        try {
          page = await source.search({
            query: planned.query,
            pageToken,
            fallbackState: planned.state,
            onCall: (record) => logApiCall(runId, record, source.id),
          });
        } catch (err) {
          if (err instanceof PlacesError && /429/.test(err.message)) {
            // Rate-limited: wait and retry this same page once.
            await sleep(2_000);
            pagesThisQuery++;
            continue;
          }
          // Anything else is fatal — a bad key or a disabled API will not fix
          // itself by grinding through 40 more queries and billing for each.
          finishLeadRun(runId, "failed", err instanceof Error ? err.message : String(err));
          logEvent("lead_run.failed", `Lead run #${runId} stopped: ${String(err)}`, { runId });
          return;
        }

        searchCalls++;
        pagesThisQuery++;
        candidatesSeen += page.results.length;

        // Tally this page's names before scoring, so a chain that appears
        // three times on one page is caught on all three.
        for (const result of page.results) {
          const key = result.name.toLowerCase().trim();
          nameTally.set(key, (nameTally.get(key) ?? 0) + 1);
        }

        const vertical =
          resolveVerticals([planned.verticalId], []).at(0) ??
          customVertical(planned.verticalId.replace(/^custom:/, ""));

        const toImport: IncomingLead[] = [];

        for (const result of page.results) {
          if (leadsFound + toImport.length >= run.target_count) break;

          // Cheap rejections first — no point paying latency on a known dupe.
          if (!result.phoneE164) {
            rejected++;
            continue;
          }
          if (isSuppressed(result.phoneE164)) {
            suppressed++;
            continue;
          }
          if (leadExists(result.phoneE164, result.placeId)) {
            duplicates++;
            continue;
          }

          // ABN check only for candidates that could actually be imported.
          // Free, but it's a network round-trip each, so it goes last.
          let abnStatus: AbnStatus = "not_checked";
          let abn: string | undefined;
          let registeredName: string | undefined;

          const provisional = buildCandidate(result, vertical, nameTally);

          // Score once without the ABN to decide whether the lookup is worth
          // the round-trip. Always worth it for a mobile: an active ABN is the
          // thing that rescues a mobile the guard would otherwise refuse.
          const needsAbn =
            result.phoneKind === "mobile" || !scoreCandidate(provisional).disqualified;

          if (needsAbn) {
            const match = await lookupAbn({
              businessName: result.name,
              state: result.state,
              onCall: (record) => logApiCall(runId, record, "abn_lookup"),
            });
            abnStatus = match.status;
            abn = match.abn;
            registeredName = match.registeredName;
          }

          const scored = scoreCandidate(provisional, {
            abnStatus,
            nameOccurrences: nameTally.get(result.name.toLowerCase().trim()) ?? 1,
          });

          if (scored.disqualified) {
            rejected++;
            continue;
          }

          toImport.push({
            businessName: result.name,
            phone: result.phoneE164,
            suburb: result.suburb,
            state: result.state,
            trade: vertical.label,
            vertical: vertical.id,
            sourcePlaceId: result.placeId,
            icpScore: scored.score,
            icpReasons: scored.reasons,
            leadRunId: runId,
            abn,
            abnStatus,
            website: result.website,
            googleRating: result.rating,
            googleReviewCount: result.reviewCount,
            openingHoursJson: result.openingHoursJson,
            notes: `ICP ${scored.score}/100 — ${scored.reasons[0] ?? ""}`,
            sourceRecord: buildSourceRecord(result, planned, {
              abn,
              abnStatus,
              registeredName,
              corroboration: scored.corroboration,
            }),
          });
        }

        if (toImport.length > 0) {
          const imported = importLeads(toImport, "AI lead finder");
          leadsFound += imported.imported;
          duplicates += imported.duplicates;
          suppressed += imported.suppressed;
          rejected += imported.rejected.length;
        }

        saveProgress(runId, {
          candidatesSeen,
          leadsFound,
          duplicatesSkipped: duplicates,
          suppressedSkipped: suppressed,
          rejectedSkipped: rejected,
          queryCursor: index,
        });

        pageToken = page.nextPageToken;
        if (!pageToken) break;

        await sleep(CALL_SPACING_MS);
      }
    }

    if (!stop) stop = leadsFound >= run.target_count ? "target_reached" : "exhausted";

    finaliseRun(runId, stop, leadsFound, run.target_count);
  } catch (err) {
    finishLeadRun(runId, "failed", err instanceof Error ? err.message : String(err));
    logEvent("lead_run.failed", `Lead run #${runId} crashed: ${String(err)}`, { runId });
  } finally {
    activeWorkers.delete(runId);
  }
}

function finaliseRun(runId: number, stop: StopReason, found: number, target: number) {
  const run = getLeadRun(runId);
  if (!run || run.status === "cancelled") return;

  const costAud = money(usdToAud(runCostUsd(runId), run.fx_rate));

  if (stop === "target_reached") {
    finishLeadRun(runId, "completed");
    logEvent(
      "lead_run.completed",
      `Lead run #${runId} found all ${found} lead(s) for $${costAud.toFixed(2)} AUD.`,
      { runId, found, costAud },
    );
    return;
  }

  // Everything else is a partial result. Say so plainly rather than quietly
  // returning fewer leads than were asked for.
  const why =
    stop === "budget"
      ? `stopped at the $${config.maxCostPerRunAud.toFixed(2)} cost cap`
      : "ran out of search coverage";

  finishLeadRun(
    runId,
    "partial",
    `Found ${found} of the ${target} you asked for — ${why}. Try more suburbs or more verticals.`,
  );
  logEvent(
    "lead_run.partial",
    `Lead run #${runId} found ${found} of ${target} (${why}). Cost $${costAud.toFixed(2)} AUD.`,
    { runId, found, target, costAud },
  );
}

function buildCandidate(
  result: PlaceResult,
  vertical: VerticalDefinition,
  nameTally: Map<string, number>,
): Candidate {
  return {
    placeId: result.placeId,
    name: result.name,
    address: result.address,
    phoneE164: result.phoneE164,
    phoneKind: result.phoneKind,
    website: result.website,
    rating: result.rating,
    reviewCount: result.reviewCount,
    businessStatus: result.businessStatus,
    primaryType: result.primaryType,
    types: result.types,
    hours: result.hours,
    vertical,
    suburb: result.suburb,
    state: result.state,
  };
}

/**
 * The compliance record that travels with every lead.
 *
 * This is what answers "where did you get this number and why was it lawful to
 * ring it?" months later, without anyone having to reconstruct it from memory.
 */
function buildSourceRecord(
  result: PlaceResult,
  planned: PlannedQuery,
  abn: {
    abn?: string;
    abnStatus: AbnStatus;
    registeredName?: string;
    corroboration: string[];
  },
) {
  return {
    source: "google_places_text_search",
    place_id: result.placeId,
    query: planned.query,
    fetched_at: new Date().toISOString(),
    number_kind: result.phoneKind ?? "unknown",
    published_as: "nationalPhoneNumber on the business's Google Business Profile",
    basis:
      `Published as the primary contact number on the Google Business Profile for ` +
      `"${result.name}". Called in a professional capacity about a business product, which ` +
      `is outside the Do Not Call Register Act's coverage of personal numbers. Calling hours ` +
      `remain enforced by the dispatcher regardless.`,
    corroboration: abn.corroboration,
    abn: abn.abn ?? null,
    abn_status: abn.abnStatus,
    abn_registered_name: abn.registeredName ?? null,
    website: result.website ?? null,
  };
}

export function cancelLeadRun(runId: number): void {
  const run = getLeadRun(runId);
  if (!run) throw new LeadRunError("That run doesn't exist.");
  if (run.status === "completed" || run.status === "partial") {
    throw new LeadRunError("That run has already finished.");
  }

  finishLeadRun(runId, "cancelled");
  logEvent("lead_run.cancelled", `Lead run #${runId} cancelled after ${run.leads_found} lead(s).`, {
    runId,
  });
}

/**
 * Recovery pass, called from the existing minute scheduler.
 *
 * Restarts a run that was interrupted — a server restart mid-run leaves a row
 * marked 'running' with nobody working it, and without this it would sit there
 * forever. Resumes at the query it got to; the page inside that query starts
 * again, which can re-search one page. Cheap, and the dedup check means no
 * duplicate leads come of it.
 */
export function leadFinderTick(): void {
  const run = activeLeadRun();
  if (!run) return;
  if (activeWorkers.has(run.id)) return;

  const stale = !run.heartbeat_at || Date.now() - run.heartbeat_at > STALE_AFTER_MS;
  if (run.status === "running" && !stale) return;

  if (run.status === "running") {
    logEvent("lead_run.resumed", `Lead run #${run.id} looked stalled — picking it back up.`, {
      runId: run.id,
    });
  }

  void runLeadFinder(run.id).catch((err) => {
    logEvent("lead_run.failed", `Lead run #${run.id} failed on resume: ${String(err)}`, {
      runId: run.id,
    });
  });
}
