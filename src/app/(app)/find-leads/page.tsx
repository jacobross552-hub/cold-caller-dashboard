/**
 * Find Leads — pick verticals and suburbs, say how many, press Go.
 *
 * Server-rendered like every other page in this dashboard, with no client-side
 * JavaScript. While a run is going the page asks the browser to refresh itself
 * every few seconds, which is enough to watch the counters move without
 * introducing the app's first client component.
 */

import Link from "next/link";
import { formatSydney } from "@/lib/calling-hours";
import { config, featureStatus } from "@/lib/env";
import { VERTICALS, type Tier } from "@/lib/lead-finder/icp";
import { estimateRunCost, formatAud, FREE_CALLS_PER_MONTH_ENTERPRISE } from "@/lib/lead-finder/cost";
import {
  activeLeadRun,
  leadRunSummary,
  listLeadRuns,
  type LeadRunStatus,
} from "@/lib/lead-finder/runs";
import { suppressionCount } from "@/lib/suppression";

export const dynamic = "force-dynamic";

const TIER_HEADINGS: Array<{ tier: Tier; heading: string; note: string }> = [
  { tier: 1, heading: "Tier 1 — best fit", note: "Emergency trades. Highest missed-call rates, biggest jobs." },
  { tier: 2, heading: "Tier 2 — strong fit", note: "High value per lead, reception usually stretched." },
  { tier: 3, heading: "Tier 3 — good fit", note: "High call volume, appointment-driven, smaller jobs." },
];

const STATUS_BADGE: Record<LeadRunStatus, string> = {
  queued: "warn",
  running: "warn",
  completed: "good",
  partial: "warn",
  failed: "bad",
  cancelled: "",
};

/** Sample sizes for the cost table. No client JS, so this beats a live field. */
const SAMPLE_COUNTS = [10, 25, 50, 100];

