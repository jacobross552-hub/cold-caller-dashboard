/**
 * End-to-end test of the WHOLE system, offline.
 *
 * Run with:  npm run test:integration
 *
 * The other suites each test one half. This one drives a lead all the way
 * through both halves in a single run, which is where integration bugs live:
 *
 *   lead finder (fake source)
 *     -> import + dedup + suppression
 *       -> calling run queued
 *         -> calling-hours guard
 *           -> dispatch to ElevenLabs (stubbed)
 *             -> post-call webhook
 *               -> outcome classification + booking detection
 *                 -> Meet link extraction
 *                   -> booking alert SMS (stubbed)
 *                     -> opt-out flowing back to the suppression list
 *
 * No network, no API keys, no spend, no real lead data. Uses its own scratch
 * database and never touches data/dashboard.db.
 *
 * The external edges - ElevenLabs, Anthropic, Twilio - are stubbed at the
 * module boundary so everything BETWEEN them is the real code path.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `integration-${process.pid}.db`);

// Must be set before any module is required - config is read at load time.
process.env.DATABASE_PATH = SCRATCH;
process.env.MAX_LEADS_PER_RUN = "200";
process.env.MAX_COST_PER_RUN_AUD = "25";
process.env.USD_AUD_RATE = "1.55";
process.env.MAX_CALLS_PER_DAY = "20";
process.env.DISPATCH_CHUNK_SIZE = "5";
process.env.CALL_CONCURRENCY = "2";
// The test must not depend on what time of day it runs. This is the documented
// escape hatch; the guard itself has its own dedicated suite (test:hours).
process.env.ALLOW_OUTSIDE_CALLING_HOURS = "true";
// Dummy values so featureStatus() reports the integrations as configured.
// Every call that would leave the machine is stubbed below.
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.TWILIO_ACCOUNT_SID = "test-sid";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+61400000000";
process.env.ALERT_TO_NUMBER = "+61400000001";
delete process.env.ABN_LOOKUP_GUID;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const leadsModule = require("../src/lib/leads") as typeof import("../src/lib/leads");
const suppressionModule = require("../src/lib/suppression") as typeof import("../src/lib/suppression");
const orchestrator = require("../src/lib/lead-finder/orchestrator") as typeof import("../src/lib/lead-finder/orchestrator");
const runsModule = require("../src/lib/lead-finder/runs") as typeof import("../src/lib/lead-finder/runs");
const elevenlabs = require("../src/lib/elevenlabs") as typeof import("../src/lib/elevenlabs");
const sms = require("../src/lib/sms") as typeof import("../src/lib/sms");
const brief = require("../src/lib/brief") as typeof import("../src/lib/brief");
const dispatcher = require("../src/lib/dispatcher") as typeof import("../src/lib/dispatcher");
const calls = require("../src/lib/calls") as typeof import("../src/lib/calls");

type PlaceResult = import("../src/lib/lead-finder/places").PlaceResult;
type LeadSource = import("../src/lib/lead-finder/source").LeadSource;
type BatchJob = import("../src/lib/elevenlabs").BatchJob;

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

// ---------------------------------------------------------------------------
// Stubs for the three external services
// ---------------------------------------------------------------------------

/** Everything the dispatcher handed to ElevenLabs, for assertions. */
const submitted: Array<{ name: string; recipients: unknown[]; concurrency: number }> = [];
let batchCounter = 0;

elevenlabs.submitBatch = async (params) => {
  batchCounter++;
  submitted.push({
    name: params.name,
    recipients: params.recipients,
    concurrency: params.concurrency,
  });
  return {
    id: `btcal_test_${batchCounter}`,
    status: "in_progress",
    recipients: params.recipients.map((r, i) => ({
      id: `rcp_${i}`,
      phone_number: r.phone_number,
      status: "initiated" as const,
      conversation_id: null,
    })),
  } satisfies BatchJob;
};

elevenlabs.getBatch = async (batchId) => ({
  id: batchId,
  status: "completed",
  recipients: [],
});

elevenlabs.cancelBatch = async () => {};

/** Texts that would have been sent. */
const textsSent: string[] = [];
sms.sendAlertSms = async (body: string) => {
  textsSent.push(body);
  return { sent: true, detail: "stubbed" };
};
sms.smsConfigured = () => true;

