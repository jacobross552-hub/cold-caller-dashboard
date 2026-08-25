/**
 * Reminders, no-show flagging, and per-text delivery status for a booked
 * demo. See src/lib/demo-booking.ts for the scheduling/sending logic this
 * displays.
 */

import { formatSydney } from "@/lib/calling-hours";
import { formatAuPhone } from "@/lib/phone";
import {
  ATTENDANCE_LABELS,
  SMS_PURPOSE_LABELS,
  type DemoBookingRow,
  type SmsSendRow,
} from "@/lib/demo-booking";

const STATUS_BADGE: Record<string, string> = {
  delivered: "good",
  sent: "",
  sending: "",
  queued: "",
  accepted: "",
  scheduled: "",
  undelivered: "bad",
  failed: "bad",
  canceled: "bad",
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge">pending</span>;
  return <span className={`badge ${STATUS_BADGE[status] ?? ""}`}>{status}</span>;
}

function ReminderRow({
  label,
  sentAt,
  skipped,
}: {
  label: string;
  sentAt: number | null;
  skipped: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={sentAt ? undefined : "muted"} style={sentAt ? undefined : { fontWeight: 400 }}>
        {sentAt
          ? `Sent ${formatSydney(sentAt)}`
          : skipped
            ? "Skipped — booked too close to the demo for this lead time"
            : "Not due yet"}
      </dd>
    </>
  );
}

export function DemoBookingPanel({
  callId,
  booking,
  smsSends,
  phone,
}: {
  callId: number;
  booking: DemoBookingRow | null;
  smsSends: SmsSendRow[];
  phone: string | null;
}) {
  if (!booking) return null;

  const isFlagged = booking.no_show_flagged_at !== null && booking.attendance === null;

  return (
    <div className="panel">
      <h2>Demo reminders &amp; attendance</h2>

      {isFlagged && (
        <div
          className="notice bad"
          style={{ fontSize: 16, fontWeight: 700, padding: "16px 18px", marginBottom: 16 }}
        >
          ⚠ NO-SHOW — this demo&apos;s start time passed 5+ minutes ago with nobody marked as joined. Call
          them.
        </div>
      )}

      {Boolean(booking.landline_only) && (
        <div
          className="notice warn"
          style={{ fontSize: 16, fontWeight: 700, padding: "16px 18px", marginBottom: 16 }}
        >
          📞 LANDLINE — they can&apos;t receive the Meet link by text. Call{" "}
          {phone ? formatAuPhone(phone) : "them"} directly at {formatSydney(booking.meeting_at)} instead of
          expecting them to join a video call.
        </div>
      )}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Scheduled for</dt>
        <dd>{formatSydney(booking.meeting_at)}</dd>
        <ReminderRow label="24h reminder" sentAt={booking.reminder_24h_sent_at} skipped={Boolean(booking.reminder_24h_skipped)} />
        <ReminderRow label="1h reminder" sentAt={booking.reminder_1h_sent_at} skipped={Boolean(booking.reminder_1h_skipped)} />
      </dl>

      {smsSends.length > 0 && (
        <>
          <h3>Text delivery status</h3>
          <div className="table-scroll" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Text</th>
                  <th>Sent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {smsSends.map((sms) => (
                  <tr key={sms.id}>
                    <td>{SMS_PURPOSE_LABELS[sms.purpose] ?? sms.purpose}</td>
                    <td className="small muted">{formatSydney(sms.created_at)}</td>
                    <td>
                      <StatusBadge status={sms.status} />
                      {sms.status_error && (
                        <span className="small muted" style={{ marginLeft: 6 }}>
                          {sms.status_error}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Attendance</h3>
      {booking.attendance ? (
        <p style={{ marginTop: 0 }}>
          <span className="badge good">{ATTENDANCE_LABELS[booking.attendance]}</span>
          {booking.attendance_notes && <span className="small muted"> — {booking.attendance_notes}</span>}
          <span className="small muted">
            {" "}
            · marked {booking.attendance_marked_at ? formatSydney(booking.attendance_marked_at) : ""}
          </span>
        </p>
      ) : (
        <form action={`/api/calls/${callId}/attendance`} method="post">
          <div className="row" style={{ marginBottom: 10 }}>
            {(Object.entries(ATTENDANCE_LABELS) as Array<[string, string]>).map(([value, label]) => (
              <label key={value} style={{ marginBottom: 0 }}>
                <input type="radio" name="attendance" value={value} style={{ width: "auto", marginRight: 6 }} required />
                {label}
              </label>
            ))}
          </div>
          <input type="text" name="notes" placeholder="Notes (optional)" style={{ marginBottom: 10 }} />
          <button type="submit">Record outcome</button>
        </form>
      )}
    </div>
  );
}
