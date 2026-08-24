/**
 * Recording and displaying what actually happened on a booked meeting: Won or
 * Lost, and on Won, the price actually agreed (not the recommendation).
 *
 * No client JS — both the Won and Lost field groups render together and the
 * server validates against whichever `status` radio was submitted. Matches
 * the rest of this app's zero-client-component convention.
 */

import { LOST_REASONS, type DealRow } from "@/lib/deals";
import { formatMoney, type PriceBand } from "@/lib/pricing";

export function DealBadge({ deal }: { deal: DealRow | null }) {
  if (!deal) return <span className="badge">Outcome pending</span>;
  if (deal.status === "won") return <span className="badge good">Won</span>;
  return <span className="badge bad">Lost — {LOST_REASONS[deal.lost_reason ?? "other"]}</span>;
}

export function DealOutcome({
  callId,
  deal,
  recommended,
}: {
  callId: number;
  deal: DealRow | null;
  /** The band src/lib/pricing.ts recommends for this call's weekly figure, if known. */
  recommended: PriceBand | null;
}) {
  return (
    <div className="panel">
      <h2>Demo outcome</h2>

      {deal && (
        <div className={`notice ${deal.status === "won" ? "ok" : "bad"}`}>
          {deal.status === "won" ? (
            <>
              <strong>Won.</strong> {formatMoney(deal.agreed_setup_fee ?? 0)} setup,{" "}
              {formatMoney(deal.agreed_monthly_retainer ?? 0)}/mo agreed.
            </>
          ) : (
            <>
              <strong>Lost.</strong> {LOST_REASONS[deal.lost_reason ?? "other"]}
              {deal.lost_notes && <> — &ldquo;{deal.lost_notes}&rdquo;</>}
            </>
          )}{" "}
          <span className="small muted">Recorded — change it below if this needs correcting.</span>
        </div>
      )}

      {recommended && !deal && (
        <p className="small muted" style={{ marginTop: 0 }}>
          The recommendation for this call was {formatMoney(recommended.setupFee)} setup,{" "}
          {formatMoney(recommended.monthlyRetainer)}/mo. What was actually agreed is expected to
          differ — record what really happened.
        </p>
      )}

      <form action={`/api/calls/${callId}/outcome`} method="post">
        <div className="row" style={{ marginBottom: 14 }}>
          <label style={{ marginBottom: 0 }}>
            <input
              type="radio"
              name="status"
              value="won"
              defaultChecked={deal?.status === "won"}
              style={{ width: "auto", marginRight: 6 }}
              required
            />
            Won
          </label>
          <label style={{ marginBottom: 0 }}>
            <input
              type="radio"
              name="status"
              value="lost"
              defaultChecked={deal?.status === "lost"}
              style={{ width: "auto", marginRight: 6 }}
            />
            Lost
          </label>
        </div>

        <div className="grid2">
          <div>
            <h3>If won</h3>
            <label htmlFor="setup_fee">Actual setup fee agreed ($)</label>
            <input
              id="setup_fee"
              type="number"
              name="setup_fee"
              min="0"
              step="1"
              placeholder={recommended ? String(recommended.setupFee) : "e.g. 2200"}
              defaultValue={deal?.agreed_setup_fee ?? undefined}
            />
            <label htmlFor="retainer">Actual monthly retainer agreed ($)</label>
            <input
              id="retainer"
              type="number"
              name="retainer"
              min="0"
              step="1"
              placeholder={recommended ? String(recommended.monthlyRetainer) : "e.g. 800"}
              defaultValue={deal?.agreed_monthly_retainer ?? undefined}
            />
          </div>

          <div>
            <h3>If lost</h3>
            <label htmlFor="lost_reason">Reason</label>
            <select
              id="lost_reason"
              name="lost_reason"
              defaultValue={deal?.lost_reason ?? ""}
              style={{
                width: "100%",
                padding: "9px 11px",
                border: "1px solid var(--line)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--ink)",
                font: "inherit",
                marginBottom: 12,
              }}
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {Object.entries(LOST_REASONS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="notes">Notes (required if &ldquo;Other&rdquo;)</label>
            <textarea
              id="notes"
              name="notes"
              style={{ minHeight: 78 }}
              defaultValue={deal?.lost_notes ?? ""}
            />
          </div>
        </div>

        <button type="submit">{deal ? "Update outcome" : "Record outcome"}</button>
      </form>
    </div>
  );
}
