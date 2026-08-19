/**
 * The costs page — what the whole system has cost since day one, and where
 * the money went.
 *
 * Every row says how its figure was arrived at. See src/lib/costs.ts for why
 * that matters: some of these numbers are summed from what the provider itself
 * billed, some are real usage priced at a rate you set, and some are flat
 * subscriptions the dashboard cannot see at all. Presenting those three as one
 * undifferentiated dollar figure would be the easy thing and the wrong one.
 */

import {
  lifetimeCosts,
  unitCosts,
  PROVENANCE_LABEL,
  PROVENANCE_BLURB,
  type Provenance,
} from "@/lib/costs";
import { formatAud } from "@/lib/lead-finder/cost";
import { formatSydney } from "@/lib/calling-hours";

export const dynamic = "force-dynamic";

// The plain .badge is the neutral grey one — right for a figure that is
// simply whatever you typed in.
const BADGE_CLASS: Record<Provenance, string> = {
  measured: "good",
  rated: "warn",
  configured: "",
};

export default async function CostsPage() {
  const costs = lifetimeCosts();
  const units = unitCosts(costs);

  const unpriced = costs.lines.filter((l) => l.aud === null);

  return (
    <>
      <h1>Costs</h1>
      <p className="sub">
        Everything the system has cost since{" "}
        {costs.since ? formatSydney(new Date(costs.since)) : "it started"}, by source.
      </p>

      {/* ---- Headline figures ---- */}
      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="n">{formatAud(costs.totalAud)}</div>
          <div className="l">{costs.incomplete ? "Lifetime — at least" : "Lifetime total"}</div>
        </div>
        <div className="stat">
          <div className="n">{units.perCallAud === null ? "—" : formatAud(units.perCallAud)}</div>
          <div className="l">Per call ({units.calls.toLocaleString()})</div>
        </div>
        <div className="stat">
          <div className="n">
            {units.perBookingAud === null ? "—" : formatAud(units.perBookingAud)}
          </div>
          <div className="l">Per meeting booked ({units.bookings.toLocaleString()})</div>
        </div>
        <div className="stat">
          <div className="n">{costs.monthsLive}</div>
          <div className="l">{costs.monthsLive === 1 ? "Month running" : "Months running"}</div>
        </div>
      </div>

      {/* ---- The honesty banner. Never let the total look complete when it isn't. ---- */}
      {costs.incomplete && (
        <div className="notice warn">
          <strong>This total is a floor, not a full figure.</strong> {unpriced.length}{" "}
          {unpriced.length === 1 ? "line item has" : "line items have"} no rate set, so the real
          spend is higher than what&apos;s shown. The unpriced rows are listed below with what to
          set. Nothing here is estimated to fill the gap — a missing number stays missing.
        </div>
      )}

      {/* ---- The breakdown ---- */}
      <div className="panel">
        <h2>Where the money went</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Who charges</th>
                <th>How we know</th>
                <th style={{ textAlign: "right" }}>Lifetime</th>
              </tr>
            </thead>
            <tbody>
              {costs.lines.map((line) => (
                <tr key={line.key}>
                  <td>
                    <strong>{line.label}</strong>
                    <div className="small muted">{line.basis}</div>
                    {line.missing && (
                      <div className="small">
                        <strong>Not counted.</strong> {line.missing}
                      </div>
                    )}
                  </td>
                  <td className="small">{line.provider}</td>
                  <td>
                    <span
                      className={`badge ${BADGE_CLASS[line.provenance]}`.trim()}
                      title={PROVENANCE_BLURB[line.provenance]}
                    >
                      {PROVENANCE_LABEL[line.provenance]}
                    </span>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {line.aud === null ? (
                      <span className="muted">not set</span>
                    ) : (
                      formatAud(line.aud)
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={3}>
                  <strong>{costs.incomplete ? "Total of what can be priced" : "Total"}</strong>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <strong>{formatAud(costs.totalAud)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>What the three labels mean</h2>
          <dl className="kv">
            <dt>
              <span className="badge good">Measured</span>
            </dt>
            <dd>
              Summed from per-event figures the provider itself reported, one row per event, with
              the price that applied stored alongside. Auditable months later, and unaffected by a
              later price change.
            </dd>
            <dt>
              <span className="badge warn">Rated</span>
            </dt>
            <dd>
              The usage is real and recorded — texts actually sent, minutes actually talked — but
              the price is a rate from your <code>.env</code>, not a figure anyone billed you. Treat
              it as close, not exact.
            </dd>
            <dt>
              <span className="badge">Configured</span>
            </dt>
            <dd>
              A flat monthly subscription the dashboard has no visibility into. It is whatever you
              typed in, multiplied by the months the system has been running.
            </dd>
          </dl>
        </div>

        <div className="panel">
          <h2>Two things worth knowing</h2>
          <p className="small">
            <strong>Two separate LLM bills.</strong> The voice agent&apos;s own model is billed by
            ElevenLabs and shows as its own line. The dashboard&apos;s Anthropic key pays for
            something different — the call summaries and pre-call briefings. Neither figure includes
            the other.
          </p>
          <p className="small">
            <strong>Twilio bills you twice over.</strong> ElevenLabs dials through your Twilio
            number, so Twilio charges for the call minutes on top of what ElevenLabs charges for the
            call. That is a real cost the dashboard cannot see, which is why it needs a rate from
            you rather than being left out.
          </p>
          <p className="small muted">
            USD converted at {costs.fxRate.toFixed(2)} AUD (<code>USD_AUD_RATE</code>). Lead-finder
            rows keep the rate that applied on the day of the run, so past runs don&apos;t drift.
          </p>
        </div>
      </div>
    </>
  );
}
