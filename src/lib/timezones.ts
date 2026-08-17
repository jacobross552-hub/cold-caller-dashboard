/**
 * Australian state → timezone.
 *
 * A lead's calling window has to be worked out in *their* local time, not
 * ours. Perth is two hours behind Sydney in winter and three in summer, so
 * a Sydney 9am dispatch would be ringing a WA business at 6am.
 *
 * Leads carry an optional `state` column. When it's set we use that state's
 * zone; when it's blank we fall back to Australia/Sydney, which is right for
 * the NSW-focused list this is pointed at today.
 */

export const DEFAULT_TIME_ZONE = "Australia/Sydney";

const STATE_TIME_ZONES: Record<string, string> = {
  NSW: "Australia/Sydney",
  ACT: "Australia/Sydney", // Canberra keeps Sydney time, DST included
  VIC: "Australia/Melbourne",
  TAS: "Australia/Hobart",
  QLD: "Australia/Brisbane", // no daylight saving
  SA: "Australia/Adelaide", // UTC+9:30 / +10:30
  NT: "Australia/Darwin", // UTC+9:30, no daylight saving
  WA: "Australia/Perth", // UTC+8, no daylight saving
};

/** Long forms and common spellings seen in scraped lead lists. */
const STATE_ALIASES: Record<string, string> = {
  "NEW SOUTH WALES": "NSW",
  "AUSTRALIAN CAPITAL TERRITORY": "ACT",
  CANBERRA: "ACT",
  VICTORIA: "VIC",
  TASMANIA: "TAS",
  QUEENSLAND: "QLD",
  "SOUTH AUSTRALIA": "SA",
  "NORTHERN TERRITORY": "NT",
  "WESTERN AUSTRALIA": "WA",
};

/** Normalise whatever was in the spreadsheet to a state code, or null. */
export function normaliseState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase().replace(/\./g, "");
  if (clean in STATE_TIME_ZONES) return clean;
  if (clean in STATE_ALIASES) return STATE_ALIASES[clean];
  return null;
}

/**
 * The timezone to reason about this lead's calling window in.
 * Falls back to Sydney when the state is missing or unrecognised.
 */
export function timeZoneForState(raw: string | null | undefined): string {
  const state = normaliseState(raw);
  return state ? STATE_TIME_ZONES[state] : DEFAULT_TIME_ZONE;
}

/**
 * True when we're guessing the zone rather than knowing it. The dashboard
 * uses this to be honest about which leads are being timed on an assumption.
 */
export function isAssumedZone(raw: string | null | undefined): boolean {
  return normaliseState(raw) === null;
}

export { STATE_TIME_ZONES };
