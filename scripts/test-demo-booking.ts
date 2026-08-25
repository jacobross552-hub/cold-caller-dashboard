/**
 * Tests for demo-meeting reminders, no-show flagging, and delivery-status
 * tracking (the SMS reminders feature).
 *
 * Run with:  npm run test:demo-booking
 *
 * No real network: global fetch is stubbed for the Twilio sends, same
 * pattern test-elevenlabs-agents.ts uses. No API key, no spend. Uses its own
 * scratch database.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `demo-booking-test-${process.pid}.db`);

process.env.DATABASE_PATH = SCRATCH;
process.env.TWILIO_ACCOUNT_SID = "test-sid";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+61480846881";

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const booking = require("../src/lib/demo-booking") as typeof import("../src/lib/demo-booking");
const twilio = require("../src/lib/twilio") as typeof import("../src/lib/twilio");
const reconcile = require("../src/lib/twilio-reconcile") as typeof import("../src/lib/twilio-reconcile");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

let nextId = 0;

/** A transcript shaped like a real one, with a real calendar-booking tool call/result and optional SMS sends. */
function bookedTranscript(opts: {
  meetingIso: string;
  meetLink?: string;
  smsSends?: Array<{ sid: string; to: string; body: string; isError?: boolean; rawError?: string }>;
}) {
  const turns: Array<Record<string, unknown>> = [
    { role: "agent", message: "Booking you in now.", tool_calls: [{ tool_name: "google_calendar_create_event", request_id: "req_1" }] },
    {
      role: "agent",
      message: "",
      tool_results: [
        {
          request_id: "req_1",
          tool_name: "google_calendar_create_event",
          is_error: false,
          result_value: JSON.stringify({
            start: { dateTime: opts.meetingIso },
            hangoutLink: opts.meetLink ?? "https://meet.google.com/abc-defg-hij",
            htmlLink: "https://calendar.example.invalid/evt",
            summary: "Demo",
          }),
        },
      ],
    },
  ];

  // Real transcripts split an SMS tool call across two turns — the call
  // (with To/Body, matching a real send_sms webhook) in one, the result
  // (matched back by request_id) in the next — same as the calendar tool
  // above. A failed result carries no To/Body of its own; only the call does.
  (opts.smsSends ?? []).forEach((sms, i) => {
    const requestId = `req_sms_${i}`;
    turns.push({
      role: "agent",
      tool_calls: [
        {
          tool_name: "send_sms",
          request_id: requestId,
          params_as_json: JSON.stringify({ To: sms.to, Body: sms.body, From: "+61480846881" }),
        },
      ],
    });
    turns.push({
      role: "agent",
      tool_results: [
        sms.isError
          ? {
              request_id: requestId,
              tool_name: "send_sms",
              is_error: true,
              result_value: "Error code: 400. Details: HTTP 400",
              raw_error_message: sms.rawError ?? "simulated failure",
            }
          : {
              request_id: requestId,
              tool_name: "send_sms",
              is_error: false,
              result_value: JSON.stringify({ sid: sms.sid, to: sms.to, body: sms.body, status: "queued" }),
            },
      ],
    });
  });

  return turns;
}

function seedCall(opts: { createdAt: number; phone?: string; transcript?: unknown[] }): number {
  nextId++;
  const conversationId = `conv_booking_test_${nextId}`;
  db()
    .prepare(
      `INSERT INTO calls (conversation_id, phone, booked, created_at, transcript_json) VALUES (?, ?, 1, ?, ?)`,
    )
    .run(conversationId, opts.phone ?? "+61490001111", opts.createdAt, opts.transcript ? JSON.stringify(opts.transcript) : null);
  return (db().prepare("SELECT id FROM calls WHERE conversation_id = ?").get(conversationId) as { id: number }).id;
}

const MS_PER_HOUR = 60 * 60 * 1000;

