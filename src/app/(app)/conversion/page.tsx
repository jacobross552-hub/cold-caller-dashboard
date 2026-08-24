/**
 * The conversion funnel: how many calls turn into meetings, and how many
 * meetings turn into sales.
 *
 * Every percentage here is shown with the raw count behind it — a rate on its
 * own hides whether it's built on 3 calls or 3,000. A stage with nothing to
 * divide by yet says so plainly rather than rendering as 0%.
 */

import Link from "next/link";
import { conversionFunnel, pct } from "@/lib/funnel";
import { LOST_REASONS, type LostReason } from "@/lib/deals";
import { formatMoney } from "@/lib/pricing";

export const dynamic = "force-dynamic";

function Stage({
  label,
  n,
  ofLabel,
  rate = null,
}: {
  label: string;
  n: number;
  ofLabel?: string;
  rate?: number | null;
}) {
  return (
    <div className="stat">
      <div className="n">{n.toLocaleString()}</div>
      <div className="l">
        {label}
        {ofLabel && (
          <>
            <br />
            {rate === null ? (
              <span className="muted">not enough data yet</span>
            ) : (
              <>
                {rate}% of {ofLabel}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default async function ConversionPage() {
  const funnel = conversionFunnel();
  const { dialled, answered, booked, deals } = funnel;

  if (dialled === 0) {
    return (
      <>
        <h1>Conversion</h1>
        <p className="sub">Answered → booked → bought, with the counts behind every rate.</p>
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            No calls yet. This fills in once dialling starts.
          </p>
        </div>
      </>
    );
  }

  const answeredRate = pct(answered, dialled);
  const bookedRate = pct(booked, answered);
  const wonRate = pct(deals.won, booked);

  const lostReasonEntries = Object.entries(deals.lostByReason) as Array<[LostReason, number]>;

  return (
    <>
      <h1>Conversion</h1>
      <p className="sub">Answered → booked → bought, with the counts behind every rate.</p>

      <div className="stats" style={{ marginBottom: 18 }}>
        <Stage label="Dialled" n={dialled} />
        <Stage label="Answered" n={answered} ofLabel="dialled" rate={answeredRate} />
        <Stage label="Booked" n={booked} ofLabel="answered" rate={bookedRate} />
        <Stage label="Won" n={deals.won} ofLabel="booked" rate={wonRate} />
      </div>

      <div className="panel">
        <h2>Booked meetings, broken down</h2>
        <dl className="kv">
          <dt>Won</dt>
          <dd>{deals.won}</dd>
          <dt>Lost</dt>
          <dd>{deals.lost}</dd>
          <dt>Outcome not recorded yet</dt>
          <dd className={deals.pending > 0 ? undefined : "muted"} style={deals.pending > 0 ? { fontWeight: 600 } : { fontWeight: 400 }}>
            {deals.pending}
          </dd>
        </dl>
        {deals.pending > 0 && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            {deals.pending} booked {deals.pending === 1 ? "meeting has" : "meetings have"} no Won/Lost
            recorded — the Won rate above only counts what&apos;s been recorded, not what&apos;s still
            pending. <Link href="/meetings">Go record it</Link>.
          </p>
        )}
        {deals.won > 0 && (
          <p className="small muted" style={{ marginTop: deals.pending > 0 ? 8 : 0, marginBottom: 0 }}>
            Revenue booked from won deals: {formatMoney(deals.wonRevenue.setupFees)} in setup fees,{" "}
            {formatMoney(deals.wonRevenue.monthlyRetainers)}/mo in retainers.
          </p>
        )}
      </div>

      {lostReasonEntries.length > 0 && (
        <div className="panel">
          <h2>Why deals were lost</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {lostReasonEntries
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{LOST_REASONS[reason]}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
