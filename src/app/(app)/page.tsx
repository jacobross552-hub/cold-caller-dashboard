/**
 * The calling page — start a run, see the guard's current state.
 */

import Link from "next/link";
import { checkCallingWindow, formatSydney, holidayDataStale, COVERED_THROUGH } from "@/lib/calling-hours";
import { activeRun, dispatchedToday, listRuns, runProgress } from "@/lib/dispatcher";
import { leadCounts } from "@/lib/leads";
import { callStats } from "@/lib/calls";
import { recentEvents } from "@/lib/db";
import { config, featureStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function CallingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const window = checkCallingWindow();
  const run = activeRun();
  const progress = run ? runProgress(run.id) : null;
  const leads = leadCounts();
  const stats = callStats();
  const today = dispatchedToday();
  const features = featureStatus();
  const events = recentEvents(15);
  const runs = listRuns(8);

  return (
    <>
      <h1>Calling</h1>
      <p className="sub">Queue a batch of calls. They go out only inside legal calling hours.</p>

      {params.error && <div className="notice bad">{params.error}</div>}
      {params.started && (
        <div className="notice ok">
          Run queued. {window.allowed ? "Dialling now." : "It will start automatically when calling hours open."}
        </div>
      )}
      {params.cancelled && <div className="notice ok">Run cancelled.</div>}
      {params.tick && <div className="notice ok">Checked: {params.tick}</div>}

      {/* ---- The calling-hours guard, always visible ---- */}
      <div className={`notice ${window.overridden ? "bad" : window.allowed ? "ok" : "warn"}`}>
        <strong>{window.allowed ? "Calling hours: open" : "Calling hours: closed"}</strong>
        <br />
        {window.reason}
        {!window.allowed && window.nextOpen && (
          <>
            <br />
            Next window opens <strong>{formatSydney(window.nextOpen)}</strong> — anything queued now waits until then.
          </>
        )}
        {window.allowed && window.closesAt && (
          <>
            <br />
            Closes {formatSydney(window.closesAt)}. A run still going then pauses and resumes the next morning.
          </>
        )}
      </div>

      {holidayDataStale() && (
        <div className="notice warn">
          The NSW public-holiday list only runs to {COVERED_THROUGH}. Add the next year&apos;s dates to{" "}
          <code>src/lib/holidays.ts</code> so holidays keep being blocked.
        </div>
      )}

      {!features.calling && (
        <div className="notice warn">
          ElevenLabs isn&apos;t configured yet, so calls can&apos;t go out. Add{" "}
          <code>ELEVENLABS_API_KEY</code>, <code>ELEVENLABS_AGENT_ID</code> and{" "}
          <code>ELEVENLABS_PHONE_NUMBER_ID</code> to your <code>.env</code>.
        </div>
      )}
      {!features.webhook && (
        <div className="notice warn">
          No <code>ELEVENLABS_WEBHOOK_SECRET</code> set — calls will go out but nothing will come back
          into the call log.
        </div>
      )}

      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="n">{leads.callable}</div>
          <div className="l">Leads ready to call</div>
        </div>
        <div className="stat">
          <div className="n">
            {today}/{config.maxCallsPerDay}
          </div>
          <div className="l">Called today</div>
        </div>
        <div className="stat">
          <div className="n">{stats.total}</div>
          <div className="l">Calls all time</div>
        </div>
        <div className="stat">
          <div className="n">{stats.booked}</div>
          <div className="l">Meetings booked</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Start calling</h2>
          {run ? (
            <>
              <p className="small">
                <strong>{run.name}</strong> is {run.status === "dispatching" ? "running" : "queued"}.
              </p>
              <dl className="kv" style={{ marginBottom: 14 }}>
                <dt>Progress</dt>
                <dd>
                  {progress!.done + progress!.dispatched} of {progress!.total} dialled
                </dd>
                <dt>Waiting</dt>
                <dd>{progress!.pending}</dd>
                {run.hold_reason && (
                  <>
                    <dt>Held because</dt>
                    <dd style={{ fontWeight: 400 }}>{run.hold_reason}</dd>
                  </>
                )}
                {run.next_window_at && (
                  <>
                    <dt>Resumes</dt>
                    <dd>{formatSydney(run.next_window_at)}</dd>
                  </>
                )}
              </dl>
              <div className="row">
                <form action={`/api/runs/${run.id}/cancel`} method="post">
                  <button className="danger" type="submit">
                    Cancel this run
                  </button>
                </form>
                <form action="/api/tick" method="post">
                  <button className="secondary" type="submit">
                    Check now
                  </button>
                </form>
              </div>
            </>
          ) : (
            <form action="/api/runs" method="post">
              <label htmlFor="count">How many calls?</label>
              <input
                id="count"
                name="count"
                type="number"
                min={1}
                max={leads.callable || 1}
                defaultValue={Math.min(10, leads.callable || 1)}
                required
              />
              <label htmlFor="name">Name this run (optional)</label>
              <input id="name" name="name" type="text" placeholder="e.g. Newcastle sparkies" />
              <button type="submit" disabled={leads.callable === 0}>
                {window.allowed ? "Start calling" : "Queue for next window"}
              </button>
              {leads.callable === 0 && (
                <p className="small muted" style={{ marginTop: 10 }}>
                  No leads ready. <Link href="/leads">Import some first.</Link>
                </p>
              )}
            </form>
          )}
        </div>

        <div className="panel">
          <h2>What&apos;s been happening</h2>
          {events.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul className="tight small">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="muted">{formatSydney(event.ts)}</span> — {event.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {runs.length > 0 && (
        <div className="panel">
          <h2>Past runs</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Started</th>
                  <th>Calls</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((item) => {
                  const itemProgress = runProgress(item.id);
                  return (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td className="muted">
                        {item.started_at ? formatSydney(item.started_at) : "not started"}
                      </td>
                      <td>
                        {itemProgress.done + itemProgress.dispatched}/{itemProgress.total}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            item.status === "completed"
                              ? "good"
                              : item.status === "failed"
                                ? "bad"
                                : item.status === "cancelled"
                                  ? ""
                                  : "warn"
                          }`}
                        >
                          {item.status.replace(/_/g, " ")}
                        </span>
                        {item.error && <div className="small muted">{item.error}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