async function main() {
  console.log("\n1. recordDemoBooking — skip-flag computation from real lead time\n");

  const now = Date.now();

  // Booked with 3 days' notice: neither reminder should be skipped.
  const meetingIn3Days = now + 3 * 24 * MS_PER_HOUR;
  const call1 = seedCall({
    createdAt: now,
    transcript: bookedTranscript({ meetingIso: new Date(meetingIn3Days).toISOString() }),
  });
  booking.recordDemoBooking(call1);
  const row1 = booking.getDemoBooking(call1)!;
  equal("meeting_at parsed correctly", row1.meeting_at, new Date(meetingIn3Days).getTime());
  equal("24h reminder not skipped — plenty of notice", row1.reminder_24h_skipped, 0);
  equal("1h reminder not skipped", row1.reminder_1h_skipped, 0);
  check("meet link captured", row1.meet_link === "https://meet.google.com/abc-defg-hij");

  console.log("\n2. recordDemoBooking — booked with only 3 hours' notice\n");

  const meetingIn3Hours = now + 3 * MS_PER_HOUR;
  const call2 = seedCall({
    createdAt: now,
    transcript: bookedTranscript({ meetingIso: new Date(meetingIn3Hours).toISOString() }),
  });
  booking.recordDemoBooking(call2);
  const row2 = booking.getDemoBooking(call2)!;
  equal("24h reminder skipped — not enough lead time", row2.reminder_24h_skipped, 1);
  equal("1h reminder NOT skipped — there's still time for it", row2.reminder_1h_skipped, 0);

  console.log("\n3. recordDemoBooking — booked with 20 minutes' notice\n");

  const meetingIn20Min = now + 20 * 60 * 1000;
  const call3 = seedCall({
    createdAt: now,
    transcript: bookedTranscript({ meetingIso: new Date(meetingIn20Min).toISOString() }),
  });
  booking.recordDemoBooking(call3);
  const row3 = booking.getDemoBooking(call3)!;
  equal("24h reminder skipped", row3.reminder_24h_skipped, 1);
  equal("1h reminder ALSO skipped — no time for either", row3.reminder_1h_skipped, 1);

  console.log("\n4. recordDemoBooking is idempotent\n");

  booking.recordDemoBooking(call1); // called again
  const countRows = db().prepare("SELECT COUNT(*) n FROM demo_bookings WHERE call_id = ?").get(call1) as { n: number };
  equal("still exactly one row", countRows.n, 1);

  console.log("\n5. recordDemoBooking degrades gracefully with no parseable booking\n");

  const call4 = seedCall({ createdAt: now, transcript: [{ role: "agent", message: "hi" }] });
  booking.recordDemoBooking(call4); // must not throw
  check("no demo_bookings row created", booking.getDemoBooking(call4) === null);

  console.log("\n6. Backfilling the agent's own confirmation text from the transcript\n");

  const call5 = seedCall({
    createdAt: now,
    phone: "+61450608853",
    transcript: bookedTranscript({
      meetingIso: new Date(meetingIn3Days).toISOString(),
      smsSends: [
        { sid: "SM_confirmation", to: "+61450608853", body: "Your demo is booked. Join: https://meet.google.com/abc-defg-hij" },
        { sid: "SM_callback", to: "+61450608853", body: "Here's the number to call us back on." },
        {
          sid: "SM_failed",
          to: "+61351760102",
          body: "Your demo is booked. Join: https://meet.google.com/abc-defg-hij",
          isError: true,
          rawError: "'To' number +61351760102 cannot be a landline",
        },
      ],
    }),
  });
  booking.recordDemoBooking(call5);

  const sends = booking.listSmsForCall(call5);
  equal("all three sends backfilled, including the failed one", sends.length, 3);
  const confirmation = sends.find((s) => s.provider_sid === "SM_confirmation");
  const other = sends.find((s) => s.provider_sid === "SM_callback");
  const failedSend = sends.find((s) => s.status === "failed");
  equal("the meet-link text is labelled the confirmation", confirmation?.purpose, "demo_confirmation");
  equal("the other text is labelled generically", other?.purpose, "agent_sms_other");
  check("the failed send has no provider_sid — nothing to poll for", failedSend?.provider_sid === null);
  equal("the failed send is still labelled the confirmation — it had the meet link", failedSend?.purpose, "demo_confirmation");
  equal("the failed send's status_error carries the real Twilio reason", failedSend?.status_error, "'To' number +61351760102 cannot be a landline");

  console.log("\n7. demoBookingTick — sends a due 24h reminder, records it, doesn't double-send\n");

  const sentRequests: Array<{ url: string; body: string }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    sentRequests.push({ url, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ sid: "SM_reminder_1", num_segments: "1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // A meeting 23 hours away — inside the 24h reminder window, not yet sent.
  const meetingIn23h = Date.now() + 23 * MS_PER_HOUR;
  const call6 = seedCall({ createdAt: Date.now() - 2 * 24 * MS_PER_HOUR, phone: "+61490002222", transcript: bookedTranscript({ meetingIso: new Date(meetingIn23h).toISOString() }) });
  booking.recordDemoBooking(call6);

  await booking.demoBookingTick();
  equal("one 24h reminder sent", sentRequests.length, 1);
  check("sent to the prospect's number", sentRequests[0].body.includes(encodeURIComponent("+61490002222")));
  const row6 = booking.getDemoBooking(call6)!;
  check("reminder_24h_sent_at recorded", row6.reminder_24h_sent_at !== null);

  const sentBefore = sentRequests.length;
  await booking.demoBookingTick(); // second tick — must not resend
  equal("not sent again on a second tick", sentRequests.length, sentBefore);

  console.log("\n8. demoBookingTick — respects the skip flags\n");

  // call2 (from section 2) has reminder_24h_skipped=1, meeting only 3h away.
  await booking.demoBookingTick();
  const row2After = booking.getDemoBooking(call2)!;
  check("24h reminder still not sent — it was skipped at booking time", row2After.reminder_24h_sent_at === null);

  console.log("\n9. demoBookingTick — sends a due 1h reminder\n");

  const meetingIn30Min = Date.now() + 30 * 60 * 1000;
  const call7 = seedCall({ createdAt: Date.now() - 2 * MS_PER_HOUR, phone: "+61490003333", transcript: bookedTranscript({ meetingIso: new Date(meetingIn30Min).toISOString() }) });
  booking.recordDemoBooking(call7);

  const before1h = sentRequests.length;
  await booking.demoBookingTick();
  const row7 = booking.getDemoBooking(call7)!;
  check("1h reminder sent", row7.reminder_1h_sent_at !== null);
  check("a new request went out", sentRequests.length > before1h);

  console.log("\n10. demoBookingTick — does not send a reminder for a meeting already in the past\n");

  const meetingYesterday = Date.now() - 24 * MS_PER_HOUR;
  const call8 = seedCall({ createdAt: Date.now() - 3 * 24 * MS_PER_HOUR, phone: "+61490004444", transcript: bookedTranscript({ meetingIso: new Date(meetingYesterday).toISOString() }) });
  booking.recordDemoBooking(call8);
  // Manually clear skip flags to make sure the past-meeting guard, not the skip flag, is what's stopping it.
  db().exec("UPDATE demo_bookings SET reminder_24h_skipped = 0, reminder_1h_skipped = 0 WHERE call_id = " + call8);

  const beforePast = sentRequests.length;
  await booking.demoBookingTick();
  const row8 = booking.getDemoBooking(call8)!;
  check("no reminder sent for a meeting that already happened", row8.reminder_24h_sent_at === null && row8.reminder_1h_sent_at === null);
  equal("no new requests went out", sentRequests.length, beforePast);

  console.log("\n11. demoBookingTick — no-show flagging\n");

  // Meeting started 6 minutes ago, nobody marked attendance yet.
  const meetingJustPassed = Date.now() - 6 * 60 * 1000;
  const call9 = seedCall({ createdAt: Date.now() - MS_PER_HOUR, phone: "+61490005555", transcript: bookedTranscript({ meetingIso: new Date(meetingJustPassed).toISOString() }) });
  booking.recordDemoBooking(call9);

  await booking.demoBookingTick();
  const row9 = booking.getDemoBooking(call9)!;
  check("flagged as a no-show", row9.no_show_flagged_at !== null);
  check("shows up in the unresolved list", booking.listUnresolvedNoShows().some((b) => b.call_id === call9));

  const flaggedAt = row9.no_show_flagged_at;
  await booking.demoBookingTick(); // must not re-flag / change the timestamp
  const row9Again = booking.getDemoBooking(call9)!;
  equal("flagged timestamp doesn't change on a later tick", row9Again.no_show_flagged_at, flaggedAt);

  console.log("\n12. demoBookingTick — a meeting still within the 5-minute grace period isn't flagged yet\n");

  const meetingJustNow = Date.now() - 2 * 60 * 1000; // 2 minutes ago, grace is 5
  const call10 = seedCall({ createdAt: Date.now() - MS_PER_HOUR, phone: "+61490006666", transcript: bookedTranscript({ meetingIso: new Date(meetingJustNow).toISOString() }) });
  booking.recordDemoBooking(call10);
  await booking.demoBookingTick();
  check("not flagged yet — still inside the grace period", booking.getDemoBooking(call10)!.no_show_flagged_at === null);

  console.log("\n13. recordAttendance clears the no-show flag's practical effect\n");

  booking.recordAttendance(call9, "no_show_called", "Left a voicemail.");
  const row9Marked = booking.getDemoBooking(call9)!;
  equal("attendance recorded", row9Marked.attendance, "no_show_called");
  equal("notes recorded", row9Marked.attendance_notes, "Left a voicemail.");
  check("attendance_marked_at set", row9Marked.attendance_marked_at !== null);
  check("no longer in the unresolved list", !booking.listUnresolvedNoShows().some((b) => b.call_id === call9));

  // A tick afterwards must not re-flag an already-resolved booking, even
  // though its meeting_at is still well in the past.
  await booking.demoBookingTick();
  const row9Final = booking.getDemoBooking(call9)!;
  equal("flagged_at unchanged after being resolved", row9Final.no_show_flagged_at, flaggedAt);

  global.fetch = originalFetch;

  console.log("\n14. fetchMessageDetails parses price, status, and error together\n");

  global.fetch = (async () =>
    new Response(
      JSON.stringify({ price: "-0.0400", price_unit: "USD", status: "delivered", error_message: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const details = await twilio.fetchMessageDetails("SM_test");
  equal("price parsed and made positive", details?.price, 0.04);
  equal("status parsed", details?.status, "delivered");
  equal("null error stays null", details?.errorMessage, null);

  global.fetch = (async () =>
    new Response(
      JSON.stringify({ price: null, price_unit: "USD", status: "failed", error_message: "30007 carrier rejected" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const failedDetails = await twilio.fetchMessageDetails("SM_test2");
  equal("a still-unsettled price stays null", failedDetails?.price, null);
  equal("failed status captured", failedDetails?.status, "failed");
  equal("error message captured", failedDetails?.errorMessage, "30007 carrier rejected");

  global.fetch = originalFetch;

  console.log("\n15. twilio-reconcile keeps polling until BOTH price and a terminal status are known\n");

  db().exec("DELETE FROM sms_sends");
  db()
    .prepare(`INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, created_at) VALUES (NULL, 'demo_reminder_1h', 'SM_poll_1', 1, ?)`)
    .run(Date.now());

  // First pass: Twilio has a price but the message is still "sent", not terminal.
  global.fetch = (async () =>
    new Response(JSON.stringify({ price: "-0.0400", price_unit: "USD", status: "sent", error_message: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await reconcile.reconcileTwilioPrices();
  const afterFirstPoll = db().prepare("SELECT price, status FROM sms_sends WHERE provider_sid = 'SM_poll_1'").get() as {
    price: number;
    status: string;
  };
  equal("price recorded even though status isn't terminal yet", afterFirstPoll.price, 0.04);
  equal("non-terminal status recorded too", afterFirstPoll.status, "sent");

  // Second pass: now it's delivered. Must still be picked up (price already
  // set shouldn't have stopped the row from being polled again).
  global.fetch = (async () =>
    new Response(JSON.stringify({ price: "-0.0400", price_unit: "USD", status: "delivered", error_message: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await reconcile.reconcileTwilioPrices();
  const afterSecondPoll = db().prepare("SELECT status FROM sms_sends WHERE provider_sid = 'SM_poll_1'").get() as { status: string };
  equal("now shows the terminal status", afterSecondPoll.status, "delivered");

  // Third pass: already terminal — must not be selected again (nothing to assert
  // on the DB directly, but confirm reconcile doesn't error and settles cleanly).
  const result = await reconcile.reconcileTwilioPrices();
  equal("nothing left pending for this message", result.stillPending, 0);

  global.fetch = originalFetch;

  console.log("\n16. landline_only — set on a landline dial number with no working confirmation send\n");

  const call11 = seedCall({
    createdAt: now,
    phone: "+61351760102", // a real AU landline prefix (03)
    transcript: bookedTranscript({
      meetingIso: new Date(meetingIn3Days).toISOString(),
      smsSends: [
        {
          sid: "SM_landline_fail",
          to: "+61351760102",
          body: "Your demo is booked. Join: https://meet.google.com/abc-defg-hij",
          isError: true,
          rawError: "'To' number +61351760102 cannot be a landline",
        },
      ],
    }),
  });
  booking.recordDemoBooking(call11);
  equal("flagged landline_only — dialled number is a landline and the text failed", booking.getDemoBooking(call11)!.landline_only, 1);

  console.log("\n17. landline_only — NOT set when a working mobile alternative got the confirmation through\n");

  const call12 = seedCall({
    createdAt: now,
    phone: "+61351760102", // dialled on a landline...
    transcript: bookedTranscript({
      meetingIso: new Date(meetingIn3Days).toISOString(),
      smsSends: [
        // ...but they gave a mobile instead, and it went through fine.
        { sid: "SM_alt_mobile", to: "+61490009999", body: "Your demo is booked. Join: https://meet.google.com/abc-defg-hij" },
      ],
    }),
  });
  booking.recordDemoBooking(call12);
  equal("not flagged — the confirmation reached them another way", booking.getDemoBooking(call12)!.landline_only, 0);

  console.log("\n18. landline_only — NOT set for a normal mobile dial number\n");

  const call13 = seedCall({
    createdAt: now,
    phone: "+61490001234",
    transcript: bookedTranscript({ meetingIso: new Date(meetingIn3Days).toISOString() }),
  });
  booking.recordDemoBooking(call13);
  equal("mobile numbers are never flagged", booking.getDemoBooking(call13)!.landline_only, 0);

  console.log("\n19. backfillLandlineFlags — recomputes existing bookings from real data\n");

  db().exec(`UPDATE demo_bookings SET landline_only = 0 WHERE call_id = ${call11}`);
  db().exec(`UPDATE demo_bookings SET landline_only = 1 WHERE call_id = ${call13}`);
  const changed = booking.backfillLandlineFlags();
  check("both mis-set rows were corrected", changed >= 2);
  equal("call11 (real landline failure) corrected back to 1", booking.getDemoBooking(call11)!.landline_only, 1);
  equal("call13 (real mobile) corrected back to 0", booking.getDemoBooking(call13)!.landline_only, 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);

  try {
    rmSync(SCRATCH, { force: true });
    rmSync(`${SCRATCH}-wal`, { force: true });
    rmSync(`${SCRATCH}-shm`, { force: true });
  } catch {
    // A leftover scratch file is not worth failing the run over.
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nDemo-booking test crashed:", err);
  process.exit(1);
});