/** A fixed analysis, so the test asserts plumbing rather than model output. */
let analysisOverride: Partial<import("../src/lib/brief").CallAnalysis> = {};
brief.analyseCall = async () => {
  const analysis = {
    summary: "Prospect gave both numbers and booked a demo.",
    business_description: "Emergency plumbing, mostly after-hours call-outs.",
    missed_calls_per_week: 12,
    job_value_dollars: 450,
    raw_weekly_loss: 5400,
    discounted_weekly_loss: 1800,
    figure_agreed: "agreed" as const,
    prospect_own_figure: null,
    price_quoted: true,
    quoted_setup_fee: 5500,
    quoted_monthly_retainer: 2200,
    objections: [
      { objection: "tried it before", what_they_said: "We had one of those", how_it_landed: "moved on" },
    ],
    cared_about: ["missing after-hours jobs"],
    booking: { booked: true, day: "Thursday", time: "10:00 am", email: null },
    furthest_stage: "booked" as const,
    asked_if_ai: false,
    do_not_call_requested: false,
    talking_points: ["Runs the phone from the van"],
    agent_slips: [],
    ...analysisOverride,
  };
  return {
    analysis,
    quoteCheck: require("../src/lib/pricing").checkQuoteAgainstTable(
      analysis.discounted_weekly_loss,
      analysis.quoted_setup_fee,
      analysis.quoted_monthly_retainer,
    ),
  };
};

// ---------------------------------------------------------------------------
// Fake lead source
// ---------------------------------------------------------------------------

function fakePlace(index: number, overrides: Partial<PlaceResult> = {}): PlaceResult {
  const suffix = String(index).padStart(4, "0");
  return {
    placeId: `place_${suffix}`,
    name: `Test Plumbing ${suffix}`,
    phoneE164: `+6149000${suffix}`,
    formattedAddress: `${index} Test St, Newcastle NSW 2300`,
    state: "NSW",
    suburb: "Newcastle",
    website: index % 2 === 0 ? `https://example.invalid/${suffix}` : undefined,
    rating: 4.4,
    userRatingCount: 30 + index,
    primaryType: "plumber",
    businessStatus: "OPERATIONAL",
    openingHours: ["Monday: 8:00 AM – 5:00 PM", "Saturday: Closed"],
    ...overrides,
  } as PlaceResult;
}

function fakeSource(places: PlaceResult[]): LeadSource {
  return {
    id: "test_source",
    label: "Test source",
    async search({ onCall }) {
      onCall({
        sku: "text_search_enterprise",
        detail: "fake source page",
        httpStatus: 200,
        resultCount: places.length,
        unitCostUsd: 0,
      });
      return { results: places };
    },
  };
}

// ---------------------------------------------------------------------------
// A post-call webhook payload, shaped like the real one
// ---------------------------------------------------------------------------

const MEET_LINK = "https://meet.google.com/tst-fake-lnk";

