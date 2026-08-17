/**
 * What each external call costs, and how a run's cost is worked out.
 *
 * VERIFIED 17 Aug 2026 against developers.google.com/maps/billing-and-pricing/
 * pricing and .../places/web-service/data-fields.
 *
 * THE THING THAT SURPRISES PEOPLE. Places API (New) has no per-field charges.
 * The whole call is billed at the HIGHEST SKU tier present in the field mask:
 *
 *     Essentials  id, name, formattedAddress, location, types
 *     Pro         displayName, primaryType, businessStatus
 *     Enterprise  rating, userRatingCount, nationalPhoneNumber, websiteUri,
 *                 regularOpeningHours
 *
 * Because `rating` and `userRatingCount` are Enterprise — the same tier as the
 * phone number — the usual trick of "filter on cheap fields, then pay for
 * contact details on the survivors" saves nothing. You cannot score a lead on
 * review count without already paying Enterprise rates.
 *
 * So we ask Text Search for everything at once, at Enterprise, and skip Place
 * Details entirely on the normal path. One call returns up to 20 businesses
 * complete with phone, hours, website and reviews:
 *
 *     $35/1000 ÷ 20 businesses = $0.00175 USD per business examined
 *
 * Any figure you find online quoting "$0.017 base + $0.003 contact data" is
 * the LEGACY Places API and does not apply here.
 *
 * If Google changes its pricing, change it HERE and nowhere else.
 */

/** USD per 1,000 calls, straight off Google's pricing page. */
const USD_PER_1000 = {
  /** Text Search asking for any Enterprise field. Returns up to 20 places. */
  text_search_enterprise: 35,
  /** Place Details asking for any Enterprise field. Returns one place. */
  place_details_enterprise: 20,
  /** ABN Lookup is a free government service. Logged anyway, so the call
   *  count is auditable even though the line item is $0.00. */
  abn_lookup: 0,
} as const;

export type Sku = keyof typeof USD_PER_1000;

export const PROVIDER_FOR_SKU: Record<Sku, string> = {
  text_search_enterprise: "google_places",
  place_details_enterprise: "google_places",
  abn_lookup: "abn_lookup",
};

/** Plain-English label for the cost breakdown table in the UI. */
export const SKU_LABEL: Record<Sku, string> = {
  text_search_enterprise: "Google Places text searches",
  place_details_enterprise: "Google Places detail lookups",
  abn_lookup: "ABN Lookup checks (free)",
};

/** Most businesses one Text Search call can return. Google's hard limit. */
export const RESULTS_PER_SEARCH_CALL = 20;

/** Most businesses one query can ever yield, across all its pages. */
export const MAX_RESULTS_PER_QUERY = 60;

export function unitCostUsd(sku: Sku): number {
  return USD_PER_1000[sku] / 1000;
}

/**
 * Google's free monthly allowances, per SKU tier. Enterprise is the tight one.
 *
 * Not subtracted from the displayed cost on purpose: allowances are shared
 * across every project using the key, reset on Google's billing month rather
 * than ours, and Google has changed them before. Showing gross spend and
 * mentioning the allowance separately can only ever under-promise.
 */
export const FREE_CALLS_PER_MONTH_ENTERPRISE = 1000;

export function usdToAud(usd: number, fxRate: number): number {
  return usd * fxRate;
}

/** Round to whole cents, so displayed figures always add up. */
export function money(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function formatAud(amount: number): string {
  return "$" + money(amount).toFixed(2);
}

/**
 * How many candidates survive filtering, as a fraction. Used only to size the
 * pre-run estimate — the final cost is always summed from real call rows.
 *
 * The range is deliberately wide and the pessimistic end deliberately low: a
 * quote that comes in under is fine, one that comes in over is not.
 */
export const PASS_RATE = {
  /** Bad case: thin suburb, lots of chains, many listings with no phone. */
  pessimistic: 0.18,
  /** Good case: dense trade vertical in a large suburb. */
  optimistic: 0.45,
} as const;

export interface CostEstimate {
  /** Cheapest realistic outcome, AUD. */
  lowAud: number;
  /** Dearest realistic outcome, AUD — this is what the cap is tested against. */
  highAud: number;
  /** Search calls in the dear case. */
  maxSearchCalls: number;
  fxRate: number;
}

/**
 * Estimate a run before spending anything.
 *
 * Worked from the pessimistic pass rate, so the high figure is a genuine
 * upper bound rather than a midpoint dressed up as one.
 */
export function estimateRunCost(targetLeadCount: number, fxRate: number): CostEstimate {
  const callsFor = (passRate: number) =>
    Math.ceil(targetLeadCount / (RESULTS_PER_SEARCH_CALL * passRate));

  const minCalls = callsFor(PASS_RATE.optimistic);
  const maxCalls = callsFor(PASS_RATE.pessimistic);
  const unit = unitCostUsd("text_search_enterprise");

  return {
    lowAud: money(usdToAud(minCalls * unit, fxRate)),
    highAud: money(usdToAud(maxCalls * unit, fxRate)),
    maxSearchCalls: maxCalls,
    fxRate,
  };
}

/**
 * The hard ceiling on search calls for a run, derived from the cost cap.
 *
 * The orchestrator checks this before every single call, so a run cannot walk
 * past its budget even if the pass rate turns out far worse than estimated.
 */
export function maxCallsWithinBudget(capAud: number, fxRate: number): number {
  const perCallAud = usdToAud(unitCostUsd("text_search_enterprise"), fxRate);
  return Math.max(1, Math.floor(capAud / perCallAud));
}
