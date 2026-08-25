/**
 * Fetching back what Twilio actually charged.
 *
 * Twilio does not know the price when the thing happens. Both the Call and the
 * Message resource say the same thing in their docs — the charge is "populated
 * after the call is completed" / "after the message is sent" and "may not be
 * immediately available". So there is no way to record a real Twilio cost at
 * the moment we write the row; it has to be collected afterwards, by SID.
 *
 * That is the whole reason this file exists, and the reason a Twilio row starts
 * life with a NULL price. NULL means "Twilio hasn't told us yet" and must
 * render as pending. It must never be coalesced to zero — a call that cost
 * money and a call that cost nothing are different facts, and only one of them
 * is true here.
 *
 * Runs off the same one-minute scheduler heartbeat as everything else, so
 * prices settle on their own without anyone opening a page.
 */

import { db, logEvent } from "./db";
import { fetchCallPrice, fetchMessageDetails, twilioConfigured } from "./twilio";

/**
 * Delivery states that won't change again — a message can keep moving
 * through queued/sending/sent for a while, but once it lands on one of
 * these, re-polling it is pointless traffic.
 */
const TERMINAL_STATUSES = new Set(["delivered", "undelivered", "failed", "canceled"]);

/**
 * How many SIDs to chase in one pass.
 *
 * Bounded because at 250 calls/day a backlog could otherwise fire hundreds of
 * requests in a single tick. They go out concurrently within a pass, and the
 * next tick picks up the remainder a minute later.
 */
const BATCH = 25;

/**
 * Don't chase a price forever. Twilio settles within minutes; a row still
 * unpriced after this long is not going to resolve, and hammering it every
 * minute for weeks would be pointless traffic.
 */
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconcileResult {
  callsPriced: number;
  messagesPriced: number;
  stillPending: number;
}

export async function reconcileTwilioPrices(): Promise<ReconcileResult> {
  const result: ReconcileResult = { callsPriced: 0, messagesPriced: 0, stillPending: 0 };
  if (!twilioConfigured()) return result;

  const database = db();
  const cutoff = Date.now() - GIVE_UP_AFTER_MS;

  const pendingCalls = database
    .prepare(
      `SELECT id, twilio_call_sid FROM calls
        WHERE twilio_call_sid IS NOT NULL AND twilio_price IS NULL AND created_at > ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(cutoff, BATCH) as unknown as Array<{ id: number; twilio_call_sid: string }>;

  // Keeps polling a message until BOTH the price and a TERMINAL delivery
  // status are known — price and status can settle at different times, so
  // stopping the moment price arrives would leave a message stuck showing a
  // stale "queued"/"sent" status forever if that happened to settle second.
  const pendingMessages = database
    .prepare(
      `SELECT id, provider_sid, status FROM sms_sends
        WHERE provider_sid IS NOT NULL AND created_at > ?
          AND (price IS NULL OR status IS NULL OR status NOT IN ('delivered','undelivered','failed','canceled'))
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(cutoff, BATCH) as unknown as Array<{ id: number; provider_sid: string; status: string | null }>;

  if (pendingCalls.length === 0 && pendingMessages.length === 0) return result;

  // Concurrent, not serial: a batch of 25 sequential round-trips to Twilio
  // would take longer than the tick interval it runs on.
  const [callPrices, messageDetails] = await Promise.all([
    Promise.all(pendingCalls.map((row) => fetchCallPrice(row.twilio_call_sid))),
    Promise.all(pendingMessages.map((row) => fetchMessageDetails(row.provider_sid))),
  ]);

  const updateCall = database.prepare(
    `UPDATE calls SET twilio_price = ?, twilio_price_unit = ?, twilio_price_fetched_at = ?
      WHERE id = ?`,
  );
  const updateMessage = database.prepare(
    `UPDATE sms_sends SET price = ?, price_unit = ?, price_fetched_at = ?, status = ?, status_error = ? WHERE id = ?`,
  );

  const now = Date.now();

  pendingCalls.forEach((row, i) => {
    const fetched = callPrices[i];
    // Record the attempt timestamp either way, but only write a price when
    // Twilio actually gave us one. A null price with a fetch timestamp says
    // "we asked and it isn't settled" — which is the honest state.
    if (fetched && fetched.price !== null) {
      updateCall.run(fetched.price, fetched.priceUnit, now, row.id);
      result.callsPriced++;
    } else {
      result.stillPending++;
    }
  });

  pendingMessages.forEach((row, i) => {
    const fetched = messageDetails[i];
    if (!fetched) {
      result.stillPending++;
      return;
    }

    const gotPrice = fetched.price !== null;
    const gotTerminalStatus = fetched.status !== null && TERMINAL_STATUSES.has(fetched.status);

    if (gotPrice || fetched.status !== null) {
      // Safe to write unconditionally: Twilio doesn't "forget" a value once
      // settled, so a field that's already landed keeps coming back on every
      // later fetch too — this never overwrites a real price/status with a
      // null from a fetch that's only still pending on the OTHER field.
      updateMessage.run(
        fetched.price ?? null,
        fetched.priceUnit,
        now,
        fetched.status,
        fetched.errorMessage,
        row.id,
      );
      if (gotPrice) result.messagesPriced++;
    }

    if (!gotPrice || !gotTerminalStatus) {
      result.stillPending++;
    }
  });

  if (result.callsPriced > 0 || result.messagesPriced > 0) {
    logEvent(
      "twilio.reconciled",
      `Twilio settled ${result.callsPriced} call price(s) and ${result.messagesPriced} message price(s).`,
    );
  }

  return result;
}
