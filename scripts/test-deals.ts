/**
 * Tests for demo-outcome tracking (Segment 2) and the conversion funnel
 * (Segment 1).
 *
 * Run with:  npm run test:deals
 *
 * No API key, no network. Uses its own scratch database, seeded with calls
 * directly (bypassing the webhook path, which is already covered end-to-end
 * by test:integration).
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `deals-test-${process.pid}.db`);

process.env.DATABASE_PATH = SCRATCH;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const deals = require("../src/lib/deals") as typeof import("../src/lib/deals");
const funnel = require("../src/lib/funnel") as typeof import("../src/lib/funnel");

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

let nextCallId = 0;
function seedCall(opts: { outcome: string; booked?: boolean }): number {
  nextCallId++;
  const conversationId = `conv_deals_test_${nextCallId}`;
  db()
    .prepare(
      `INSERT INTO calls (conversation_id, outcome, booked, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, opts.outcome, opts.booked ? 1 : 0, Date.now());
  return (db().prepare("SELECT id FROM calls WHERE conversation_id = ?").get(conversationId) as { id: number })
    .id;
}

console.log("\n1. isLostReason\n");

check("a valid reason is recognised", deals.isLostReason("price_too_high"));
check("an invalid reason is rejected", !deals.isLostReason("made_up_reason"));

console.log("\n2. Recording and reading a deal\n");

const wonCall = seedCall({ outcome: "completed", booked: true });
check("no deal exists yet", deals.getDeal(wonCall) === null);

deals.recordWon(wonCall, 2200, 800);
const won = deals.getDeal(wonCall)!;
check("won deal recorded", won !== null);
equal("won status", won.status, "won");
equal("won setup fee", won.agreed_setup_fee, 2200);
equal("won retainer", won.agreed_monthly_retainer, 800);
check("won deal carries no lost reason", won.lost_reason === null);

const lostCall = seedCall({ outcome: "completed", booked: true });
deals.recordLost(lostCall, "price_too_high", null);
const lost = deals.getDeal(lostCall)!;
equal("lost status", lost.status, "lost");
equal("lost reason", lost.lost_reason, "price_too_high");
check("lost deal carries no agreed price", lost.agreed_setup_fee === null && lost.agreed_monthly_retainer === null);

console.log("\n3. Correcting a recorded outcome overwrites, not accumulates\n");

deals.recordWon(lostCall, 1200, 500);
const corrected = deals.getDeal(lostCall)!;
equal("status flipped to won", corrected.status, "won");
check("lost reason cleared on correction", corrected.lost_reason === null);
check("still exactly one deal row for this call", (db().prepare("SELECT COUNT(*) n FROM deals WHERE call_id = ?").get(lostCall) as { n: number }).n === 1);

console.log("\n4. dealStats\n");

// Reset to a clean slate for exact-count assertions.
db().exec("DELETE FROM deals");
db().exec("DELETE FROM calls");
nextCallId = 0;

const pendingBooked = seedCall({ outcome: "completed", booked: true });
seedCall({ outcome: "completed", booked: true }); // becomes won below
seedCall({ outcome: "completed", booked: true }); // becomes lost below
seedCall({ outcome: "hung_up_early", booked: false }); // not booked, irrelevant to deal stats

const ids = db().prepare("SELECT id FROM calls WHERE booked = 1 ORDER BY id").all() as Array<{ id: number }>;
deals.recordWon(ids[1].id, 3800, 1300);
deals.recordLost(ids[2].id, "other", "Went with an in-house receptionist instead.");

const stats = deals.dealStats();
equal("booked total", stats.bookedTotal, 3);
equal("won count", stats.won, 1);
equal("lost count", stats.lost, 1);
equal("pending count", stats.pending, 1);
equal("won revenue setup", stats.wonRevenue.setupFees, 3800);
equal("won revenue retainer", stats.wonRevenue.monthlyRetainers, 1300);
equal("lost-by-reason breakdown", stats.lostByReason, { other: 1 });
check("the untouched booked call is the pending one", stats.pending === 1 && deals.getDeal(pendingBooked) === null);

console.log("\n5. getDealsByCallIds\n");

const map = deals.getDealsByCallIds([ids[0].id, ids[1].id, ids[2].id]);
check("map has no entry for the pending call", !map.has(ids[0].id));
check("map has an entry for the won call", map.get(ids[1].id)?.status === "won");
check("empty id list returns an empty map without querying", deals.getDealsByCallIds([]).size === 0);

console.log("\n6. Conversion funnel\n");

db().exec("DELETE FROM deals");
db().exec("DELETE FROM calls");
nextCallId = 0;

// 11 dialled: 2 no_answer, 1 voicemail, 1 failed (none answered),
// 7 answered (2 hung_up_early, 2 connected, 3 completed), of which 3 booked.
seedCall({ outcome: "no_answer" });
seedCall({ outcome: "no_answer" });
seedCall({ outcome: "voicemail" });
seedCall({ outcome: "failed" });
seedCall({ outcome: "hung_up_early" });
seedCall({ outcome: "hung_up_early" });
seedCall({ outcome: "connected" });
seedCall({ outcome: "connected", booked: false });
const bookedA = seedCall({ outcome: "completed", booked: true });
const bookedB = seedCall({ outcome: "completed", booked: true });
const bookedC = seedCall({ outcome: "completed", booked: true });

deals.recordWon(bookedA, 1200, 500);
deals.recordLost(bookedB, "bad_timing", null);
void bookedC; // left pending on purpose

const f = funnel.conversionFunnel();
equal("dialled", f.dialled, 11);
equal("answered", f.answered, 7);
equal("booked", f.booked, 3);
equal("won via deals", f.deals.won, 1);
equal("lost via deals", f.deals.lost, 1);
equal("pending via deals", f.deals.pending, 1);

console.log("\n7. pct()\n");

equal("half is 50%", funnel.pct(3, 6), 50);
equal("rounds to one decimal", funnel.pct(1, 3), 33.3);
check("dividing by zero returns null, not a fake 0%", funnel.pct(0, 0) === null);
check("zero of a real total is a real 0%, not null", funnel.pct(0, 10) === 0);

console.log(`\n${passed} passed, ${failed} failed\n`);

try {
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-wal`, { force: true });
  rmSync(`${SCRATCH}-shm`, { force: true });
} catch {
  // A leftover scratch file is not worth failing the run over.
}

process.exit(failed === 0 ? 0 : 1);