export default async function FindLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const features = featureStatus();
  const active = activeLeadRun();
  const summary = active ? leadRunSummary(active.id) : null;
  const history = listLeadRuns(15);
  const suppressed = suppressionCount();

  const isWorking = active?.status === "queued" || active?.status === "running";

  return (
    <>
      {/* Only while something is actually moving — a finished page stays still. */}
      {isWorking && <meta httpEquiv="refresh" content="4" />}

      <h1>Find leads</h1>
      <p className="sub">
        Searches Google&apos;s business listings for the trades most likely to be missing calls,
        scores each one, and drops the good ones straight onto your leads list.
      </p>

      {params.error && <div className="notice bad">{params.error}</div>}
      {params.started && (
        <div className="notice ok">Run started. Progress appears below and updates on its own.</div>
      )}
      {params.cancelled && <div className="notice ok">Run cancelled.</div>}

      {!features.leadFinder && (
        <div className="notice warn">
          <strong>Switched off.</strong> Add <code>GOOGLE_PLACES_API_KEY</code> to your{" "}
          <code>.env</code> and restart. You need a Google Cloud project with{" "}
          <strong>Places API (New)</strong> enabled and billing switched on — the free allowance is{" "}
          {FREE_CALLS_PER_MONTH_ENTERPRISE.toLocaleString()} searches a month, which is far more
          than this dashboard will use.
        </div>
      )}

      {features.leadFinder && !features.abnCheck && (
        <div className="notice warn">
          No <code>ABN_LOOKUP_GUID</code> set, so businesses can&apos;t be checked against the
          Australian Business Register. It still works — but mobile numbers will only be imported
          when a website or business category backs them up, so you&apos;ll find fewer sole traders.
          The GUID is free from{" "}
          <a href="https://abr.business.gov.au/Tools/WebServices">abr.business.gov.au</a>.
        </div>
      )}

      {/* Decision made 17 Aug 2026: ship with the warning, fix the table later. */}
      <div className="notice warn">
        <strong>Public holidays are checked against NSW only.</strong> Leads are dialled in their
        own state&apos;s time, but the holiday list is NSW&apos;s. A Victorian lead would be blocked
        on a NSW-only holiday and <em>allowed</em> on a Victorian-only one such as Melbourne Cup
        Day. Fine for a NSW list — worth knowing before you source interstate at volume.
      </div>

      {/* ---- Live progress ---- */}
      {active && summary && (
        <div className="panel">
          <h2>Run #{active.id} — {active.status === "queued" ? "starting" : "in progress"}</h2>
          <p className="small muted">{active.stage}</p>

          <div className="stats" style={{ marginBottom: 14 }}>
            <div className="stat">
              <div className="n">
                {active.leads_found}/{active.target_count}
              </div>
              <div className="l">Leads found</div>
            </div>
            <div className="stat">
              <div className="n">{active.candidates_seen}</div>
              <div className="l">Businesses examined</div>
            </div>
            <div className="stat">
              <div className="n">{summary.apiCalls}</div>
              <div className="l">API calls</div>
            </div>
            <div className="stat">
              <div className="n">{formatAud(summary.costAud)}</div>
              <div className="l">Spent so far</div>
            </div>
          </div>

          <dl className="kv" style={{ marginBottom: 14 }}>
            <dt>Skipped</dt>
            <dd style={{ fontWeight: 400 }}>
              {active.duplicates_skipped} already on your list, {active.suppressed_skipped} on the
              do-not-contact list, {active.rejected_skipped} failed the quality filter
            </dd>
            <dt>Budget</dt>
            <dd style={{ fontWeight: 400 }}>
              {formatAud(summary.costAud)} of {formatAud(config.maxCostPerRunAud)} cap
            </dd>
          </dl>

          <form action={`/api/lead-runs/${active.id}/cancel`} method="post">
            <button className="danger" type="submit">
              Stop this run
            </button>
          </form>
        </div>
      )}

      {/* ---- The form ---- */}
      {!isWorking && (
        <form action="/api/lead-runs" method="post">
          <div className="grid2">
            <div className="panel">
              <h2>What to look for</h2>
              {TIER_HEADINGS.map(({ tier, heading, note }) => (
                <div key={String(tier)} style={{ marginBottom: 14 }}>
                  <h3>{heading}</h3>
                  <p className="small muted" style={{ margin: "0 0 6px" }}>
                    {note}
                  </p>
                  {VERTICALS.filter((v) => v.tier === tier).map((vertical) => (
                    <label
                      key={vertical.id}
                      style={{ fontWeight: 400, display: "flex", gap: 8, marginBottom: 4 }}
                    >
                      <input
                        type="checkbox"
                        name="verticals"
                        value={vertical.id}
                        defaultChecked={tier === 1}
                      />
                      {vertical.label}
                    </label>
                  ))}
                </div>
              ))}

              <label htmlFor="customVerticals">Anything else (comma separated)</label>
              <input
                id="customVerticals"
                name="customVerticals"
                type="text"
                placeholder="e.g. mobile mechanic, tree lopper"
              />
              <p className="small muted">
                Free-typed trades are searched exactly as written and scored a little lower, since
                they&apos;re outside the researched target list.
              </p>
            </div>

            <div className="panel">
              <h2>Where, and how many</h2>

              <label htmlFor="locations">Suburbs, postcodes or regions</label>
              <textarea
                id="locations"
                name="locations"
                style={{ minHeight: 90 }}
                placeholder={"Parramatta NSW\nNewcastle NSW\nWollongong NSW"}
                required
              />
              <p className="small muted">
                One per line, or separated by commas. <strong>Include the state</strong> — it sets
                the timezone each lead is dialled in.
              </p>

              <label htmlFor="targetCount">How many leads?</label>
              <input
                id="targetCount"
                name="targetCount"
                type="number"
                min={1}
                max={config.maxLeadsPerRun}
                defaultValue={25}
                required
              />

              <h3 style={{ marginTop: 16 }}>What it&apos;ll cost</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Leads</th>
                      <th>Estimated cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SAMPLE_COUNTS.map((count) => {
                      const estimate = estimateRunCost(count, config.usdAudRate);
                      return (
                        <tr key={count}>
                          <td>{count}</td>
                          <td>
                            {formatAud(estimate.lowAud)} – {formatAud(estimate.highAud)} AUD
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="small muted">
                Upper bound assumes a poor hit rate, so a real run usually lands at the low end.
                Google&apos;s first {FREE_CALLS_PER_MONTH_ENTERPRISE.toLocaleString()} searches each
                month are free, so in practice most runs cost nothing — the figures above are what
                you&apos;d pay past that. Converted at {config.usdAudRate} AUD per USD.
              </p>

              <label style={{ fontWeight: 400, display: "flex", gap: 8, marginTop: 10 }}>
                <input type="checkbox" name="overrideCostCap" />
                Spend past the {formatAud(config.maxCostPerRunAud)} cap if needed
              </label>

              <button type="submit" disabled={!features.leadFinder} style={{ marginTop: 14 }}>
                Go
              </button>
            </div>
          </div>
        </form>
      )}

      {/* ---- History ---- */}
      <div className="panel">
        <h2>Past runs</h2>
        {history.length === 0 ? (
          <p className="muted small">No runs yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Looking for</th>
                  <th>Found</th>
                  <th>Skipped</th>
                  <th>API calls</th>
                  <th>Cost</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((run) => {
                  const detail = leadRunSummary(run.id);
                  return (
                    <tr key={run.id}>
                      <td className="muted small">{formatSydney(run.created_at)}</td>
                      <td>
                        {detail?.verticals.join(", ")}
                        <div className="small muted">{detail?.locations.join(", ")}</div>
                      </td>
                      <td>
                        {run.leads_found}/{run.target_count}
                      </td>
                      <td className="small muted">
                        {run.duplicates_skipped} dupe, {run.suppressed_skipped} suppressed,{" "}
                        {run.rejected_skipped} filtered
                      </td>
                      <td>{detail?.apiCalls ?? 0}</td>
                      <td>{formatAud(detail?.costAud ?? 0)}</td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[run.status]}`}>{run.status}</span>
                        {run.error && <div className="small muted">{run.error}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="small muted" style={{ marginTop: 12 }}>
          Leads land on your <Link href="/leads">leads list</Link> with source &ldquo;AI lead
          finder&rdquo;, ready to call.{" "}
          {suppressed > 0 && (
            <>
              {suppressed} number{suppressed === 1 ? " is" : "s are"} on the permanent
              do-not-contact list and can never be re-imported.
            </>
          )}
        </p>
      </div>
    </>
  );
}
