/**
 * "Launch demo" — opens ElevenLabs' own agent editor (Bob's already logged
 * in there; its browser test-call widget lives inside the editor) for the
 * agent auto-built for this booked meeting.
 */

import { launchDemoUrl, type DemoAgentRow } from "@/lib/demo-agent";

export function DemoAgentPanel({ callId, demoAgent }: { callId: number; demoAgent: DemoAgentRow | null }) {
  return (
    <div className="panel">
      <h2>Demo agent</h2>

      {!demoAgent && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            No demo agent built for this meeting yet.
          </p>
          <form action={`/api/calls/${callId}/demo-agent`} method="post">
            <button type="submit">Build now</button>
          </form>
        </>
      )}

      {demoAgent?.status === "provisioning" && (
        <p className="muted" style={{ margin: 0 }}>
          Researching the business and building the agent — this usually finishes well before a scheduled
          demo. Reload the page to check.
        </p>
      )}

      {demoAgent?.status === "ready" && demoAgent.elevenlabs_agent_id && (
        <>
          <p style={{ marginTop: 0 }}>
            <a
              href={launchDemoUrl(demoAgent.elevenlabs_agent_id)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ fontWeight: 600 }}
            >
              Launch demo →
            </a>
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Opens the agent in ElevenLabs — use its test-call widget there. Torn down automatically once you
            record Won or Lost below.
          </p>
        </>
      )}

      {demoAgent?.status === "failed" && (
        <>
          <div className="notice bad" style={{ marginBottom: 12 }}>
            Couldn&apos;t build the demo agent: {demoAgent.error ?? "unknown error"}
          </div>
          <form action={`/api/calls/${callId}/demo-agent`} method="post">
            <button className="secondary" type="submit">
              Retry
            </button>
          </form>
        </>
      )}

      {demoAgent?.status === "torn_down" && (
        <p className="muted small" style={{ margin: 0 }}>
          Demo agent torn down — outcome already recorded as {demoAgent.teardown_reason ?? "closed"}.
        </p>
      )}
    </div>
  );
}
