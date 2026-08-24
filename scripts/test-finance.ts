/**
 * Tests for Stripe reconciliation (read-only) and weekly finance (Segment 4).
 *
 * Run with:  npm run test:finance
 *
 * No real network: global fetch is stubbed to return a fixed Stripe-shaped
 * payload, same pattern test-integration.ts uses for ElevenLabs/Twilio/SMS.
 * No API key, no spend. Uses its own scratch database.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `finance-test-${process.pid}.db`);

process.env.DATABASE_PATH = SCRATCH;
process.env.USD_AUD_RATE = "1.5";
delete process.env.ELEVENLABS_PLAN_MONTHLY_USD; // use the real default, 24.20
delete process.env.RAILWAY_MONTHLY_USD; // use the real default, 0
delete process.env.STRIPE_SECRET_KEY;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const stripe = require("../src/lib/stripe") as typeof import("../src/lib/stripe");
const finance = require("../src/lib/finance") as typeof import("../src/lib/finance");
const deals = require("../src/lib/deals") as typeof import("../src/lib/deals");

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

function close(name: string, actual: number, expected: number, tolerance = 0.01) {
  const ok = Math.abs(actual - expected) <= tolerance;
  check(name, ok, ok ? "" : `got ${actual}, wanted ~${expected}`);
}

async function main() {
  console.log("\n1. stripeConfigured / fetch without a key\n");

  check("not configured without STRIPE_SECRET_KEY", !stripe.stripeConfigured());
  const noKeyPayments = await stripe.fetchRecentPayments();
  equal("fetch returns empty, not an error, without a key", noKeyPayments, []);

  console.log("\n2. Parsing a Stripe charge list\n");

  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  check("configured once the key is set", stripe.stripeConfigured());

  const originalFetch = global.fetch;
  const chargeCreated = Math.floor(Date.now() / 1000) - 3600;

  global.fetch = (async () => {
    const body = {
      data: [
        { id: "ch_1", amount: 220000, currency: "aud", created: chargeCreated, paid: true, status: "succeeded", refunded: false, description: "Setup fee" },
        { id: "ch_2", amount: 50000, currency: "usd", created: chargeCreated, paid: true, status: "succeeded", refunded: false, description: null },
        // Should all be filtered out:
        { id: "ch_3", amount: 99999, currency: "aud", created: chargeCreated, paid: false, status: "pending", refunded: false },
        { id: "ch_4", amount: 88888, currency: "aud", created: chargeCreated, paid: true, status: "succeeded", refunded: true },
        { id: "ch_5", amount: 77777, currency: "aud", created: chargeCreated, paid: true, status: "failed", refunded: false },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const payments = await stripe.fetchRecentPayments();
  equal("only genuinely succeeded, unrefunded charges come through", payments.length, 2);
  close("cents converted to real dollars", payments[0].amount, 2200, 0.001);
  equal("currency upper-cased", payments[0].currency, "AUD");
  equal("a currency in a different case is still read", payments[1].currency, "USD");

  console.log("\n3. Won-deal reconciliation matches by amount, claims each payment once\n");

  const now = Date.now();
  const wonDeals = [
    { call_id: 1, agreed_setup_fee: 2200, agreed_monthly_retainer: 0, recorded_at: now - 1000 },
    { call_id: 2, agreed_setup_fee: 500, agreed_monthly_retainer: 0, recorded_at: now - 1000 },
    { call_id: 3, agreed_setup_fee: 2200, agreed_monthly_retainer: 0, recorded_at: now - 1000 }, // same amount as deal 1
  ];

  const reconciled = await stripe.reconcileWonDeals(wonDeals);
  check("reconciliation reports configured", reconciled.configured);
  const byCall = new Map(reconciled.deals.map((d) => [d.callId, d]));
  check("the $2,200 deal matches the $2,200 AUD charge", byCall.get(1)?.matched?.id === "ch_1");
  check("the $500 deal has no matching payment", byCall.get(2)?.matched === null);
  check(
    "a second deal at the same amount does NOT double-claim the already-matched payment",
    byCall.get(3)?.matched === null,
  );
  check(
    "the USD charge (converted, no matching deal amount) surfaces as unmatched",
    reconciled.unmatchedPayments.some((p) => p.id === "ch_2"),
  );

  console.log("\n4. Reconciliation with no key returns an honest empty result\n");

  delete process.env.STRIPE_SECRET_KEY;
  const unconfigured = await stripe.reconcileWonDeals(wonDeals);
  equal("not configured", unconfigured.configured, false);
  equal("no deals reported rather than guessed at", unconfigured.deals, []);

  global.fetch = originalFetch;

  console.log("\n5. Revenue falls back to recorded deals when Stripe isn't configured\n");

  const database = db();
  // A Won deal recorded inside the last 7 days.
  database.prepare(`INSERT INTO calls (conversation_id, booked, created_at) VALUES (?, 1, ?)`).run("conv_fin_1", now);
  const callRow = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_fin_1") as { id: number };
  deals.recordWon(callRow.id, 1200, 500);

  // A Won deal recorded outside the window — must not leak into "this week".
  const fortyDaysAgo = now - 40 * 86_400_000;
  database.prepare(`INSERT INTO calls (conversation_id, booked, created_at) VALUES (?, 1, ?)`).run("conv_fin_2", fortyDaysAgo);
  const oldCall = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_fin_2") as { id: number };
  deals.recordWon(oldCall.id, 9999, 9999);
  database.prepare(`UPDATE deals SET recorded_at = ? WHERE call_id = ?`).run(fortyDaysAgo, oldCall.id);

  const week = await finance.thisWeek();
  equal("revenue provenance is 'recorded' without Stripe", week.revenueProvenance, "recorded");
  equal("only the in-window deal's price counts", week.revenueAud, 1700);

  console.log("\n6. Cost never double-counts the ElevenLabs plan fee\n");

  // A call inside the window with a real fiat cost. Per the "measured cost"
  // rule, this must NOT be summed directly — only Twilio/Anthropic/lead-sourcing
  // are, with ElevenLabs' own subscription covered by the prorated plan line.
  database
    .prepare(
      `INSERT INTO calls (conversation_id, booked, created_at, cost_fiat_usd, twilio_call_sid, twilio_price, twilio_price_unit)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    )
    .run("conv_fin_3", now, 0.5, "CA_fin", 0.2, "USD");

  const week2 = await finance.thisWeek();
  // Expected cost = prorated (24.20 ElevenLabs default + 0 Railway default) over
  // 7/30.44 days, in AUD at 1.5, PLUS the $0.20 USD Twilio charge in AUD — and
  // NOT the call's $0.50 cost_fiat_usd.
  const expectedProrated = 24.2 * (7 / 30.44) * 1.5;
  const expectedTwilio = 0.2 * 1.5;
  close("cost is prorated subscription + real Twilio/Anthropic/lead spend, not the call's own fiat cost", week2.costAud, expectedProrated + expectedTwilio, 0.05);

  console.log("\n7. Reinvestment scenarios\n");

  const scenarios = finance.reinvestmentScenarios(1000);
  equal("11 presets, 0 to 100 in steps of 10", scenarios.length, 11);
  const half = scenarios.find((s) => s.pct === 50)!;
  equal("50% splits evenly", half.reinvestAud, 500);
  equal("the draw is the complement", half.drawAud, 500);

  const negativeProfit = finance.reinvestmentScenarios(-400);
  check("a negative profit has nothing to split, not a negative reinvestment", negativeProfit.every((s) => s.reinvestAud === 0 && s.drawAud === 0));

  console.log("\n8. financeSeries returns the right number of windows, oldest first\n");

  const series = await finance.financeSeries(4);
  equal("4 weeks returned", series.length, 4);
  check("windows are chronological, oldest first", series[0].windowStart < series[3].windowStart);
  check("the last window ends now-ish", Math.abs(series[3].windowEnd - Date.now()) < 5000);

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
  console.error("\nFinance test crashed:", err);
  process.exit(1);
});
