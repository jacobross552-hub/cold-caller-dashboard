/**
 * Revenue, cost, and profit — this week, over the last 12 weeks, and a
 * reinvestment calculator. Reconciles Won deals against Stripe when it's
 * configured.
 */

import { financeOverview, reinvestmentScenarios } from "@/lib/finance";
import { formatMoney } from "@/lib/pricing";
import { featureStatus } from "@/lib/env";
import { FinanceChart } from "@/components/FinanceChart";
import { FunnelChart } from "@/components/FunnelChart";

export const dynamic = "force-dynamic";

function signed(aud: number): string {
  return `${aud >= 0 ? "+" : "−"}${formatMoney(Math.abs(aud))}`;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ reinvest?: string }>;
}) {
  const { reinvest } = await searchParams;
  const overview = await financeOverview();
  const features = featureStatus();

  const parsedPct = Number(reinvest);
  const selectedPct = Number.isFinite(parsedPct) && parsedPct >= 0 && parsedPct <= 100 ? Math.round(parsedPct / 10) * 10 : 50;
  const scenarios = reinvestmentScenarios(overview.week.profitAud);
  const selected = scenarios.find((s) => s.pct === selectedPct) ?? scenarios[5];

  return (
    <>
      <h1>Finance</h1>
      <p className="sub">Revenue, cost, and profit — this week, and the last 12 weeks.</p>

      {!features.stripe && (
        <div className="notice warn">
          Stripe isn&apos;t connected, so the revenue below is what was <strong>recorded</strong> when a deal
          was marked Won — not confirmed against what was actually paid. Add{" "}
          <code>STRIPE_SECRET_KEY</code> to <code>.env</code> for read-only reconciliation.
        </div>
      )}

      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="n">{formatMoney(overview.week.revenueAud)}</div>
          <div className="l">
            Revenue, last 7 days
            <br />
            <span className="muted">{overview.week.revenueProvenance === "measured" ? "Measured (Stripe)" : "Recorded (Won deals)"}</span>
          </div>
        </div>
        <div className="stat">
          <div className="n">{formatMoney(overview.week.costAud)}</div>
          <div className="l">
            Cost, last 7 days
            <br />
            <span className="muted">Measured + rated</span>
          </div>
        </div>
        <div className="stat">
          <div className="n" style={{ color: overview.week.profitAud >= 0 ? "var(--good)" : "var(--bad)" }}>
            {signed(overview.week.profitAud)}
          </div>
          <div className="l">
            Profit, last 7 days
            <br />
            <span className="muted">Revenue minus cost</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Revenue and cost, last 12 weeks</h2>
        <FinanceChart series={overview.series} />
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Reinvestment calculator</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Calculator only — moving this changes what&apos;s shown here, nothing else. It never touches the
            daily call cap or any live setting.
          </p>
          {overview.week.profitAud <= 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No positive profit this week to split — nothing to reinvest yet.
            </p>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
                {scenarios.map((s) => (
                  <a
                    key={s.pct}
                    href={`/finance?reinvest=${s.pct}`}
                    className="badge"
                    style={
                      s.pct === selected.pct
                        ? { background: "var(--accent)", color: "#fff" }
                        : undefined
                    }
                  >
                    {s.pct}%
                  </a>
                ))}
              </div>
              <dl className="kv">
                <dt>Reinvest ({selected.pct}%)</dt>
                <dd>{formatMoney(selected.reinvestAud)}</dd>
                <dt>Your draw ({100 - selected.pct}%)</dt>
                <dd>{formatMoney(selected.drawAud)}</dd>
              </dl>
            </>
          )}
        </div>

        <div className="panel">
          <h2>Conversion funnel</h2>
          <FunnelChart funnel={overview.funnel} />
        </div>
      </div>

      <div className="panel">
        <h2>Won deals vs Stripe</h2>
        {!overview.reconciliation.configured ? (
          <p className="muted" style={{ margin: 0 }}>
            Stripe isn&apos;t connected — nothing to reconcile against yet. This never blocks recording a
            deal as Won.
          </p>
        ) : overview.reconciliation.deals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No Won deals recorded yet.
          </p>
        ) : (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              Matched by amount — up to 7 days before a deal was recorded Won (paid before Bob logged it) to
              60 days after (slower payment terms). A strong signal, not a guaranteed link — nothing ties a
              hand-created Stripe charge back to a specific deal.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Call</th>
                    <th>Expected</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.reconciliation.deals.map((d) => (
                    <tr key={d.callId}>
                      <td>
                        <a href={`/calls/${d.callId}`}>#{d.callId}</a>
                      </td>
                      <td>{formatMoney(d.expectedAud)}</td>
                      <td>
                        {d.matched ? (
                          <span className="badge good">
                            Matched — {formatMoney(d.matched.amount)} on{" "}
                            {new Date(d.matched.createdAt).toLocaleDateString("en-AU")}
                          </span>
                        ) : (
                          <span className="badge warn">Not seen in Stripe yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {overview.reconciliation.unmatchedPayments.length > 0 && (
              <>
                <p className="small muted" style={{ marginTop: 14, marginBottom: 6 }}>
                  Stripe payments that didn&apos;t match any recorded deal amount — could be a retainer
                  renewal or something outside this list, worth a glance:
                </p>
                <ul className="tight small">
                  {overview.reconciliation.unmatchedPayments.map((p) => (
                    <li key={p.id}>
                      {formatMoney(p.amount)} {p.currency} on {new Date(p.createdAt).toLocaleDateString("en-AU")}
                      {p.description && <> — {p.description}</>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
