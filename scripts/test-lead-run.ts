/**
 * End-to-end test of a whole lead run — offline.
 *
 * Run with:  npm run test:run
 *
 * This drives the REAL orchestrator against a fake lead source, so it exercises
 * the parts no unit test reaches: pagination, the target-reached stop, the
 * cost ceiling, dedup across pages, suppression, the partial-result path, and
 * the cost ledger adding up.
 *
 * No API key, no network, no spend. Which is the point — if the plumbing is
 * broken, we find out here rather than halfway through a paid run.
 *
 * Uses its own scratch database, never data/dashboard.db.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `run-test-${process.pid}.db`);
process.env.DATABASE_PATH = SCRATCH;
// Keep the guards at known values regardless of what's in .env.
process.env.MAX_LEADS_PER_RUN = "200";
process.env.MAX_COST_PER_RUN_AUD = "25";
process.env.USD_AUD_RATE = "1.55";
// No ABN guid, so the ABN client short-circuits and never touches the network.
delete process.env.ABN_LOOKUP_GUID;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const { suppress } = require("../src/lib/suppression") as typeof import("../src/lib/suppression");
const orchestrator = require("../src/lib/lead-finder/orchestrator") as typeof import("../src/lib/lead-finder/orchestrator");
const runsModule = require("../src/lib/lead-finder/runs") as typeof import("../src/lib/lead-finder/runs");
const { verticalById } = require("../src/lib/lead-finder/icp") as typeof import("../src/lib/lead-finder/icp");
const { unitCostUsd } = require("../src/lib/lead-finder/cost") as typeof import("../src/lib/lead-finder/cost");
const { summariseHours } = require("../src/lib/lead-finder/hours") as typeof import("../src/lib/lead-finder/hours");

type PlaceResult = import("../src/lib/lead-finder/places").PlaceResult;
type LeadSource = import("../src/lib/lead-finder/source").LeadSource;

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

/** A believable Google result. Good enough to pass the ICP filter by default. */
function fakePlace(index: number, overrides: Partial<PlaceResult> = {}): PlaceResult {
  const suffix = String(index).padStart(4, "0");
  return {
    placeId: `place-${suffix}`,
    name: `Test Plumbing ${suffix}`,
    address: `${index} Test St, Parramatta NSW 2150, Australia`,
    // +61 followed by exactly 9 digits — a real NSW landline shape (02 xxxx
    // xxxx). Anything shorter is refused by the phone guard, which is correct
    // but makes for a confusing test failure.
    phoneE164: `+612${suffix}${suffix}`,
    phoneKind: "landline",
    website: `https://test${suffix}.com.au`,
    rating: 4.5,
    reviewCount: 90,
    businessStatus: "OPERATIONAL",
    primaryType: "plumber",
    types: ["plumber"],
    hours: summariseHours({
      periods: [1, 2, 3, 4, 5].map((day) => ({
        open: { day, hour: 8, minute: 0 },
        close: { day, hour: 16, minute: 0 },
      })),
    }),
    suburb: "Parramatta",
    state: "NSW",
    ...overrides,
  };
}

/**
 * A fake source with 20 results per page and two pages per query, mirroring
 * Google's real shape. Counts its own calls so we can assert on them.
 */
function makeSource(options: {
  pagesPerQuery?: number;
  perPage?: number;
  place?: (index: number) => PlaceResult;
} = {}): LeadSource & { calls: number } {
  const pagesPerQuery = options.pagesPerQuery ?? 2;
  const perPage = options.perPage ?? 20;
  let counter = 0;

  const source = {
    id: "fake_source",
    label: "Fake",
    calls: 0,
    async search(request: { pageToken?: string; onCall: (r: never) => void }) {
      source.calls++;
      const page = request.pageToken ? Number(request.pageToken) : 1;

      // Report the cost exactly as the real source would, so the ledger is
      // exercised for real.
      request.onCall({
        sku: "text_search_enterprise",
        detail: "fake",
        httpStatus: 200,
        resultCount: perPage,
        unitCostUsd: unitCostUsd("text_search_enterprise"),
      } as never);

      const results = Array.from({ length: perPage }, () =>
        options.place ? options.place(counter++) : fakePlace(counter++),
      );

      return {
        results,
        nextPageToken: page < pagesPerQuery ? String(page + 1) : undefined,
      };
    },
  };

  return source as unknown as LeadSource & { calls: number };
}

const PLUMBER = verticalById("plumber")!;

function queueRun(targetCount: number, locations = ["Parramatta NSW"]) {
  return orchestrator.startLeadRun({
    verticals: [PLUMBER],
    locations,
    targetCount,
    requester: "test",
  });
}

