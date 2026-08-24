/**
 * "Launch demo" — opens ElevenLabs' own agent editor (Bob's already logged
 * in there; its browser test-call widget lives inside the editor) for the
 * agent auto-built for this booked meeting.
 *
 * Also offers making it phone-callable: repoints the shared cold-calling
 * number's inbound routing at this demo agent (Bob's explicit choice, to
 * avoid paying for a dedicated demo number). While claimed, a real prospect
 * calling that number back also reaches the demo agent instead of Jacob —
 * the warning below says so plainly, every time, not just on first use.
 */

import { launchDemoUrl, type DemoAgentRow, type PhoneClaim } from "@/lib/demo-agent";

export function DemoAgentPanel({
  callId,
  demoAgent,
  phoneClaim,
  phoneNumberDisplay,
}: {
  callId: number;
  demoAgent: DemoAgentRow | null;
  phoneClaim: PhoneClaim | null;
  /** Formatted, e.g. "(04) 80 846 881" — null if the number isn't configured. */
  phoneNumberDisplay: string | null;
}) {
  const numberLabel = phoneNumberDisplay ?? "your cold-calling number";
  const claimedByThis = phoneClaim?.callId === callId;

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
              href={launchDemoUrl(demoAgent.elevenlabs_agent_id, demoAgent.branch_id)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ fontWeight: 600 }}
            >
              Launch demo →
            </a>
          </p>
          <p className="small muted" style={{ marginBottom: 12 }}>
            Opens the agent in ElevenLabs — use its test-call widget there. Torn down automatically once you
            record Won or Lost below.
          </p>

          {claimedByThis ? (
            <div className="notice warn">
              <strong>{numberLabel} is currently pointed at this demo.</strong> A real prospect calling that
              number back will also reach this demo agent right now, not Jacob — it auto-reverts to Jacob after 2
              hours if you forget.
              <form action={`/api/calls/${callId}/demo-agent/release-phone`} method="post" style={{ marginTop: 10 }}>
                <button className="secondary" type="submit">
                  Return number to Jacob now
                </button>
              </form>
            </div>
          ) : (
            <>
              {phoneClaim && (
                <p className="small muted" style={{ marginTop: 0 }}>
                  {numberLabel} is currently pointed at a different demo — claiming it below switches it to this
                  one instead.
                </p>
              )}
              <form action={`/api/calls/${callId}/demo-agent/claim-phone`} method="post">
                <button className="secondary" type="submit">
                  Make {numberLabel} call this demo
                </button>
              </form>
              <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
                Lets you or the client actually dial in, not just the browser widget. While claimed, real
                prospect callbacks reach the demo too, not Jacob — release it when you&apos;re done.
              </p>
            </>
          )}
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
