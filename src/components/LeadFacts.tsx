/**
 * What the lead finder knows about a business, shown next to what was said
 * on the call.
 *
 * Deliberately kept OUT of the LLM analysis and rendered as its own clearly
 * sourced block. The briefing's whole guarantee is that every figure in it
 * was actually spoken on the call; mixing Google listing data into that
 * prompt is the fastest way to end up with a "fact" the prospect never said.
 * So: transcript facts in the briefing, listing facts here, never blended.
 */

import type { LeadRow } from "@/lib/leads";

function scoreClass(score: number): string {
  if (score >= 70) return "badge good";
  if (score >= 40) return "badge warn";
  return "badge";
}

function openingHours(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.weekdayDescriptions)) {
      return parsed.weekdayDescriptions.filter((x: unknown): x is string => typeof x === "string");
    }
  } catch {
    // Malformed hours are not worth failing a page over.
  }
  return [];
}

export function LeadFacts({
  lead,
  inline = false,
}: {
  lead: LeadRow | null;
  /** Render without the panel chrome, for embedding inside an existing panel. */
  inline?: boolean;
}) {
  if (!lead) return null;

  const reasons = (lead.icp_reasons ?? "")
    .split(/\s*[;|]\s*|\n/)
    .map((r) => r.trim())
    .filter(Boolean);

  const hours = openingHours(lead.opening_hours_json);

  // A lead typed in by hand has none of this — don't render an empty box.
  const hasListingData =
    lead.icp_score !== null ||
    lead.google_rating !== null ||
    lead.website !== null ||
    lead.vertical !== null ||
    hours.length > 0;

  if (!hasListingData) return null;

  return (
    <div className={inline ? "" : "panel"} style={inline ? { marginTop: 16 } : undefined}>
      {inline ? <h3>From their listing</h3> : <h2>From their listing</h2>}
      <p className="small muted" style={{ marginTop: -6 }}>
        Gathered when the lead was sourced — not from the call.
      </p>

      <dl className="kv" style={{ marginBottom: reasons.length || hours.length ? 14 : 0 }}>
        {lead.icp_score !== null && (
          <>
            <dt>Fit score</dt>
            <dd>
              <span className={scoreClass(lead.icp_score)}>{lead.icp_score}/100</span>
            </dd>
          </>
        )}
        {lead.vertical && (
          <>
            <dt>Trade</dt>
            <dd>{lead.vertical}</dd>
          </>
        )}
        {(lead.suburb || lead.state) && (
          <>
            <dt>Location</dt>
            <dd>{[lead.suburb, lead.state].filter(Boolean).join(", ")}</dd>
          </>
        )}
        {lead.google_rating !== null && (
          <>
            <dt>Google rating</dt>
            <dd>
              {lead.google_rating}
              {lead.google_review_count !== null && (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {" "}
                  from {lead.google_review_count} review
                  {lead.google_review_count === 1 ? "" : "s"}
                </span>
              )}
            </dd>
          </>
        )}
        <>
          <dt>Website</dt>
          <dd style={lead.website ? undefined : { fontWeight: 400 }}>
            {lead.website ? (
              <a href={lead.website} target="_blank" rel="noreferrer noopener">
                {lead.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            ) : (
              <span className="muted">none listed</span>
            )}
          </dd>
        </>
        {lead.abn && (
          <>
            <dt>ABN</dt>
            <dd>
              {lead.abn}
              {lead.abn_status && (
                <span className="muted" style={{ fontWeight: 400 }}> ({lead.abn_status})</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {reasons.length > 0 && (
        <>
          <h3>Why it scored that</h3>
          <ul className="tight small" style={{ marginBottom: hours.length ? 14 : 0 }}>
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </>
      )}

      {hours.length > 0 && (
        <>
          <h3>Opening hours</h3>
          <ul className="tight small" style={{ marginBottom: 0 }}>
            {hours.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