async function main() {
  console.log("\nLead run, end to end (offline)\n" + "=".repeat(72));

  // --- A run that reaches its target ---------------------------------------
  console.log("\nA run that finds what it was asked for");

  const source = makeSource();
  const run = queueRun(25);
  await orchestrator.runLeadFinder(run.id, source);

  const finished = runsModule.getLeadRun(run.id)!;
  equal("Status is completed", finished.status, "completed");
  equal("Found exactly the number asked for", finished.leads_found, 25);
  check(
    "Stopped as soon as it had enough rather than draining every page",
    source.calls <= 3,
    `made ${source.calls} calls`,
  );

  const summary = runsModule.leadRunSummary(run.id)!;
  equal("Every call is on the ledger", summary.apiCalls, source.calls);
  equal(
    "Cost is the call count times the real unit price",
    summary.costUsd,
    Math.round(source.calls * unitCostUsd("text_search_enterprise") * 100) / 100,
  );
  check("Cost is reported in AUD too", summary.costAud >= summary.costUsd);
  check("The breakdown names the SKU", summary.breakdown[0].sku === "text_search_enterprise");

  const stored = db()
    .prepare("SELECT COUNT(*) AS n FROM leads WHERE lead_run_id = ?")
    .get(run.id) as { n: number };
  equal("The leads actually landed in the table", stored.n, 25);

  const sample = db()
    .prepare("SELECT * FROM leads WHERE lead_run_id = ? LIMIT 1")
    .get(run.id) as Record<string, unknown> | undefined;

  if (!sample) {
    check("A lead was stored to inspect", false, "no rows imported — later checks skipped");
  } else {
  check("Leads carry their ICP score", typeof sample.icp_score === "number");
  check("Leads carry the reasons behind the score", typeof sample.icp_reasons === "string");
  check("Leads carry the Google place id", typeof sample.source_place_id === "string");
  check("Leads are attributed to the lead finder", sample.source === "AI lead finder");
  check("Leads carry a compliance source record", typeof sample.source_record === "string");

  const record = JSON.parse(sample.source_record as string) as Record<string, unknown>;
  check("…which says where the number came from", typeof record.published_as === "string");
  check("…and why it's lawful to ring", typeof record.basis === "string");
  }

  // --- Dedup across a second run -------------------------------------------
  console.log("\nA second run over the same ground");

  const source2 = makeSource();
  const run2 = queueRun(25);
  await orchestrator.runLeadFinder(run2.id, source2);
  const finished2 = runsModule.getLeadRun(run2.id)!;

  check(
    "The same businesses are recognised as duplicates",
    finished2.duplicates_skipped > 0,
    `skipped ${finished2.duplicates_skipped}`,
  );
  const total = db().prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number };
  check(
    "No business was imported twice",
    total.n === 25 + finished2.leads_found,
    `${total.n} leads for 25 + ${finished2.leads_found}`,
  );

  // --- Suppression is honoured mid-run -------------------------------------
  console.log("\nSuppression during a run");

  // Suppress a number the source is about to return.
  const target = fakePlace(9000);
  suppress(target.phoneE164!, "Test opt-out", { source: "test" });

  const source3 = makeSource({
    perPage: 5,
    pagesPerQuery: 1,
    place: (i) => (i === 0 ? target : fakePlace(9001 + i)),
  });
  const run3 = queueRun(5);
  await orchestrator.runLeadFinder(run3.id, source3);
  const finished3 = runsModule.getLeadRun(run3.id)!;

  check(
    "A suppressed number is counted and skipped",
    finished3.suppressed_skipped >= 1,
    `counted ${finished3.suppressed_skipped}`,
  );
  check(
    "…and never reaches the leads table",
    !db().prepare("SELECT 1 FROM leads WHERE phone = ?").get(target.phoneE164!),
  );

  // --- Quality filtering ---------------------------------------------------
  console.log("\nQuality filtering");

  const source4 = makeSource({
    perPage: 4,
    pagesPerQuery: 1,
    place: (i) =>
      [
        fakePlace(7000, { businessStatus: "CLOSED_PERMANENTLY" }),
        fakePlace(7001, { phoneE164: undefined }),
        // Bare mobile, nothing to corroborate it — the personal-number guard.
        fakePlace(7002, {
          phoneE164: "+61412000111",
          phoneKind: "mobile",
          website: undefined,
          primaryType: undefined,
        }),
        fakePlace(7003),
      ][i % 4],
  });
  const run4 = queueRun(4);
  await orchestrator.runLeadFinder(run4.id, source4);
  const finished4 = runsModule.getLeadRun(run4.id)!;

  equal("Only the one good business was imported", finished4.leads_found, 1);
  check("The other three were filtered out", finished4.rejected_skipped >= 3);
  check(
    "The unbacked mobile is not in the table",
    !db().prepare("SELECT 1 FROM leads WHERE phone = ?").get("+61412000111"),
  );
  equal("A run that runs out of coverage is marked partial", finished4.status, "partial");
  check(
    "…and says so in plain English",
    (finished4.error ?? "").includes("of the 4"),
    finished4.error ?? "(no message)",
  );

  // --- Guards --------------------------------------------------------------
  console.log("\nGuards");

  let refused = "";
  try {
    queueRun(5000);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check("A run over MAX_LEADS_PER_RUN is refused", refused.includes("200-lead cap"), refused);

  const live = queueRun(5);
  let secondRun = "";
  try {
    queueRun(5);
  } catch (err) {
    secondRun = err instanceof Error ? err.message : String(err);
  }
  check("Two runs can't go at once", secondRun.includes("already going"), secondRun);

  orchestrator.cancelLeadRun(live.id);
  equal("A cancelled run is marked cancelled", runsModule.getLeadRun(live.id)!.status, "cancelled");

  // A cancelled run must not keep spending if a worker is still mid-flight.
  const source5 = makeSource();
  await orchestrator.runLeadFinder(live.id, source5);
  equal("A cancelled run does no further work", source5.calls, 0);

  // --- Cleanup -------------------------------------------------------------
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(SCRATCH + suffix, { force: true });
    } catch {
      /* Windows may hold the handle briefly; harmless */
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