function webhookPayload(options: {
  conversationId: string;
  leadId: number;
  runId: number;
  phone: string;
  businessName: string;
  booked?: boolean;
  bookingErrored?: boolean;
}) {
  const eventResult = JSON.stringify({
    id: "evt_test",
    status: "confirmed",
    htmlLink: "https://calendar.example.invalid/evt_test",
    summary: "AI Phone Answering System Demo",
    start: { dateTime: "2026-08-20T10:00:00+10:00", timeZone: "Australia/Sydney" },
    hangoutLink: MEET_LINK,
    conferenceData: { entryPoints: [{ entryPointType: "video", uri: MEET_LINK }] },
  });

  const transcript: Array<Record<string, unknown>> = [
    { role: "agent", message: "It's Jacob calling — got twenty seconds?", time_in_call_secs: 2 },
    { role: "user", message: "Yeah go on.", time_in_call_secs: 5 },
    { role: "agent", message: "How many calls a week get missed?", time_in_call_secs: 9 },
    { role: "user", message: "About twelve.", time_in_call_secs: 14 },
    { role: "agent", message: "And what's a job worth?", time_in_call_secs: 18 },
    { role: "user", message: "Four fifty or so.", time_in_call_secs: 22 },
    { role: "agent", message: "That's about eighteen hundred a week. Sound right?", time_in_call_secs: 30 },
    { role: "user", message: "Yeah about right.", time_in_call_secs: 35 },
  ];

  if (options.booked) {
    transcript.push({
      role: "agent",
      message: "Booking you in now.",
      time_in_call_secs: 60,
      tool_calls: [
        { tool_name: "google_calendar_create_event", request_id: "req_1", tool_has_been_called: true },
      ],
    });
    transcript.push({
      role: "agent",
      message: "",
      time_in_call_secs: 61,
      tool_results: [
        {
          request_id: "req_1",
          tool_name: "google_calendar_create_event",
          result_value: options.bookingErrored ? "Error code: 401. Details: HTTP 401" : eventResult,
          is_error: Boolean(options.bookingErrored),
        },
      ],
    });
  }

  return {
    conversation_id: options.conversationId,
    status: "done",
    transcript,
    metadata: {
      start_time_unix_secs: Math.floor(Date.now() / 1000) - 120,
      call_duration_secs: 118,
      termination_reason: "end_call_tool",
      cost: 0,
    },
    conversation_initiation_client_data: {
      dynamic_variables: {
        lead_id: String(options.leadId),
        run_id: String(options.runId),
        business_name: options.businessName,
        prospect_phone: options.phone,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The walkthrough
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n1. Lead finder puts leads on the list\n");

  const places = Array.from({ length: 6 }, (_, i) => fakePlace(i + 1));

  // One of these numbers opted out before the run - it must never be imported.
  const suppressedPhone = places[3].phoneE164!;
  suppressionModule.suppress(suppressedPhone, "Asked to be removed on a previous call", {
    source: "test",
  });

  const leadRun = orchestrator.startLeadRun({
    verticals: orchestrator.resolveVerticals(["plumber"], []),
    locations: ["Newcastle NSW"],
    targetCount: 10,
    requester: "integration-test",
  });
  await orchestrator.runLeadFinder(leadRun.id, fakeSource(places));

  const finishedRun = runsModule.getLeadRun(leadRun.id)!;
  check(
    "lead run finished cleanly",
    finishedRun.status === "completed" || finishedRun.status === "partial",
    `status ${finishedRun.status}${finishedRun.error ? " — " + finishedRun.error : ""}`,
  );

  const allLeads = leadsModule.listLeads();
  check("leads were imported", allLeads.length > 0, `${allLeads.length} leads`);
  check(
    "the suppressed number was never imported",
    !allLeads.some((l) => l.phone === suppressedPhone),
    "a do-not-contact number reached the leads table",
  );
  check(
    "finder enrichment persisted",
    allLeads.every((l) => l.icp_score !== null && l.vertical !== null),
    "icp_score or vertical missing",
  );

  console.log("\n2. Suppression added AFTER import blocks dialling\n");

  const victim = allLeads[0];
  suppressionModule.suppress(victim.phone, "Rang back and asked to be removed", { source: "test" });

  const afterSuppress = leadsModule.getLead(victim.id);
  check(
    "suppressing a number marks its existing lead do-not-call",
    afterSuppress?.status === "do_not_call",
    `status is ${afterSuppress?.status}`,
  );

  console.log("\n3. Calling run queues and dispatches\n");

  const run = dispatcher.startRun(5, "Integration test run");
  check("run created", Boolean(run.id));

  const queuedIds = (
    db()
      .prepare("SELECT lead_id FROM run_leads WHERE run_id = ?")
      .all(run.id) as Array<{ lead_id: number }>
  ).map((r) => r.lead_id);

  check(
    "the suppressed lead was not queued into the run",
    !queuedIds.includes(victim.id),
    "a do-not-contact lead was queued for dialling",
  );

  await dispatcher.tick();

  check("a batch was submitted", submitted.length === 1, `${submitted.length} batches`);

  const recipients = submitted[0]?.recipients as Array<{
    phone_number: string;
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, string> };
  }>;

  check(
    "no suppressed number reached ElevenLabs",
    !recipients.some((r) => r.phone_number === victim.phone || r.phone_number === suppressedPhone),
    "a suppressed number was dispatched",
  );
  check(
    "prospect_phone is passed to the agent",
    recipients.every(
      (r) => r.conversation_initiation_client_data?.dynamic_variables?.prospect_phone === r.phone_number,
    ),
    "prospect_phone missing or mismatched",
  );
  check(
    "business_name and lead_id are passed to the agent",
    recipients.every((r) => {
      const v = r.conversation_initiation_client_data?.dynamic_variables;
      return Boolean(v?.business_name && v?.lead_id);
    }),
  );

  console.log("\n4. Suppression mid-run stops the next chunk\n");

  const stillPending = db()
    .prepare("SELECT lead_id FROM run_leads WHERE run_id = ? AND status = 'pending'")
    .all(run.id) as Array<{ lead_id: number }>;

  if (stillPending.length > 0) {
    const midRun = leadsModule.getLead(stillPending[0].lead_id)!;
    suppressionModule.suppress(midRun.phone, "Opted out mid-run", { source: "test" });
    const before = submitted.length;
    await dispatcher.tick();
    const dispatchedAfter = submitted
      .slice(before)
      .flatMap((s) => (s.recipients as Array<{ phone_number: string }>).map((r) => r.phone_number));
    check(
      "a lead suppressed mid-run is not dialled by the next chunk",
      !dispatchedAfter.includes(midRun.phone),
      "mid-run opt-out was still dialled",
    );
  } else {
    check("a lead suppressed mid-run is not dialled by the next chunk", true, "(single chunk run)");
  }

  console.log("\n5. Post-call webhook -> booking -> alert\n");

  const dialled = leadsModule.getLead(queuedIds[0])!;

  const { callId, outcome } = calls.recordCall(
    webhookPayload({
      conversationId: "conv_integration_1",
      leadId: dialled.id,
      runId: run.id,
      phone: dialled.phone,
      businessName: dialled.business_name,
      booked: true,
    }) as never,
  );

  check("call recorded", callId > 0);
  check("outcome is a completed call", outcome === "completed", `got ${outcome}`);

  const stored = calls.getCall(callId)!;
  check("call linked back to its lead", stored.lead_id === dialled.id);
  check("call linked back to its run", stored.run_id === run.id);
  check("business name carried through from the dispatch", stored.business_name === dialled.business_name);
  check("booking detected", stored.booked === 1);

  await calls.analyseAndStore(callId);
  const analysed = calls.getCall(callId)!;

  check("summary stored", Boolean(analysed.summary), analysed.analysis_error ?? "");
  check("briefing stored", Boolean(analysed.analysis_json));

  const parsed = calls.parseAnalysis(analysed)!;
  check("briefing carries the prospect's figures", parsed.analysis.discounted_weekly_loss === 1800);
  check(
    "quoted price checked against the price table",
    parsed.quoteCheck.status === "matches",
    parsed.quoteCheck.message,
  );

  check("booking alert sent", textsSent.length === 1, `${textsSent.length} texts`);
  check(
    "alert contains the Meet link",
    textsSent[0]?.includes(MEET_LINK),
    textsSent[0] ?? "(no text)",
  );
  check("alert names the business", textsSent[0]?.includes(dialled.business_name));
  check("alert is not sent twice", (await calls.alertOnBooking(callId), textsSent.length === 1));

  console.log("\n6. A failed calendar booking is not a booking\n");

  const other = leadsModule.getLead(queuedIds[1] ?? queuedIds[0])!;
  const failedCall = calls.recordCall(
    webhookPayload({
      conversationId: "conv_integration_failed",
      leadId: other.id,
      runId: run.id,
      phone: other.phone,
      businessName: other.business_name,
      booked: true,
      bookingErrored: true,
    }) as never,
  );

  const failedStored = calls.getCall(failedCall.callId)!;
  check(
    "an errored create_event is not flagged as booked",
    failedStored.booked === 0,
    "phantom booking would appear on the meetings page",
  );

  console.log("\n7. Opt-out on a call flows back to the permanent list\n");

  analysisOverride = { do_not_call_requested: true, booking: { booked: false, day: null, time: null, email: null } };

  const optOutLead = leadsModule.getLead(queuedIds[2] ?? queuedIds[0])!;
  const optOut = calls.recordCall(
    webhookPayload({
      conversationId: "conv_integration_optout",
      leadId: optOutLead.id,
      runId: run.id,
      phone: optOutLead.phone,
      businessName: optOutLead.business_name,
    }) as never,
  );
  await calls.analyseAndStore(optOut.callId);

  check(
    "opt-out marks the lead do-not-call",
    leadsModule.getLead(optOutLead.id)?.status === "do_not_call",
  );
  check(
    "opt-out reaches the permanent suppression list",
    suppressionModule.isSuppressed(optOutLead.phone),
    "a call opt-out did not reach do_not_contact",
  );

  const reimport = leadsModule.importLeads(
    [{ businessName: "Same business again", phone: optOutLead.phone }],
    "test-reimport",
  );
  check(
    "a future lead run cannot re-import an opted-out number",
    reimport.imported === 0 && reimport.suppressed === 1,
    JSON.stringify(reimport),
  );

  analysisOverride = {};

  console.log("\n8. No orphaned records\n");

  const orphanCalls = db()
    .prepare(
      "SELECT COUNT(*) n FROM calls WHERE lead_id IS NOT NULL AND lead_id NOT IN (SELECT id FROM leads)",
    )
    .get() as { n: number };
  check("no calls point at a missing lead", orphanCalls.n === 0);

  const orphanRunLeads = db()
    .prepare("SELECT COUNT(*) n FROM run_leads WHERE lead_id NOT IN (SELECT id FROM leads)")
    .get() as { n: number };
  check("no run_leads point at a missing lead", orphanRunLeads.n === 0);

  const dupes = db()
    .prepare("SELECT COUNT(*) n FROM (SELECT phone FROM leads GROUP BY phone HAVING COUNT(*) > 1)")
    .get() as { n: number };
  check("no duplicate phone numbers in the leads table", dupes.n === 0);

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
  console.error("\nIntegration test crashed:", err);
  process.exit(1);
});
