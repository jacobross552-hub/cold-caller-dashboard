/**
 * Where candidates come from.
 *
 * The orchestrator talks to this interface, never to Google directly. Two
 * reasons:
 *
 *   1. A second source (a paid B2B enrichment feed, a licensed directory) can
 *      be added later by writing one more object here. Scoring, dedup, cost
 *      accounting and the dashboard don't change.
 *   2. It makes the whole run testable offline. `scripts/test-lead-run.ts`
 *      injects a fake source and exercises pagination, filtering, dedup,
 *      suppression, cost accounting and the partial-result path without a
 *      network call or an API key.
 *
 * A source is responsible for reporting its own costs through `onCall`. That
 * keeps the cost ledger honest no matter which provider produced a lead.
 */

import { searchTextPage, type CallLogger, type PlaceResult } from "./places";

export interface SearchRequest {
  query: string;
  pageToken?: string;
  /** Used for a lead's timezone when its address can't be parsed. */
  fallbackState?: string;
  onCall: CallLogger;
}

export interface SearchResponse {
  results: PlaceResult[];
  /** Absent when there are no more pages for this query. */
  nextPageToken?: string;
}

export interface LeadSource {
  /** Stored on the run so you can tell where a batch of leads came from. */
  id: string;
  label: string;
  search(request: SearchRequest): Promise<SearchResponse>;
}

/** The live source. Google Places (New), one Enterprise-tier call per page. */
export const googlePlacesSource: LeadSource = {
  id: "google_places",
  label: "Google Places",
  search: (request) => searchTextPage(request),
};
