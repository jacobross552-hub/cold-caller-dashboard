/**
 * The pre-call briefing.
 *
 * The point of this block: read it in thirty seconds before the demo and know
 * the shape of the conversation — their numbers, what they pushed back on,
 * what they cared about, and any price already on the table.
 */

import { formatMoney, type PriceBand } from "@/lib/pricing";
import { STAGE_LABELS } from "@/lib/brief";
import type { StoredBrief } from "@/lib/calls";

function Figure({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={value ? undefined : "muted"} style={value ? undefined : { fontWeight: 400 }}>
        {value ?? "not given on the call"}
      </dd>
    </>
  );
}

export function Brief({ brief, compact = false }: { brief: StoredBrief; compact?: boolean }) {
  const { analysis, quoteCheck } = brief;

  const figureNote =
    analysis.figure_agreed === "agreed"
      ? "They agreed with it."
      : analysis.figure_agreed === "disputed"
        ? `They disputed it${analysis.prospect_own_figure ? ` and said it was closer to ${formatMoney(analysis.prospect_own_figure)}` : ""}.`
        : "Never got to the maths.";

  return (
    <div className="brief">
      {analysis.business_description && (
        <p style={{ marginTop: 0 }}>
          <strong>The business.</strong> {analysis.business_description}
        </p>
      )}

      <h3>Their numbers</h3>
      <dl className="kv" style={{ marginBottom: 16 }}>
        <Figure
          label="Missed calls / week"
          value={analysis.missed_calls_per_week !== null ? String(analysis.missed_calls_per_week) : null}
        />
        <Figure
          label="Average job value"
          value={analysis.job_value_dollars !== null ? formatMoney(analysis.job_value_dollars) : null}
        />
        <Figure
          label="Raw weekly loss"
          value={analysis.raw_weekly_loss !== null ? formatMoney(analysis.raw_weekly_loss) : null}
        />
        <Figure
          label="Discounted figure (X)"
          value={
            analysis.discounted_weekly_loss !== null
              ? `${formatMoney(analysis.discounted_weekly_loss)} a week`
              : null
          }
        />
        <dt>Did they buy it?</dt>
        <dd style={{ fontWeight: 400 }}>{figureNote}</dd>
      </dl>

      <h3>Price</h3>
      <div style={{ marginBottom: 16 }}>
        {analysis.price_quoted ? (
          <>
            <p style={{ margin: "0 0 6px" }}>
              <strong>
                {analysis.quoted_setup_fee !== null ? formatMoney(analysis.quoted_setup_fee) : "?"} to set
                up,{" "}
                {analysis.quoted_monthly_retainer !== null
                  ? formatMoney(analysis.quoted_monthly_retainer)
                  : "?"}{" "}
                a month
              </strong>{" "}
              was quoted on the call.
            </p>
            <p
              className={`small ${quoteCheck.status === "off-table" ? "" : "muted"}`}
              style={
                quoteCheck.status === "off-table"
                  ? { color: "var(--bad)", fontWeight: 600, margin: 0 }
                  : { margin: 0 }
              }
            >
              {quoteCheck.message}
            </p>
          </>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            No price was quoted. {expectedBandNote(quoteCheck.expected)}
          </p>
        )}
      </div>

      <h3>What they pushed back on</h3>
      {analysis.objections.length === 0 ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          Nothing — no objections raised.
        </p>
      ) : (
        <ul className="tight small" style={{ marginBottom: 16 }}>
          {analysis.objections.map((objection, index) => (
            <li key={index}>
              <strong>{objection.objection}.</strong> &ldquo;{objection.what_they_said}&rdquo; —{" "}
              {objection.how_it_landed}
            </li>
          ))}
        </ul>
      )}

      <h3>What they seemed to care about</h3>
      {analysis.cared_about.length === 0 ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          Nothing clear from the call.
        </p>
      ) : (
        <ul className="tight small" style={{ marginBottom: 16 }}>
          {analysis.cared_about.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}

      <h3>Worth knowing before you dial</h3>
      <ul className="tight small" style={{ marginBottom: compact ? 0 : 16 }}>
        {analysis.talking_points.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
        {analysis.asked_if_ai && (
          <li>
            They asked whether they were talking to a bot — the agent told them the truth, so they know
            they were sold to by the product itself.
          </li>
        )}
      </ul>

      {!compact && (
        <>
          <h3>How far the call got</h3>
          <p className="small" style={{ marginTop: 0 }}>
            {STAGE_LABELS[analysis.furthest_stage]}
          </p>

          {analysis.agent_slips.length > 0 && (
            <>
              <h3>Script problems on this call</h3>
              <ul className="tight small">
                {analysis.agent_slips.map((slip, index) => (
                  <li key={index}>{slip}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function expectedBandNote(band: PriceBand | undefined): string {
  if (!band) return "";
  return `Based on their weekly figure, the table puts them at ${formatMoney(band.setupFee)} setup and ${formatMoney(band.monthlyRetainer)} a month.`;
}
