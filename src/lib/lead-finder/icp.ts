/**
 * ICP scoring — how good a prospect is, 0-100, with the reasoning attached.
 *
 * PURE ON PURPOSE. No database, no network, no clock. Feed it a candidate and
 * a context, get back a score and the reasons. That makes it the one part of
 * the lead finder that can be tested exhaustively without spending a cent:
 * `npm run test:icp`.
 *
 * The signals come from the missed-call research: the best prospect is a small
 * trade business that takes real phone volume, shuts in the evening, and has
 * not already bought a receptionist or an answering service.
 *
 * Scores are relative, not absolute — a 72 is a better prospect than a 55.
 * There is no meaning to "above 80 is good"; use the ranking, not the number.
 */

import type { HoursSummary } from "./hours";

export type Tier = 1 | 2 | 3 | "other";

export interface VerticalDefinition {
  /** Stable id, stored on the lead. */
  id: string;
  /** What the user sees. */
  label: string;
  tier: Tier;
  /** The words that go into the Google text search. */
  searchTerm: string;
}

/**
 * The target list from the missed-call research.
 *
 * Tier 1 — emergency/urgency trades: highest missed-call rates, biggest ticket.
 * Tier 2 — high value per lead, reception usually under-resourced.
 * Tier 3 — high call volume, appointment-driven, smaller ticket.
 */
export const VERTICALS: VerticalDefinition[] = [
  // Tier 1
  { id: "plumber", label: "Plumbers", tier: 1, searchTerm: "plumber" },
  { id: "electrician", label: "Electricians", tier: 1, searchTerm: "electrician" },
  { id: "roofer", label: "Roofers", tier: 1, searchTerm: "roofing contractor" },
  { id: "hvac", label: "Air conditioning / HVAC", tier: 1, searchTerm: "air conditioning service" },
  { id: "pest_control", label: "Pest control", tier: 1, searchTerm: "pest control service" },
  { id: "locksmith", label: "Locksmiths", tier: 1, searchTerm: "locksmith" },
  { id: "garage_door", label: "Garage doors", tier: 1, searchTerm: "garage door supplier" },
  { id: "appliance_repair", label: "Appliance repair", tier: 1, searchTerm: "appliance repair service" },
  // Tier 2
  { id: "real_estate", label: "Real estate / property management", tier: 2, searchTerm: "real estate agency" },
  { id: "dentist", label: "Dental practices", tier: 2, searchTerm: "dentist" },
  { id: "vet", label: "Veterinary clinics", tier: 2, searchTerm: "veterinary clinic" },
  { id: "law_firm", label: "Small law firms", tier: 2, searchTerm: "law firm" },
  { id: "mechanic", label: "Auto repair / mechanics", tier: 2, searchTerm: "auto repair shop" },
  // Tier 3
  { id: "hair_beauty", label: "Hair & beauty salons", tier: 3, searchTerm: "hair salon" },
  { id: "physio", label: "Physio / chiro / podiatry", tier: 3, searchTerm: "physiotherapist" },
  { id: "landscaping", label: "Landscaping / gardening", tier: 3, searchTerm: "landscaper" },
];

export function verticalById(id: string): VerticalDefinition | undefined {
  return VERTICALS.find((v) => v.id === id);
}

/** A free-typed vertical the user invented. Scored as "other". */
export function customVertical(term: string): VerticalDefinition {
  const clean = term.trim();
  return { id: `custom:${clean.toLowerCase()}`, label: clean, tier: "other", searchTerm: clean };
}

export interface Candidate {
  placeId: string;
  name: string;
  address?: string;
  /** E.164, already normalised. Absent means no usable phone was published. */
  phoneE164?: string;
  phoneKind?: "mobile" | "landline";
  website?: string;
  rating?: number;
  reviewCount?: number;
  /** Google's own view of whether the business is trading. */
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
  hours?: HoursSummary;
  vertical: VerticalDefinition;
  suburb?: string;
  state?: string;
}

export interface ScoreContext {
  /** Result of the ABN cross-check, if one was run. */
  abnStatus?: "active" | "cancelled" | "unknown" | "not_checked";
  /**
   * How many times this exact business name appeared across the whole run.
   * A name in eight suburbs is a chain with a call centre, not a sole trader.
   */
  nameOccurrences?: number;
}

export interface IcpScore {
  score: number;
  /** Human-readable, shown on the lead and in the run summary. */
  reasons: string[];
  /** True means never import this, whatever the score. */
  disqualified: boolean;
  disqualifiedReason?: string;
  /** What backs up a mobile number being a real business line. */
  corroboration: string[];
}

