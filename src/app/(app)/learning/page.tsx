/**
 * Weekly auto-learning: this week's proposals, and the running history of
 * what's actually been pushed live — kept separate on purpose, so "what
 * changed on my sales agent over time" is answerable without hunting through
 * old weekly runs.
 */

import { pendingProposals, appliedHistory, latestRun, computeDiff } from "@/lib/learning";
import { formatSydney } from "@/lib/calling-hours";
import { featureStatus } from "@/lib/env";
import { ProposalCard } from "@/components/ProposalCard";
import { DiffView } from "@/components/DiffView";

export const dynamic = "force-dynamic";

export default function LearningPage() {
  const proposals = pendingProposals();
  const applied = appliedHistory();
  const run = latestRun();
  const features = featureStatus();

  return (
    <>
      <h1>Weekly learning</h1>
      <p className="sub">
        What the past week's data suggests changing — script wording, pricing, lead targeting — and what&apos;s
        already been pushed live over time.
      </p>

      {!features.summaries && (
        <div className="notice warn">
          No <code>ANTHROPIC_API_KEY</code> set, so the weekly run can&apos;t synthesise proposals.
        </div>
      )}

      <div className="panel">
        <h2>This week</h2>
        {!run ? (
          <p className="muted" style={{ margin: 0 }}>
            The weekly job hasn&apos;t run yet — it fires automatically Monday 6am Sydney time, or run it now.
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: 0 }}>
            Last run: {formatSydney(run.week_start)} – {formatSydney(run.week_end)} · status: {run.status}
            {run.status === "failed" && run.error && ` — ${run.error}`}
          </p>
        )}
        <form action="/api/learning/run" method="post" style={{ marginTop: 10 }}>
          <button type="submit">Run now</button>
        </form>
      </div>

      <h2 style={{ marginTop: 24 }}>Pending proposals</h2>
      {proposals.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Nothing pending. Either the job hasn&apos;t run yet, or the data didn&apos;t support any changes this
            week — a quiet week with no proposals is a correct answer, not a failure.
          </p>
        </div>
      ) : (
        proposals.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}

      <h2 style={{ marginTop: 24 }}>Applied to the live script — history</h2>
      {applied.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Nothing applied yet.
          </p>
        </div>
      ) : (
        applied.map((p) => (
          <div className="panel" key={p.id}>
            <h3 style={{ marginBottom: 4 }}>{p.title}</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              Applied {p.applied_at ? formatSydney(p.applied_at) : "unknown time"}
              {p.reverted_at && ` · reverted ${formatSydney(p.reverted_at)}`}
            </p>
            {!p.reverted_at && p.previous_prompt_text && p.new_prompt_text && (
              <details style={{ marginBottom: 10 }}>
                <summary>Show the change</summary>
                <DiffView lines={computeDiff(p.previous_prompt_text, p.new_prompt_text)} />
              </details>
            )}
            {!p.reverted_at ? (
              <form action={`/api/learning/${p.id}/revert`} method="post">
                <button className="danger" type="submit">
                  Revert
                </button>
              </form>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Reverted — the prompt was restored to exactly what it was before this change.
              </p>
            )}
          </div>
        ))
      )}
    </>
  );
}
