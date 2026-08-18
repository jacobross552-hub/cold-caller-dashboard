import Link from "next/link";
import { notFound } from "next/navigation";
import { getCall, parseAnalysis } from "@/lib/calls";
import { formatSydney } from "@/lib/calling-hours";
import { formatAuPhone } from "@/lib/phone";
import { OUTCOME_EXPLANATIONS, OUTCOME_LABELS, spokenTurns, type Outcome } from "@/lib/outcomes";
import { Brief } from "@/components/Brief";
import { LeadFacts } from "@/components/LeadFacts";
import { getLead } from "@/lib/leads";

export const dynamic = "force-dynamic";

export default async function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const call = getCall(Number(id));
  if (!call) notFound();

  const brief = parseAnalysis(call);
  const outcome = (call.outcome ?? "connected") as Outcome;
  const turns = spokenTurns(call.transcript_json ? JSON.parse(call.transcript_json) : []);

  return (
    <>
      <p className="small">
        <Link href="/calls">← Back to the call log</Link>
      </p>

      <h1>{call.business_name ?? "Unknown business"}</h1>
      <p className="sub">
        {call.phone ? formatAuPhone(call.phone) : "number unknown"} ·{" "}
        {call.started_at ? formatSydney(call.started_at) : "time unknown"}
        {call.duration_secs != null && ` · ${call.duration_secs} seconds`}
      </p>

      {call.booked === 1 && (
        <div className="notice ok">
          <strong>Meeting booked on this call.</strong> The briefing below is what to read before you dial
          them.
        </div>
      )}

      <div className="panel">
        <h2>What happened</h2>
        <p style={{ marginTop: 0 }}>
          <span className="badge">{OUTCOME_LABELS[outcome] ?? outcome}</span>{" "}
          <span className="small muted">{OUTCOME_EXPLANATIONS[outcome]}</span>
        </p>
        {call.summary ? (
          <p style={{ marginBottom: 0 }}>{call.summary}</p>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            No plain-English summary yet.
          </p>
        )}
        {call.analysis_error && (
          <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
            {call.analysis_error}
            <form action={`/api/calls/${call.id}/analyse`} method="post" style={{ marginTop: 10 }}>
              <button type="submit">Try again</button>
            </form>
          </div>
        )}
      </div>

      <LeadFacts lead={getLead(call.lead_id)} />

      {brief ? (
        <div className="panel">
          <h2>Pre-call briefing</h2>
          <Brief brief={brief} />
          <form action={`/api/calls/${call.id}/analyse`} method="post" style={{ marginTop: 16 }}>
            <button className="secondary" type="submit">
              Regenerate
            </button>
          </form>
        </div>
      ) : (
        !call.analysis_error && (
          <div className="panel">
            <h2>Pre-call briefing</h2>
            <p className="muted">
              Nothing to brief on — this call had no real conversation.
            </p>
          </div>
        )
      )}

      <div className="panel">
        <h2>Full transcript</h2>
        {turns.length === 0 ? (
          <p className="muted">Nothing was said on this call.</p>
        ) : (
          <div className="transcript">
            {turns.map((turn, index) => (
              <div key={index} className={`turn ${turn.role === "agent" ? "agent" : ""}`}>
                <div className="who">{turn.role === "agent" ? "Jacob" : "Prospect"}</div>
                <div>{turn.message}</div>
              </div>
            ))}
          </div>
        )}
        {call.termination_reason && (
          <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
            Call ended: {call.termination_reason}
            {call.cost != null && ` · cost ${call.cost}`}
          </p>
        )}
      </div>
    </>
  );
}
