/**
 * Booked meetings, each with its pre-call briefing.
 *
 * This is the page to open before a demo call.
 */

import Link from "next/link";
import { listBookedCalls, parseAnalysis } from "@/lib/calls";
import { formatSydney } from "@/lib/calling-hours";
import { formatAuPhone } from "@/lib/phone";
import { featureStatus } from "@/lib/env";
import { getLead } from "@/lib/leads";
import { findBookedEvent } from "@/lib/calendar-event";
import type { TranscriptTurn } from "@/lib/outcomes";
import { Brief } from "@/components/Brief";
import { LeadFacts } from "@/components/LeadFacts";
import { DealBadge } from "@/components/DealOutcome";
import { getDealsByCallIds } from "@/lib/deals";
import { getDemoAgentsByCallIds, launchDemoUrl } from "@/lib/demo-agent";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const booked = listBookedCalls();
  const features = featureStatus();
  const deals = getDealsByCallIds(booked.map((call) => call.id));
  const demoAgents = getDemoAgentsByCallIds(booked.map((call) => call.id));

  return (
    <>
      <h1>Meetings booked</h1>
      <p className="sub">
        Every call that ended with a demo in the calendar, and what to know before you walk into it.
      </p>

      {!features.smsAlerts && (
        <div className="notice warn">
          Twilio isn&apos;t configured, so you won&apos;t get a text when a meeting books — you&apos;ll
          only see it here. Add the <code>TWILIO_*</code> and <code>ALERT_TO_NUMBER</code> values to{" "}
          <code>.env</code>.
        </div>
      )}

      {booked.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            No meetings booked yet. A call lands here automatically when the agent uses the calendar
            tool.
          </p>
        </div>
      ) : (
        booked.map((call) => {
          const brief = parseAnalysis(call);
          const booking = brief?.analysis.booking;
          const lead = getLead(call.lead_id);
          const event = findBookedEvent(
            call.transcript_json ? (JSON.parse(call.transcript_json) as TranscriptTurn[]) : [],
          );

          return (
            <div className="panel" key={call.id}>
              <h2 style={{ marginBottom: 4 }}>
                {call.business_name ?? "Unknown business"}{" "}
                <span style={{ fontSize: 13 }}>
                  <DealBadge deal={deals.get(call.id) ?? null} />
                </span>
              </h2>
              <p className="small muted" style={{ marginTop: 0 }}>
                {booking?.day ? (
                  <>
                    <strong>
                      Demo: {booking.day}
                      {booking.time ? ` at ${booking.time}` : ""}
                    </strong>{" "}
                    ·{" "}
                  </>
                ) : (
                  <>Booked (check your calendar for the time) · </>
                )}
                {call.phone ? formatAuPhone(call.phone) : "number unknown"}
                {booking?.email && <> · {booking.email}</>} · called{" "}
                {call.started_at ? formatSydney(call.started_at) : "at an unknown time"}
              </p>

              {(() => {
                const demoAgent = demoAgents.get(call.id);
                if (demoAgent?.status === "ready" && demoAgent.elevenlabs_agent_id) {
                  return (
                    <p style={{ margin: "0 0 12px" }}>
                      <a
                        href={launchDemoUrl(demoAgent.elevenlabs_agent_id, demoAgent.branch_id)}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ fontWeight: 600 }}
                      >
                        Launch demo →
                      </a>
                    </p>
                  );
                }
                if (demoAgent?.status === "provisioning") {
                  return (
                    <p className="small muted" style={{ margin: "0 0 12px" }}>
                      Demo agent building…
                    </p>
                  );
                }
                if (demoAgent?.status === "failed") {
                  return (
                    <p className="small" style={{ margin: "0 0 12px", color: "var(--bad)" }}>
                      Demo agent failed to build — open the call to retry.
                    </p>
                  );
                }
                return null;
              })()}

              {event?.meetLink && (
                <p style={{ margin: "0 0 12px" }}>
                  <a
                    href={event.meetLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ fontWeight: 600 }}
                  >
                    Join the Google Meet →
                  </a>
                  {event.eventLink && (
                    <>
                      {" · "}
                      <a
                        href={event.eventLink}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="small"
                      >
                        open in calendar
                      </a>
                    </>
                  )}
                </p>
              )}

              {call.summary && <p>{call.summary}</p>}

              {brief ? (
                <>
                  <Brief brief={brief} compact />
                  <LeadFacts lead={lead} inline />
                </>
              ) : (
                <p className="muted small">
                  No briefing generated for this call yet.{" "}
                  <Link href={`/calls/${call.id}`}>Open the call</Link> to generate one.
                </p>
              )}

              <p className="small" style={{ marginTop: 14, marginBottom: 0 }}>
                <Link href={`/calls/${call.id}`}>Read the full transcript →</Link>
              </p>
            </div>
          );
        })
      )}
    </>
  );
}
