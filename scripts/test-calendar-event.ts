/**
 * Tests for pulling the booked event (and its Google Meet link) out of a
 * post-call webhook, and for the booking SMS that carries it.
 *
 * The fixtures below reproduce the EXACT shape observed in a real ElevenLabs
 * payload (conversation conv_2201m08wdf5cf5793cxrgkb585qz, 18 Aug 2026):
 *   - tool_calls and tool_results sit on different turns
 *   - result_value is a JSON *string*, not an object
 *   - the Meet link appears as both `hangoutLink` and in conferenceData.entryPoints
 *
 * Identifiers here are invented. The real payload contains the live Twilio
 * Account SID in a tool URL, so it is deliberately NOT committed as a fixture —
 * this repo is public. To check against the real row instead, run:
 *   node .test-build/scripts/test-calendar-event.js --with-real-payload
 * which reads it from the local database and never writes it anywhere.
 */

import { buildBookingSms, findBookedEvent } from "../src/lib/calendar-event";
import type { TranscriptTurn } from "../src/lib/outcomes";

const MEET = "https://meet.google.com/jpu-zurh-bks";

function agentTurn(extra: Partial<TranscriptTurn>): TranscriptTurn {
  return { role: "agent", message: "", tool_calls: [], tool_results: [], ...extra };
}

/** A create_event call and its successful result, on consecutive turns. */
function successfulBooking(resultValue: string): TranscriptTurn[] {
  return [
    agentTurn({ message: "Right, booking you in now." }),
    agentTurn({
      tool_calls: [
        {
          type: "api_integration_webhook",
          request_id: "google_calendar_create_event_822210be",
          tool_name: "google_calendar_create_event",
          params_as_json: '{"calendarId": "primary"}',
          tool_has_been_called: true,
        },
      ],
    }),
    agentTurn({
      tool_results: [
        {
          request_id: "google_calendar_create_event_822210be",
          tool_name: "google_calendar_create_event",
          result_value: resultValue,
          is_error: false,
          tool_has_been_called: true,
        },
      ],
    }),
  ];
}

const FULL_EVENT = JSON.stringify({
  id: "6fhi8uq2i4db6ron7rkj80fnv0",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=EXAMPLE",
  summary: "AI Phone Answering System Demo",
  start: { dateTime: "2026-08-20T10:00:00+10:00", timeZone: "Australia/Sydney" },
  end: { dateTime: "2026-08-20T10:15:00+10:00", timeZone: "Australia/Sydney" },
  hangoutLink: MEET,
  conferenceData: {
    entryPoints: [{ entryPointType: "video", uri: MEET, label: "meet.google.com/jpu-zurh-bks" }],
    conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
    conferenceId: "jpu-zurh-bks",
  },
});

/** Same event with hangoutLink removed — the link must still be found. */
const ENTRYPOINTS_ONLY = JSON.stringify({
  id: "abc",
  status: "confirmed",
  start: { dateTime: "2026-08-20T10:00:00+10:00" },
  conferenceData: {
    entryPoints: [
      { entryPointType: "more", uri: "https://tel.meet/xyz" },
      { entryPointType: "video", uri: MEET },
    ],
  },
});

/** A phone-only booking — no video conference at all. */
const NO_CONFERENCE = JSON.stringify({
  id: "def",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=NOCONF",
  start: { dateTime: "2026-08-20T14:00:00+10:00" },
});

const CHECK_AVAILABILITY_ONLY: TranscriptTurn[] = [
  agentTurn({
    tool_calls: [
      { tool_name: "google_calendar_check_availability", request_id: "r1", tool_has_been_called: true },
    ],
  }),
  agentTurn({
    tool_results: [
      {
        request_id: "r1",
        tool_name: "google_calendar_check_availability",
        result_value: '{"kind": "calendar#freeBusy", "calendars": {"primary": {"busy": []}}}',
        is_error: false,
      },
    ],
  }),
];

const FAILED_BOOKING: TranscriptTurn[] = [
  agentTurn({
    tool_calls: [
      { tool_name: "google_calendar_create_event", request_id: "r2", tool_has_been_called: true },
    ],
  }),
  agentTurn({
    tool_results: [
      {
        request_id: "r2",
        tool_name: "google_calendar_create_event",
        result_value: "Error code: 401. Details: HTTP 401",
        is_error: true,
        raw_error_message: '{"code":20003,"message":"Authentication Error"}',
      },
    ],
  }),
];

const NO_TOOLS: TranscriptTurn[] = [
  agentTurn({ message: "Have you got twenty seconds?" }),
  { role: "user", message: "Not interested, mate.", tool_calls: [], tool_results: [] },
];

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

console.log("\nExtracting the booked event\n");