/**
 * Names that mean "national chain with a call centre already". Kept short on
 * purpose — the repeat-name heuristic below catches chains far more reliably
 * than a list anyone has to maintain by hand.
 */
const CHAIN_MARKERS = [
  "jim's",
  "jims ",
  "hire a hubby",
  "mr rooter",
  "laser plumbing",
  "metropolitan plumbing",
  "fantastic services",
  "bunnings",
  "ray white",
  "lj hooker",
  "harcourts",
  "mcgrath",
  "century 21",
  "raine & horne",
  "first national",
  "professionals",
  "just cuts",
  "supercuts",
  "midas",
  "kmart tyre",
  "ultra tune",
  "repco",
  "national storage",
];

/** Copy that means "we already solved the missed-call problem". */
const ALREADY_SOLVED = [
  "24/7",
  "24 hour",
  "24hr",
  "answering service",
  "virtual receptionist",
  "call centre",
  "call center",
];

function looksLikeChain(name: string): boolean {
  const lower = name.toLowerCase();
  return CHAIN_MARKERS.some((marker) => lower.includes(marker));
}

function advertisesAlwaysOn(candidate: Candidate): boolean {
  const haystack = `${candidate.name} ${candidate.website ?? ""}`.toLowerCase();
  return ALREADY_SOLVED.some((phrase) => haystack.includes(phrase));
}

function tierPoints(tier: Tier): number {
  if (tier === 1) return 30;
  if (tier === 2) return 22;
  if (tier === 3) return 15;
  return 12;
}

/**
 * Review count as a proxy for how many calls actually come in.
 *
 * Deliberately falls away at the top: 800 reviews is a business big enough to
 * employ someone to answer the phone, which is the opposite of the target.
 */
function reviewPoints(count: number | undefined): { points: number; reason: string } {
  if (count === undefined) {
    return { points: 6, reason: "No review count published, so call volume is unknown." };
  }
  if (count < 5) {
    return { points: 0, reason: `Only ${count} review(s) — probably isn't taking many calls.` };
  }
  if (count < 15) return { points: 6, reason: `${count} reviews — light but real call volume.` };
  if (count < 40) return { points: 14, reason: `${count} reviews — steady call volume.` };
  if (count < 80) return { points: 20, reason: `${count} reviews — good call volume.` };
  if (count < 300) {
    return { points: 25, reason: `${count} reviews — strong call volume, the sweet spot.` };
  }
  if (count < 600) {
    return { points: 18, reason: `${count} reviews — busy, and may already have someone on phones.` };
  }
  return { points: 10, reason: `${count} reviews — large operation, likely has reception already.` };
}

/**
 * The core signal: do their calls go unanswered after hours?
 *
 * A business advertising 24/7 phone cover has already bought the thing we sell,
 * so it scores zero here rather than being rejected — it may still be worth a
 * call, just last.
 */
function afterHoursPoints(
  hours: HoursSummary | undefined,
  alwaysOn: boolean,
): { points: number; reasons: string[] } {
  const reasons: string[] = [];

  if (alwaysOn) {
    reasons.push("Advertises 24/7 or an answering service — has probably solved this already.");
    return { points: 0, reasons };
  }

  if (!hours || !hours.hasHours) {
    reasons.push("No opening hours published, so after-hours cover is unknown.");
    return { points: 7, reasons };
  }

  if (hours.is24x7) {
    reasons.push("Listed as open 24/7 — unlikely to be missing after-hours calls.");
    return { points: 0, reasons };
  }

  let points = 0;
  const close = hours.closesWeekdayMinutes;

  if (close === null) {
    points += 7;
    reasons.push("Weekday closing time unclear.");
  } else if (close <= 17 * 60) {
    points += 14;
    reasons.push(`Shuts at ${formatMinutes(close)} on weekdays — every evening call goes unanswered.`);
  } else if (close <= 18 * 60) {
    points += 12;
    reasons.push(`Shuts at ${formatMinutes(close)} on weekdays — misses the evening rush.`);
  } else if (close <= 20 * 60) {
    points += 7;
    reasons.push(`Open until ${formatMinutes(close)} on weekdays — some evening cover.`);
  } else {
    points += 3;
    reasons.push(`Open until ${formatMinutes(close)} — long hours already.`);
  }

  if (!hours.openSaturday && !hours.openSunday) {
    points += 6;
    reasons.push("Closed all weekend — two full days of calls going to voicemail.");
  } else if (!hours.openSunday) {
    points += 3;
    reasons.push("Closed Sundays.");
  }

  return { points, reasons };
}

