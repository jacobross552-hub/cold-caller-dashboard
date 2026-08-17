/**
 * ABN Lookup — the free Australian Business Register web service.
 *
 * Register for a GUID (free, instant) at abr.business.gov.au/Tools/WebServices.
 *
 * WHAT THIS IS FOR. The register holds no phone numbers, so it is never a
 * source of leads — it is a cross-check. It does two jobs:
 *
 *   1. Confirms a business is real and currently registered, which is what
 *      lets a mobile number through the personal-number guard.
 *   2. Excludes businesses whose ABN has been cancelled, so we don't cold-call
 *      a company that has wound up.
 *
 * NAME MATCHING IS FUZZY and always will be — trading names on Google rarely
 * match the registered entity name exactly ("Dave's Plumbing" vs "D & K
 * NGUYEN PTY LTD"). So a match RAISES confidence and a cancelled ABN EXCLUDES,
 * but a non-match is treated as "unknown" and never rejects a lead on its own.
 * Anything stricter would throw away good sole traders.
 *
 * The endpoints return JSONP (a JavaScript call wrapping the JSON), not plain
 * JSON, so the wrapper has to be peeled off before parsing.
 */

import { optional } from "../env";
import type { CallLogger } from "./places";
import { unitCostUsd } from "./cost";

const MATCHING_NAMES_URL = "https://abr.business.gov.au/json/MatchingNames.aspx";

export type AbnStatus = "active" | "cancelled" | "unknown" | "not_checked";

export interface AbnMatch {
  status: AbnStatus;
  abn?: string;
  registeredName?: string;
  /** 0-1, how confident we are that this is the same business. */
  confidence: number;
}

interface RawName {
  Abn?: string;
  AbnStatus?: string;
  Name?: string;
  NameType?: string;
  Postcode?: string;
  State?: string;
  Score?: number;
  IsCurrent?: boolean;
}

export function abnConfigured(): boolean {
  return Boolean(optional("ABN_LOOKUP_GUID"));
}

/**
 * Strip words that appear in nearly every Australian business name and carry
 * no identifying signal, so "Dave's Plumbing Services Pty Ltd" and "Daves
 * Plumbing" compare as the same thing.
 */
const NOISE_WORDS = new Set([
  "pty",
  "ltd",
  "limited",
  "the",
  "and",
  "co",
  "company",
  "group",
  "services",
  "service",
  "australia",
  "australian",
  "trading",
  "as",
  "t",
  "a",
]);

export function normaliseBusinessName(name: string): string[] {
  return (
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      // Apostrophes are DELETED, not turned into spaces. Splitting on them
      // would turn "Dave's Plumbing" into ["dave","s","plumbing"], which then
      // only half-matches the registered "DAVES PLUMBING PTY LTD" and falls
      // under the match threshold — losing exactly the sole traders whose
      // mobile numbers depend on an ABN match to get imported at all.
      .replace(/['‘’]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0 && !NOISE_WORDS.has(word))
  );
}

/**
 * How alike two business names are, 0-1.
 *
 * Deliberately simple: the share of the Google name's meaningful words that
 * also appear in the registered name. A registered entity is often longer than
 * the trading name ("SMITH FAMILY TRUST" trading as "Smith Plumbing"), so
 * measuring against the shorter side avoids punishing exactly the sole traders
 * we most want to keep.
 */
export function nameSimilarity(googleName: string, registeredName: string): number {
  const a = normaliseBusinessName(googleName);
  const b = new Set(normaliseBusinessName(registeredName));
  if (a.length === 0 || b.size === 0) return 0;

  const shared = a.filter((word) => b.has(word)).length;
  return shared / a.length;
}

/** Confidence at or above this counts as the same business. */
const MATCH_THRESHOLD = 0.5;

/**
 * Look a business up by name. Never throws — the ABN check is a bonus signal,
 * and an outage on the government's side must not stop a lead run.
 */
export async function lookupAbn(params: {
  businessName: string;
  state?: string;
  onCall: CallLogger;
}): Promise<AbnMatch> {
  const guid = optional("ABN_LOOKUP_GUID");
  if (!guid) return { status: "not_checked", confidence: 0 };

  const url =
    `${MATCHING_NAMES_URL}?name=${encodeURIComponent(params.businessName)}` +
    `&maxResults=10&guid=${encodeURIComponent(guid)}`;

  let text: string;
  let httpStatus = 0;

  try {
    const response = await fetch(url);
    httpStatus = response.status;
    text = await response.text();

    params.onCall({
      sku: "abn_lookup",
      detail: params.businessName,
      httpStatus,
      resultCount: 0,
      unitCostUsd: unitCostUsd("abn_lookup"),
    });

    if (!response.ok) return { status: "unknown", confidence: 0 };
  } catch {
    params.onCall({
      sku: "abn_lookup",
      detail: params.businessName,
      httpStatus: 0,
      resultCount: 0,
      unitCostUsd: 0,
    });
    return { status: "unknown", confidence: 0 };
  }

  let names: RawName[];
  try {
    names = parseJsonp(text);
  } catch {
    return { status: "unknown", confidence: 0 };
  }

  let best: { match: RawName; confidence: number } | null = null;

  for (const entry of names) {
    if (!entry.Name || !entry.Abn) continue;

    // A business in a different state is a different business.
    if (params.state && entry.State && entry.State.toUpperCase() !== params.state.toUpperCase()) {
      continue;
    }

    const confidence = nameSimilarity(params.businessName, entry.Name);
    if (!best || confidence > best.confidence) best = { match: entry, confidence };
  }

  if (!best || best.confidence < MATCH_THRESHOLD) {
    return { status: "unknown", confidence: best?.confidence ?? 0 };
  }

  const status: AbnStatus =
    (best.match.AbnStatus ?? "").toLowerCase() === "active" ? "active" : "cancelled";

  return {
    status,
    abn: best.match.Abn,
    registeredName: best.match.Name,
    confidence: best.confidence,
  };
}

/**
 * ABN Lookup wraps its JSON in a JavaScript callback, e.g.
 *   callback({"Names":[...]})
 * Peel the wrapper, then parse.
 */
export function parseJsonp(text: string): RawName[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");

  const json =
    start !== -1 && end > start ? trimmed.slice(start + 1, end) : trimmed;

  const parsed = JSON.parse(json) as { Names?: RawName[] };
  return parsed.Names ?? [];
}
