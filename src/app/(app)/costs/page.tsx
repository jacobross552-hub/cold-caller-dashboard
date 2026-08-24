/**
 * The costs page — what the system has cost since day one, and where the money
 * went.
 *
 * Two things on this page are deliberately NOT cost lines, and both would be
 * wrong if they were:
 *
 *   The included pool. Minutes inside the ElevenLabs allowance have a metered
 *   value but cost no cash — the plan fee already paid for them. They are
 *   shown so the value is visible and excluded from the total so it isn't
 *   double-counted.
 *
 *   The Railway runway. Railway is a trial workspace with a one-time credit
 *   grant and no card on file, so its monthly cost is genuinely zero. The risk
 *   isn't a bill, it's the deployment being shut off when the credits run out.
 *   That belongs on screen, but not in a spend total.
 *
 * See src/lib/costs.ts for the rules the figures follow.
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

// The plain .badge is the neutral grey one.
const BADGE_CLASS: Record<Provenance, string> = {
  measured: "good",
  rated: "warn",
  included: "",
  configured: "",
};

function formatNative(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

export default async function CostsPage() {
  const costs = await lifetimeCosts();
  const units = unitCosts(costs);

  const unpriced = costs.lines.filter((l) => !l.excludedFromTotal && l.aud === null);
  const current = costs.periods.at(-1) ?? null;
  const runway = costs.runway;

  const poolPct = current
    ? Math.min(100, (current.minutesUsed / current.includedMinutes) * 100)
    : 0;

  return (
    <>
      <h1>Costs</h1>
      <p className="sub">
        Everything the system has cost since{" "}
        {costs.since ? formatSydney(new Date(costs.since)) : "it started"}, by source.
      </p>

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

      {/* ---- Railway runway. An uptime risk, not a cost. ---- */}
      {runway && (
        <div
          className={`notice ${
            runway.daysRemaining !== null && runway.daysRemaining < 30 ? "bad" : "warn"
          }`}
        >
          <strong>
            Railway credits: ${runway.remainingUsd.toFixed(2)} of $
            {runway.grantUsd.toFixed(2)} left.
          </strong>{" "}
          {runway.burnUsdPerDay !== null ? (
            <>
              Burning ${runway.burnUsdPerDay.toFixed(4)}/day at the observed rate, which runs out
              around{" "}
              <strong>
                {runway.exhaustedAt ? formatSydney(new Date(runway.exhaustedAt)) : "unknown"}
              </strong>{" "}
              ({Math.round(runway.daysRemaining ?? 0)} days).
            </>
          ) : (
            <>Not enough history yet to work out a daily burn rate.</>
          )}{" "}
          This is a one-time grant, not a subscription — there is no card on file, and Railway
          shuts deployments down when credits run out. The dashboard goes off the air at that
          point, taking the post-call webhook with it.
        </div>
      )}

      {costs.incomplete && (
        <div className="notice warn">
          <strong>This total is a floor, not a full figure.</strong> {unpriced.length}{" "}
          {unpriced.length === 1 ? "line has" : "lines have"} no figure yet, so the real spend is
          higher than what&apos;s shown. Nothing is estimated to fill the gap — a missing number
          stays missing.
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
                <th style={{ textAlign: "right" }}>As billed</th>
                <th style={{ textAlign: "right" }}>Lifetime AUD</th>
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
                  <td
                    className="small"
                    style={{ textAlign: "right", whiteSpace: "nowrap" }}
                  >
                    {line.native === null ? (
                      <span className="muted">pending</span>
                    ) : (
                      formatNative(line.native.amount, line.native.currency)
                    )}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {line.excludedFromTotal ? (
                      <span className="muted" title="Covered by an allowance already paid for">
                        not charged
                      </span>
                    ) : line.aud === null ? (
                      <span className="muted">pending</span>
                    ) : (
                      formatAud(line.aud)
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={4}>
                  <strong>{costs.incomplete ? "Total of what can be priced" : "Total"}</strong>
                  <div className="small muted">
                    Lines marked &quot;not charged&quot; are excluded — the plan fee already paid
                    for them, and counting them here would bill the same minutes twice.
                  </div>
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
        {/* ---- The included pool ---- */}
        <div className="panel">
          <h2>Included minutes</h2>
          {current ? (
            <>
              <p className="small">
                <strong>
                  {current.minutesUsed.toFixed(1)} of {current.includedMinutes} minutes
                </strong>{" "}
                used in the billing period that started {formatSydney(new Date(current.startedAt))}.
              </p>
              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  background: "var(--line)",
                  overflow: "hidden",
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    width: `${poolPct}%`,
                    height: "100%",
                    background: poolPct >= 100 ? "var(--bad)" : "var(--good)",
                  }}
                />
              </div>
              <p className="small muted">
                Minutes inside the pool cost nothing extra — the plan fee buys them. Only minutes
                past {current.includedMinutes} are charged, at the overage rate. At 250 calls a day
                averaging under three minutes, the pool is gone in a single day, so expect this to
                become the largest line on the page the moment real calling starts.
              </p>
              {costs.periods.length > 1 && (
                <dl className="kv">
                  {costs.periods.map((p) => (
                    <div key={p.startedAt} style={{ display: "contents" }}>
                      <dt className="small">{formatSydney(new Date(p.startedAt))}</dt>
                      <dd className="small">
                        {p.minutesUsed.toFixed(1)} min
                        {p.overageMinutes > 0
                          ? ` — ${p.overageMinutes.toFixed(1)} over, $${p.overageUsd.toFixed(2)} USD`
                          : " — inside the pool"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          ) : (
            <p className="small muted">No calls recorded yet.</p>
          )}
        </div>

        <div className="panel">
          <h2>What the labels mean</h2>
          <dl className="kv">
            <dt>
              <span className="badge good">Measured</span>
            </dt>
            <dd>
              Summed from what the provider itself charged, one row per event. Auditable months
              later, and unaffected by a later price change.
            </dd>
            <dt>
              <span className="badge warn">Rated</span>
            </dt>
            <dd>
              Real recorded usage times a rate. The only one left is the Twilio number rental, and
              even its rate is read live off Twilio&apos;s pricing API for this account rather than
              typed into <code>.env</code>.
            </dd>
            <dt>
              <span className="badge">Included</span>
            </dt>
            <dd>
              Real usage covered by an allowance already paid for. Shown at its metered value so
              you can see what the allowance is worth, and kept out of the total so the same
              minutes aren&apos;t charged twice.
            </dd>
            <dt>
              <span className="badge">Configured</span>
            </dt>
            <dd>A flat subscription the dashboard can&apos;t see, times the months running.</dd>
          </dl>
        </div>
      </div>

      <div className="panel">
        <h2>Three things worth knowing</h2>
        <p className="small">
          <strong>Twilio bills you twice over.</strong> ElevenLabs dials through your own Twilio
          number, so Twilio charges for the call minutes and the number rental on top of what
          ElevenLabs charges for the call. Those charges are read back from Twilio by call id
          rather than estimated — which is why a just-finished call shows{" "}
          <em>pending</em> until Twilio settles the price, never $0.
        </p>
        <p className="small">
          <strong>There are two separate LLM bills.</strong> The voice agent&apos;s own model is
          billed by ElevenLabs and reported in the call payload. The dashboard&apos;s Anthropic key
          pays for something different — the summaries and pre-call briefings. Neither figure
          includes the other.
        </p>
        <p className="small">
          <strong>Metered is not charged.</strong> The per-call figure ElevenLabs reports is what
          the call would cost at the overage rate. While usage sits inside the included pool the
          invoice reads $0.00, so that value is shown but not spent.
        </p>
        <p className="small muted">
          Every amount is held in the currency its provider reported and converted once, here, at{" "}
          {costs.fxRate.toFixed(2)} AUD per USD (<code>USD_AUD_RATE</code>). No exchange rate is
          ever stored against a row — a rate saved at write time is wrong tomorrow and
          unrecoverable afterwards.
        </p>
      </div>
    </>
  );
}
