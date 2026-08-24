/**
 * Gathering what's known about a prospect before their demo agent is built.
 *
 * Three sources: what the lead finder already captured (Google Places), what
 * the prospect said on the cold call itself (the stored analysis), and the
 * prospect's own website if one's on file. EVERY step degrades gracefully —
 * a missing website, a fetch timeout, or a site that blocks scraping must
 * never block demo-agent creation. It only narrows what the prompt can say.
 */

import type { LeadRow } from "./leads";
import type { CallAnalysis } from "./brief";

export interface DemoResearch {
  businessName: string;
  vertical: string | null;
  suburb: string | null;
  state: string | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  openingHours: string[] | null;
  abnStatus: string | null;
  /** From the cold-call transcript's own analysis, if one exists. */
  businessDescription: string | null;
  caredAbout: string[];
  talkingPoints: string[];
  /** Plain text pulled from the prospect's own site, or null if none/unreachable. */
  websiteText: string | null;
  websiteUrl: string | null;
  /** Plain-English notes on what couldn't be gathered and why — shown in the UI, never hidden. */
  gaps: string[];
}

const WEBSITE_FETCH_TIMEOUT_MS = 8_000;
/** Enough for a prompt section, not a full site dump. */
const WEBSITE_TEXT_MAX_CHARS = 4_000;

/** Crude but dependency-free: strip script/style blocks, then all tags, then collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWebsiteText(url: string): Promise<{ text: string | null; gap: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBSITE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; demo-agent-research/1.0)" },
    });

    if (!response.ok) {
      return { text: null, gap: `Website returned HTTP ${response.status} — skipped.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return { text: null, gap: `Website content type (${contentType || "unknown"}) wasn't readable HTML — skipped.` };
    }

    const html = await response.text();
    const text = htmlToText(html).slice(0, WEBSITE_TEXT_MAX_CHARS);
    if (text.length < 40) {
      return { text: null, gap: "Website loaded but had almost no readable text (likely JS-rendered) — skipped." };
    }
    return { text, gap: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { text: null, gap: `Couldn't reach the website (${detail}) — skipped.` };
  } finally {
    clearTimeout(timer);
  }
}

export async function gatherResearch(lead: LeadRow | null, analysis: CallAnalysis | null): Promise<DemoResearch> {
  const gaps: string[] = [];

  let openingHours: string[] | null = null;
  if (lead?.opening_hours_json) {
    try {
      // Google's regularOpeningHours is an OBJECT — { periods: [...], weekdayDescriptions: [...],
      // openNow, nextCloseTime } — not a bare array. This is what leads.opening_hours_json actually
      // stores (see lead-finder/places.ts's toPlaceResult). weekdayDescriptions is the human-readable
      // "Monday: 7:30 am – 10:00 pm" form, which is what a demo prompt actually wants.
      const parsed = JSON.parse(lead.opening_hours_json) as { weekdayDescriptions?: unknown };
      const days = parsed.weekdayDescriptions;
      if (Array.isArray(days) && days.every((d) => typeof d === "string") && days.length > 0) {
        openingHours = days as string[];
      } else {
        gaps.push("Stored opening hours had no day-by-day description — skipped.");
      }
    } catch {
      gaps.push("Stored opening hours weren't readable — skipped.");
    }
  } else if (lead) {
    gaps.push("No opening hours on file for this lead.");
  }

  let websiteText: string | null = null;
  const websiteUrl = lead?.website ?? null;
  if (websiteUrl) {
    const { text, gap } = await fetchWebsiteText(websiteUrl);
    websiteText = text;
    if (gap) gaps.push(gap);
  } else {
    gaps.push("No website on file for this lead.");
  }

  if (!analysis) {
    gaps.push("No call analysis available yet — the demo agent is being built from lead data alone.");
  }

  if (!lead) {
    gaps.push("No lead record linked to this call — the demo agent is being built from the transcript alone.");
  }

  return {
    businessName: lead?.business_name ?? "the business",
    vertical: lead?.vertical ?? null,
    suburb: lead?.suburb ?? null,
    state: lead?.state ?? null,
    googleRating: lead?.google_rating ?? null,
    googleReviewCount: lead?.google_review_count ?? null,
    openingHours,
    abnStatus: lead?.abn_status ?? null,
    businessDescription: analysis?.business_description ?? null,
    caredAbout: analysis?.cared_about ?? [],
    talkingPoints: analysis?.talking_points ?? [],
    websiteText,
    websiteUrl,
    gaps,
  };
}
