/**
 * Google Places API (New) client.
 *
 * Endpoints:
 *   POST https://places.googleapis.com/v1/places:searchText
 *   GET  https://places.googleapis.com/v1/places/{placeId}
 *
 * ONE CALL, EVERYTHING. See `cost.ts` for the full reasoning, but in short:
 * the New API bills the whole call at the highest tier in the field mask, and
 * `rating`/`userRatingCount` are Enterprise — the same tier as the phone
 * number. So there is no cheap pre-filter pass to be had. We ask Text Search
 * for the complete picture at Enterprise rates ($0.035 for up to 20
 * businesses) and never touch Place Details on the normal path.
 *
 * `getPlaceDetails` exists for one job the brief calls for: re-checking a
 * business we already hold a place_id for, months later, without paying for a
 * fresh search.
 *
 * Every call goes through `onCall` so the orchestrator can bank the real cost.
 * Nothing here reads the database.
 */

import { required } from "../env";
import { normaliseAuPhone } from "../phone";
import { summariseHours, type PlaceOpeningHours } from "./hours";
import { unitCostUsd, RESULTS_PER_SEARCH_CALL, type Sku } from "./cost";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

/**
 * Everything we score on, in one Enterprise-tier request.
 *
 * Adding a field from a higher tier re-prices EVERY call in the run, so do not
 * extend this without checking `cost.ts` first. `reviews` in particular would
 * push it to Enterprise + Atmosphere ($25 vs $20 per 1,000 on details) for
 * data we don't score on.
 */
const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours",
  "nextPageToken",
].join(",");

/** Same fields, without the `places.` prefix, for a single-place lookup. */
const DETAILS_FIELD_MASK = SEARCH_FIELD_MASK.replace(/places\./g, "").replace(",nextPageToken", "");

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: PlaceOpeningHours;
}

/** A candidate as it comes off the wire, before ICP scoring. */
export interface PlaceResult {
  placeId: string;
  name: string;
  address?: string;
  phoneE164?: string;
  phoneKind?: "mobile" | "landline";
  phoneRaw?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  businessStatus?: string;
  primaryType?: string;
  types: string[];
  hours: ReturnType<typeof summariseHours>;
  openingHoursJson?: string;
  suburb?: string;
  state?: string;
}

export interface ApiCallRecord {
  sku: Sku;
  detail: string;
  httpStatus: number;
  resultCount: number;
  unitCostUsd: number;
}

export type CallLogger = (record: ApiCallRecord) => void;

export class PlacesError extends Error {}

const AU_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

/**
 * Pull suburb and state out of an Australian formatted address.
 *
 * The state matters more than it looks: it picks the timezone the
 * calling-hours guard uses for this lead. Getting it wrong by one state can
 * mean dialling Perth at 6am. When the address can't be parsed we return
 * undefined and let the caller fall back to the state it searched in, rather
 * than guessing.
 *
 * "12 Smith St, Parramatta NSW 2150, Australia" -> { suburb, state }
 */
export function parseAuAddress(address: string | undefined): {
  suburb?: string;
  state?: string;
} {
  if (!address) return {};
  const pattern = new RegExp(`,\\s*([^,]+?)\\s+(${AU_STATES.join("|")})\\s+\\d{4}`, "i");
  const match = address.match(pattern);
  if (!match) return {};
  return { suburb: match[1].trim(), state: match[2].toUpperCase() };
}

function toPlaceResult(raw: RawPlace, fallbackState?: string): PlaceResult | null {
  if (!raw.id) return null;

  const phoneRaw = raw.nationalPhoneNumber ?? raw.internationalPhoneNumber;
  const normalised = phoneRaw ? normaliseAuPhone(phoneRaw) : null;
  const parsed = parseAuAddress(raw.formattedAddress);

  return {
    placeId: raw.id,
    name: raw.displayName?.text ?? "(no name)",
    address: raw.formattedAddress,
    phoneE164: normalised?.ok ? normalised.e164 : undefined,
    phoneKind: normalised?.ok ? normalised.kind : undefined,
    phoneRaw: phoneRaw,
    website: raw.websiteUri,
    rating: raw.rating,
    reviewCount: raw.userRatingCount,
    businessStatus: raw.businessStatus,
    primaryType: raw.primaryType,
    types: raw.types ?? [],
    hours: summariseHours(raw.regularOpeningHours),
    openingHoursJson: raw.regularOpeningHours
      ? JSON.stringify(raw.regularOpeningHours)
      : undefined,
    suburb: parsed.suburb,
    state: parsed.state ?? fallbackState,
  };
}

