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
import { Brief } from "@/components/Brief";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const booked = listBookedCalls();
  const features = featureStatus();

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

          return (
            <div className="panel" key={call.id}>
              <h2 style={{ marginBottom: 4 }}>{call.business_name ?? "Unknown business"}</h2>
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

              {call.summary && <p>{call.summary}</p>}

              {brief ? (
                <Brief brief={brief} compact />
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