const full = findBookedEvent(successfulBooking(FULL_EVENT));
check("finds the event across separate call/result turns", full?.created === true);
check("extracts the Meet link from hangoutLink", full?.meetLink === MEET, `got ${full?.meetLink}`);
check(
  "extracts the calendar event link",
  full?.eventLink === "https://www.google.com/calendar/event?eid=EXAMPLE",
);
check("extracts the start time", full?.startsAt === "2026-08-20T10:00:00+10:00", `got ${full?.startsAt}`);

const entry = findBookedEvent(successfulBooking(ENTRYPOINTS_ONLY));
check("falls back to conferenceData.entryPoints when hangoutLink is absent", entry?.meetLink === MEET, `got ${entry?.meetLink}`);
check("ignores non-video entry points", entry?.meetLink !== "https://tel.meet/xyz");

const noConf = findBookedEvent(successfulBooking(NO_CONFERENCE));
check("a booking with no video conference still counts as created", noConf?.created === true);
check("...but reports no Meet link", noConf?.meetLink === undefined, `got ${noConf?.meetLink}`);

const malformed = findBookedEvent(successfulBooking(`not json at all but contains ${MEET} somewhere`));
check("recovers the link from unparseable result_value", malformed?.meetLink === MEET, `got ${malformed?.meetLink}`);

console.log("\nNot-a-booking cases\n");

check("check_availability alone is not a booking", findBookedEvent(CHECK_AVAILABILITY_ONLY) === null);

const failedBooking = findBookedEvent(FAILED_BOOKING);
check("a failed create_event is not created", failedBooking?.created === false);
check("...and carries the error", Boolean(failedBooking?.error));
check("...and has no Meet link", failedBooking?.meetLink === undefined);

check("no calendar tool at all returns null", findBookedEvent(NO_TOOLS) === null);
check("undefined transcript returns null", findBookedEvent(undefined) === null);
check("empty transcript returns null", findBookedEvent([]) === null);

console.log("\nThe booking SMS\n");

const withLink = buildBookingSms({
  business: "Novocastrian Electrical",
  when: "Thu 20 Aug, 10:00 am",
  figureLine: "They agreed to about $3,000/wk in missed calls.",
  event: full,
});
check("SMS contains the Meet link", withLink.includes(MEET), withLink);
check("SMS contains the business", withLink.includes("Novocastrian Electrical"));
check("SMS contains the time", withLink.includes("Thu 20 Aug, 10:00 am"));
check("SMS contains the loss figure", withLink.includes("$3,000/wk"));
check("SMS fits in two segments (320 chars)", withLink.length <= 320, `${withLink.length} chars`);

const withoutLink = buildBookingSms({
  business: "Hunter Valley Plumbing",
  when: "Fri 21 Aug, 2:00 pm",
  event: null,
});
check("falls back cleanly with no event", !withoutLink.includes("Join:"), withoutLink);
check("...and still confirms the booking", withoutLink.includes("MEETING BOOKED") && withoutLink.includes("Fri 21 Aug, 2:00 pm"));
check("...and has no stray double spaces", !/ {2}/.test(withoutLink), JSON.stringify(withoutLink));

const failedSms = buildBookingSms({
  business: "Test Co",
  when: "Mon 24 Aug, 9:00 am",
  event: failedBooking,
});
check("a failed booking produces no Join link", !failedSms.includes("Join:"), failedSms);

console.log("\nExample messages:");
console.log("  with link:    " + withLink);
console.log("  without link: " + withoutLink);

// --- Optional: verify against the real stored payload -----------------------
if (process.argv.includes("--with-real-payload")) {
  console.log("\nAgainst the real stored webhook payload\n");
  try {
    // Required lazily so the normal test run has no database dependency.
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync("./data/dashboard.db");
    const row = database
      .prepare("SELECT transcript_json FROM calls WHERE booked = 1 ORDER BY id DESC LIMIT 1")
      .get() as { transcript_json: string } | undefined;

    if (!row) {
      console.log("  SKIP  no booked call in the local database");
    } else {
      const real = findBookedEvent(JSON.parse(row.transcript_json));
      check("real payload: booking found", real?.created === true);
      check(
        "real payload: Meet link extracted",
        Boolean(real?.meetLink && /^https:\/\/meet\.google\.com\//.test(real.meetLink)),
        `got ${real?.meetLink}`,
      );
      check("real payload: start time extracted", Boolean(real?.startsAt), `got ${real?.startsAt}`);
      console.log("  (real link: " + real?.meetLink + ", starts " + real?.startsAt + ")");
    }
  } catch (err) {
    console.log("  SKIP  couldn't read the database: " + (err as Error).message);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
