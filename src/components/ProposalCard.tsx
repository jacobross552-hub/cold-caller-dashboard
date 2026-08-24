import { computeDiff, type LearningProposalRow } from "@/lib/learning";
import { DiffView } from "./DiffView";

const CATEGORY_LABELS: Record<string, string> = {
  script: "Script wording",
  pricing: "Pricing table",
  lead_targeting: "Lead targeting",
  other: "Other",
};

export function ProposalCard({ proposal }: { proposal: LearningProposalRow }) {
  const isScript = proposal.category === "script";

  return (
    <div className="panel">
      <p className="small muted" style={{ marginTop: 0, marginBottom: 4 }}>
        {CATEGORY_LABELS[proposal.category] ?? proposal.category}
      </p>
      <h2 style={{ marginBottom: 6 }}>{proposal.title}</h2>
      <p style={{ marginTop: 0 }}>{proposal.reasoning}</p>
      <p className="small muted">
        Confidence: {proposal.confidence}
        {proposal.sample_size !== null && ` · N=${proposal.sample_size}`}
      </p>

      {isScript && proposal.previous_prompt_text && proposal.new_prompt_text && (
        <>
          <h3>Exact change</h3>
          <DiffView lines={computeDiff(proposal.previous_prompt_text, proposal.new_prompt_text)} />
        </>
      )}

      {!isScript && (
        <p className="small muted">
          Advisory only — accepting marks this acknowledged. It doesn&apos;t change anything automatically; make
          the edit yourself where this kind of change actually lives (e.g. <code>pricing.ts</code> for a pricing
          change).
        </p>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <form action={`/api/learning/${proposal.id}/accept`} method="post">
          <button type="submit">{isScript ? "Accept — push live now" : "Accept"}</button>
        </form>
        <form action={`/api/learning/${proposal.id}/reject`} method="post" className="row" style={{ flex: 1 }}>
          <input type="text" name="reason" placeholder="Reason for rejecting (required)" style={{ flex: 1 }} />
          <button className="secondary" type="submit">
            Reject
          </button>
        </form>
      </div>
    </div>
  );
}
