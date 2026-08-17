import Link from "next/link";
import { callStats, listCalls, parseAnalysis } from "@/lib/calls";
import { formatSydney } from "@/lib/calling-hours";
import { formatAuPhone } from "@/lib/phone";
import { OUTCOME_LABELS, type Outcome } from "@/lib/outcomes";
import { STAGE_LABELS } from "@/lib/brief";

export const dynamic = "force-dynamic";

const OUTCOME_BADGE: Record<Outcome, string> = {
  completed: "good",
  connected: "good",
  hung_up_early: "warn",
  voicemail: "",
  no_answer: "",
  failed: "bad",
};

export default async function CallsPage() {
  const calls = listCalls();
  const stats = callStats();

  return (
    <>
      <h1>Call log</h1>
      <p className="sub">Every call, what happened, and what was said. Click a row for the detail.</p>

      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="n">{stats.total}</div>
          <div className="l">Calls</div>
        </div>
        <div className="stat">
          <div className="n">
            {(stats.byOutcome.completed ?? 0) + (stats.byOutcome.connected ?? 0)}
          </div>
          <div className="l">Real conversations</div>
        </div>
        <div className="stat">
          <div className="n">{stats.byOutcome.voicemail ?? 0}</div>
          <div className="l">Voicemail</div>
        </div>
        <div className="stat">
          <div className="n">{stats.booked}</div>
          <div className="l">Booked</div>
        </div>
      </div>

      <div className="panel">
        {calls.length === 0 ? (
          <p className="muted">
            No calls yet. They appear here automatically once ElevenLabs sends the post-call webhook.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>When</th>
                  <th>What happened</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => {
                  const brief = parseAnalysis(call);
                  const outcome = (call.outcome ?? "connected") as Outcome;
                  return (
                    <tr key={call.id}>
                      <td>
                        <Link href={`/calls/${call.id}`}>
                          <strong>{call.business_name ?? "Unknown business"}</strong>
                        </Link>
                        {call.phone && <div className="small muted">{formatAuPhone(call.phone)}</div>}
                        {call.booked === 1 && (
                          <div style={{ marginTop: 4 }}>
                            <span className="badge good">Meeting booked</span>
                          </div>
                        )}
                      </td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>
                        {call.started_at ? formatSydney(call.started_at) : "—"}
                        <div>{call.duration_secs != null ? `${call.duration_secs}s` : ""}</div>
                      </td>
                      <td>
                        <span className={`badge ${OUTCOME_BADGE[outcome] ?? ""}`}>
                          {OUTCOME_LABELS[outcome] ?? outcome}
                        </span>
                        {brief && (
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {STAGE_LABELS[brief.analysis.furthest_stage]}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {call.summary ?? (
                          <span className="muted">
                            {call.analysis_error ? "No summary — see the call for why." : "Summarising…"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