/**
 * One page of a text search. Google caps a page at 20 results and a whole
 * query at 60 across three pages, so broad coverage comes from many narrow
 * queries (vertical x suburb), not from paging deeper.
 */
export async function searchTextPage(params: {
  query: string;
  pageToken?: string;
  fallbackState?: string;
  onCall: CallLogger;
}): Promise<{ results: PlaceResult[]; nextPageToken?: string }> {
  const body: Record<string, unknown> = {
    textQuery: params.query,
    pageSize: RESULTS_PER_SEARCH_CALL,
    regionCode: "AU",
    languageCode: "en-AU",
  };
  if (params.pageToken) body.pageToken = params.pageToken;

  let response: Response;
  try {
    response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": required("GOOGLE_PLACES_API_KEY"),
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The call never reached Google, so nothing was billed — don't log a cost.
    throw new PlacesError(
      `Couldn't reach Google Places: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text();

  if (!response.ok) {
    // A rejected call is still a billable event in some cases, and always worth
    // having in the audit trail, so it is logged before we throw.
    params.onCall({
      sku: "text_search_enterprise",
      detail: params.query,
      httpStatus: response.status,
      resultCount: 0,
      unitCostUsd: response.status === 400 || response.status === 403 ? 0 : unitCostUsd("text_search_enterprise"),
    });
    throw new PlacesError(explainPlacesError(response.status, text));
  }

  const parsed = JSON.parse(text) as { places?: RawPlace[]; nextPageToken?: string };
  const raw = parsed.places ?? [];

  params.onCall({
    sku: "text_search_enterprise",
    detail: params.query,
    httpStatus: response.status,
    resultCount: raw.length,
    unitCostUsd: unitCostUsd("text_search_enterprise"),
  });

  const results = raw
    .map((place) => toPlaceResult(place, params.fallbackState))
    .filter((place): place is PlaceResult => place !== null);

  return { results, nextPageToken: parsed.nextPageToken };
}

/** Re-check a business we already know the place_id for. */
export async function getPlaceDetails(params: {
  placeId: string;
  fallbackState?: string;
  onCall: CallLogger;
}): Promise<PlaceResult | null> {
  const response = await fetch(`${DETAILS_URL}/${encodeURIComponent(params.placeId)}`, {
    headers: {
      "X-Goog-Api-Key": required("GOOGLE_PLACES_API_KEY"),
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
  });

  const text = await response.text();

  params.onCall({
    sku: "place_details_enterprise",
    detail: params.placeId,
    httpStatus: response.status,
    resultCount: response.ok ? 1 : 0,
    unitCostUsd: response.ok ? unitCostUsd("place_details_enterprise") : 0,
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new PlacesError(explainPlacesError(response.status, text));

  return toPlaceResult(JSON.parse(text) as RawPlace, params.fallbackState);
}

/** Turn Google's error bodies into something worth putting on screen. */
function explainPlacesError(status: number, body: string): string {
  const flat = body.replace(/\s+/g, " ").slice(0, 300);

  if (status === 403) {
    return (
      "Google refused the key (403). Usually one of: the Places API (New) isn't enabled on the " +
      "project, billing isn't switched on, or a key restriction is blocking this server. " +
      flat
    );
  }
  if (status === 400) {
    return `Google rejected the request (400) — most often a field-mask problem. ${flat}`;
  }
  if (status === 429) {
    return "Google is rate-limiting the key (429). The run will back off and retry.";
  }
  return `Google Places returned ${status}: ${flat}`;
}

/** True when the API key is configured. Drives the "switched off" UI. */
export function placesConfigured(): boolean {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  return Boolean(key && key.trim());
}
