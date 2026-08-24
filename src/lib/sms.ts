/**
 * Twilio SMS, used for one thing: telling Bob the moment a meeting books.
 *
 * Calls Twilio's Messages API directly — the same approach the handover doc
 * (block G) describes for the agent's own send_sms tool. No SDK needed.
 */

import { optional } from "./env";
import { db, logEvent } from "./db";

export function smsConfigured(): boolean {
  return Boolean(
    optional("TWILIO_ACCOUNT_SID") &&
      optional("TWILIO_AUTH_TOKEN") &&
      optional("TWILIO_FROM_NUMBER") &&
      optional("ALERT_TO_NUMBER"),
  );
}

export async function sendAlertSms(
  body: string,
  context: { callId?: number; purpose?: string } = {},
): Promise<{ sent: boolean; detail: string }> {
  if (!smsConfigured()) {
    return { sent: false, detail: "Twilio isn't configured, so no text was sent." };
  }

  const accountSid = optional("TWILIO_ACCOUNT_SID")!;
  const authToken = optional("TWILIO_AUTH_TOKEN")!;
  const from = optional("TWILIO_FROM_NUMBER")!;
  const to = optional("ALERT_TO_NUMBER")!;

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      logEvent("sms.failed", `Booking text failed (${response.status})`, text.slice(0, 500));
      return { sent: false, detail: `Twilio rejected the message: ${text.slice(0, 200)}` };
    }

    // Record the send, keyed on Twilio's message SID.
    //
    // No price is written here on purpose: Twilio does not populate
    // Message.price at send time, so anything we wrote now would be a guess
    // wearing the costume of a charge. src/lib/twilio-reconcile.ts fetches the
    // real figure back by SID a minute or two later. Until then the row is
    // PENDING, not free.
    let sid: string | null = null;
    let segments = 1;
    try {
      const payload = JSON.parse(text) as { sid?: string; num_segments?: string };
      sid = payload.sid ?? null;
      const parsed = Number(payload.num_segments);
      if (Number.isFinite(parsed) && parsed > 0) segments = parsed;
    } catch {
      // A send that worked but whose body we couldn't parse still counts as
      // one message — never let bookkeeping swallow a successful text.
    }

    db()
      .prepare(
        `INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(context.callId ?? null, context.purpose ?? "booking_alert", sid, segments, Date.now());

    logEvent("sms.sent", `Booking alert texted to ${to}`);
    return { sent: true, detail: `Texted ${to}.` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("sms.failed", "Booking text failed", detail);
    return { sent: false, detail };
  }
}