function independencePoints(
  candidate: Candidate,
  context: ScoreContext,
): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  const occurrences = context.nameOccurrences ?? 1;

  if (looksLikeChain(candidate.name)) {
    reasons.push("Reads as a franchise or national brand — heads office probably owns the phones.");
    return { points: 0, reasons };
  }

  if (occurrences >= 4) {
    reasons.push(`Same business name found in ${occurrences} places — a chain, not a sole trader.`);
    return { points: 0, reasons };
  }

  if (occurrences >= 2) {
    reasons.push(`Name appears in ${occurrences} locations — possibly a small multi-site operation.`);
    return { points: 7, reasons };
  }

  if ((candidate.reviewCount ?? 0) >= 600) {
    reasons.push("Review volume suggests a larger operation than the ideal target.");
    return { points: 7, reasons };
  }

  reasons.push("Looks like an independent local operator.");
  return { points: 15, reasons };
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display}${suffix}` : `${display}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * Score a candidate.
 *
 * MOBILE NUMBERS. An 04 number is not automatically a personal number — for a
 * sole-trader sparky it usually IS the business line, and those are the best
 * prospects on the list. So a mobile is allowed through only when something
 * else confirms a business sits behind it: an active ABN, a working website, or
 * a business category on the listing. An uncorroborated mobile is refused
 * outright, because that is the one case where it might be someone's personal
 * phone.
 */
export function scoreCandidate(candidate: Candidate, context: ScoreContext = {}): IcpScore {
  const reasons: string[] = [];

  // ---- Hard disqualifiers, checked before anything is scored -------------
  const reject = (reason: string): IcpScore => ({
    score: 0,
    reasons: [reason],
    disqualified: true,
    disqualifiedReason: reason,
    corroboration: [],
  });

  if (candidate.businessStatus && candidate.businessStatus !== "OPERATIONAL") {
    return reject(
      candidate.businessStatus === "CLOSED_PERMANENTLY"
        ? "Google says this business has closed permanently."
        : "Google says this business is not currently trading.",
    );
  }

  if (!candidate.phoneE164) {
    return reject("No phone number published — nothing to call.");
  }

  if (context.abnStatus === "cancelled") {
    return reject("Its ABN is cancelled — not a currently registered business.");
  }

  // ---- Corroboration, which decides whether a mobile is allowed ----------
  const corroboration: string[] = [];
  if (context.abnStatus === "active") corroboration.push("active ABN on the business register");
  if (candidate.website) corroboration.push("published business website");
  if (candidate.primaryType) corroboration.push(`listed as "${candidate.primaryType}" on Google`);

  if (candidate.phoneKind === "mobile" && corroboration.length === 0) {
    return reject(
      "Mobile number with nothing to confirm a business behind it — could be a personal phone, so it is not imported.",
    );
  }

  // ---- Scoring ------------------------------------------------------------
  const tier = tierPoints(candidate.vertical.tier);
  reasons.push(
    candidate.vertical.tier === "other"
      ? `${candidate.vertical.label} — outside the researched target list.`
      : `${candidate.vertical.label} — tier ${candidate.vertical.tier} target vertical.`,
  );

  const reviews = reviewPoints(candidate.reviewCount);
  reasons.push(reviews.reason);

  const alwaysOn = advertisesAlwaysOn(candidate);
  const afterHours = afterHoursPoints(candidate.hours, alwaysOn);
  reasons.push(...afterHours.reasons);

  const independence = independencePoints(candidate, context);
  reasons.push(...independence.reasons);

  let contactability: number;
  if (candidate.phoneKind === "mobile") {
    contactability = 8;
    reasons.push(`Mobile number, backed by ${corroboration.join(" and ")}.`);
  } else {
    contactability = 10;
    reasons.push("Published landline — a normal business line.");
  }

  if (context.abnStatus === "active") {
    reasons.push("ABN is active on the Australian Business Register.");
  } else if (context.abnStatus === "unknown") {
    reasons.push("No confident ABN match — not disqualifying, just unconfirmed.");
  }

  const score = Math.max(
    0,
    Math.min(100, tier + reviews.points + afterHours.points + independence.points + contactability),
  );

  return { score, reasons, disqualified: false, corroboration };
}
