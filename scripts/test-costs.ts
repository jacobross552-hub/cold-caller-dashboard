/**
 * Tests for the cost accounting.
 *
 * Run with:  npm run test:costs
 *
 * The thing under test is not really the arithmetic — it's the honesty rules.
 * A costs page that quietly invents a figure is worse than no costs page, so
 * most of what's checked here is that unpriced things stay unpriced, that
 * credits are never mistaken for money, that pool-included usage never counts
 * as cash, and that a total which omits something says so.
 *
 * No API key, no network, no spend. Uses its own scratch database. Twilio is
 * left unconfigured throughout (no TWILIO_ACCOUNT_SID/AUTH_TOKEN), so the
 * number-rental line never attempts a live API call.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `costs-test-${process.pid}.db`);

// Must be set before any module is required — config is read at load time.
process.env.DATABASE_PATH = SCRATCH;
process.env.USD_AUD_RATE = "1.55";
// Start with every configurable rate UNSET, so the default state under test is
// the current real defaults (plan fee priced, hosting a real zero) rather than
// anything typed in.
delete process.env.ELEVENLABS_PLAN_MONTHLY_USD;
delete process.env.ELEVENLABS_INCLUDED_LLM_USD_PER_MONTH;
delete process.env.RAILWAY_MONTHLY_USD;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.COSTS_SINCE;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const costs = require("../src/lib/costs") as typeof import("../src/lib/costs");

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

function close(name: string, actual: number, expected: number, tolerance = 0.005) {
  const ok = Math.abs(actual - expected) <= tolerance;
  check(name, ok, ok ? "" : `got ${actual}, wanted ~${expected}`);
}

function line(breakdown: import("../src/lib/costs").CostBreakdown, key: string) {
  const found = breakdown.lines.find((l) => l.key === key);
  if (!found) throw new Error(`no cost line called "${key}"`);
  return found;
}

/**
 * A real ElevenLabs post-call payload, trimmed to the fields that matter and
 * with invented ids. The numbers are the shape the live webhook actually
 * sends: `cost` in CREDITS, `cost_fiat` in dollars, and the two halves of
 * `charging` summing to the fiat total.
 */
function fakePayload(creditCost: number, platform: number, llm: number) {
  return {
    conversation_id: `conv_test_${creditCost}`,
    metadata: {
      call_duration_secs: 157,
      cost: creditCost,
      cost_fiat: platform + llm,
      charging: { platform_price: platform, llm_price: llm },
    },
  };
}

async function main() {
  const database = db();

  console.log("\n1. Credits are never mistaken for money\n");

  // The bug this whole feature exists to avoid: `metadata.cost` is credits.
  // A 157-second call reports 2092 of them. If that were ever read as dollars
  // the page would claim thousands of dollars of spend on three test calls.
  const payload = fakePayload(2092, 0.20708938254764175, 0.17155664999999998);
  const extracted = costs.extractCallCost(payload.metadata);

  close("cost_fiat is read as the real cost", extracted.costFiatUsd!, 0.3786);
  close("the voice half is kept separately", extracted.platformPriceUsd!, 0.2071);
  close("the agent-LLM half is kept separately", extracted.llmPriceUsd!, 0.1716);
  check(
    "the credits figure is nowhere in the extracted cost",
    extracted.costFiatUsd !== 2092 && extracted.platformPriceUsd !== 2092,
  );
  close(
    "the two halves add up to the whole",
    extracted.platformPriceUsd! + extracted.llmPriceUsd!,
    extracted.costFiatUsd!,
    0.0001,
  );

  // A payload with no cost information at all must yield null, not zero. Zero
  // would silently claim a free call.
  const empty = costs.extractCallCost({});
  equal("a payload with no cost figures gives null, not 0", empty.costFiatUsd, null);

  const legacy = costs.extractCallCost({ charging: { platform_price: 0.5, llm_price: 0.25 } });
  close("an older payload without cost_fiat still totals correctly", legacy.costFiatUsd!, 0.75);

  console.log("\n2. Anthropic token pricing\n");

  // $5/MTok in, $25/MTok out for Opus 5.
  close(
    "Opus 5 priced at list",
    costs.priceAnthropicUsage("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    30,
  );
  close(
    "Sonnet 5 priced at list",
    costs.priceAnthropicUsage("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    18,
  );
  close(
    "cache reads bill at a tenth of the input rate",
    costs.priceAnthropicUsage("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    }),
    0.5,
  );
  close(
    "cache writes bill at 1.25x the input rate",
    costs.priceAnthropicUsage("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    }),
    6.25,
  );
  close(
    "an unknown model falls back rather than pricing at zero",
    costs.priceAnthropicUsage("claude-something-unreleased", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    }),
    5,
  );
  equal(
    "zero tokens costs zero",
    costs.priceAnthropicUsage("claude-opus-5", { inputTokens: 0, outputTokens: 0 }),
    0,
  );

  console.log("\n3. Defaults price the real subscription, even with zero activity\n");

  const empty0 = await costs.lifetimeCosts();
  // The ElevenLabs plan fee is a real bill you pay whether you dial or not —
  // it must price from its default, not sit at "not set".
  close("the ElevenLabs plan fee prices from its default", line(empty0, "elevenlabs_plan").aud!, 24.2 * 1.55, 0.05);
  // Railway's default is a genuine configured zero (one-time trial credit, no
  // card on file) — distinct from "we don't know", which would render as null.
  equal("hosting defaults to a real configured zero, not unset", line(empty0, "railway").aud, 0);
  equal("Twilio call minutes are unpriced with no calls, not free", line(empty0, "twilio_voice").aud, null);
  equal("Twilio SMS is unpriced with no sends, not free", line(empty0, "twilio_sms").aud, null);
  equal(
    "Twilio number rental is unpriced without Twilio credentials",
    line(empty0, "twilio_number").aud,
    null,
  );
  check("the total is flagged incomplete because the Twilio lines are unpriced", empty0.incomplete);
  check(
    "the agent's own LLM usage is pool-included, not cash, until the allowance is known",
    line(empty0, "elevenlabs_llm").excludedFromTotal === true && line(empty0, "elevenlabs_llm").aud === null,
  );
  check(
    "the ABN line is a genuine zero, not a missing one",
    line(empty0, "abn_lookup").aud === 0 && !line(empty0, "abn_lookup").missing,
  );

  console.log("\n4. Real call costs feed the pool and stay separate from cash spend\n");

  const now = Date.now();
  const insertCall = database.prepare(
    `INSERT INTO calls (conversation_id, business_name, phone, started_at, duration_secs,
                        outcome, cost, booked, created_at,
                        cost_fiat_usd, platform_price_usd, llm_price_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Three short calls, well inside the 275-minute included pool.
  insertCall.run("conv_a", "A Plumbing", "+61400000001", now, 157, "completed", 2092, 1, now, 0.3786, 0.2071, 0.1715);
  insertCall.run("conv_b", "B Electrical", "+61400000002", now, 155, "completed", 2281, 0, now, 0.4133, 0.2063, 0.207);
  insertCall.run("conv_c", "C Roofing", "+61400000003", now, 167, "completed", 2555, 0, now, 0.4633, 0.2216, 0.2417);

  const withCalls = await costs.lifetimeCosts();
  close(
    "under 8 minutes of calls stays inside the 275-minute pool, so no overage bills",
    line(withCalls, "elevenlabs_voice").aud!,
    0,
    0.01,
  );
  close(
    "the pool's metered value is still visible on its own line",
    line(withCalls, "elevenlabs_voice_pool").native!.amount,
    0.2071 + 0.2063 + 0.2216,
    0.005,
  );
  check("pool value never counts as cash", line(withCalls, "elevenlabs_voice_pool").aud === null);
  check(
    "the total only grew by the (unchanged) plan fee, not by in-pool minutes",
    Math.abs(withCalls.totalAud - empty0.totalAud) < 0.02,
  );

  database
    .prepare(
      `INSERT INTO ai_usage (call_id, purpose, model, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(null, "call_analysis", "claude-opus-5", 20_000, 2_000, 0, 0, 0.15, now);

  const withAi = await costs.lifetimeCosts();
  close("the dashboard's own Anthropic spend appears as cash", line(withAi, "anthropic").aud!, 0.15 * 1.55, 0.01);
  check(
    "the two LLM bills stay separate — dashboard summaries vs the agent's own model",
    line(withAi, "anthropic").aud !== line(withAi, "elevenlabs_llm").aud,
  );

  console.log("\n5. The agent's own LLM usage becomes real cash once the allowance is known\n");

  process.env.ELEVENLABS_INCLUDED_LLM_USD_PER_MONTH = "50";
  const withLlmKnown = await costs.lifetimeCosts();
  close(
    "metered LLM value converts to AUD once it's no longer assumed included",
    line(withLlmKnown, "elevenlabs_llm").aud!,
    (0.1715 + 0.207 + 0.2417) * 1.55,
    0.02,
  );
  equal("provenance flips from included to measured", line(withLlmKnown, "elevenlabs_llm").provenance, "measured");
  delete process.env.ELEVENLABS_INCLUDED_LLM_USD_PER_MONTH;

  console.log("\n6. Twilio actuals price real settled charges, never a typed rate\n");

  database
    .prepare(`UPDATE calls SET twilio_call_sid = ?, twilio_price = ?, twilio_price_unit = ? WHERE conversation_id = ?`)
    .run("CA_fake_sid", 0.15, "USD", "conv_a");

  database
    .prepare(
      `INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, price, price_unit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(null, "booking_alert", "SM_fake_sid", 2, 0.1, "USD", now);

  const withTwilio = await costs.lifetimeCosts();
  close("a settled Twilio call price converts to AUD", line(withTwilio, "twilio_voice").aud!, 0.15 * 1.55, 0.01);
  close("a settled Twilio SMS price converts to AUD", line(withTwilio, "twilio_sms").aud!, 0.1 * 1.55, 0.01);
  equal("a real charge is labelled measured, not rated", line(withTwilio, "twilio_voice").provenance, "measured");

  console.log("\n7. Subscriptions price from their defaults, or an override when set\n");

  process.env.RAILWAY_MONTHLY_USD = "8";
  const full = await costs.lifetimeCosts();
  const months = full.monthsLive;
  check("months running is at least 1", months >= 1);
  close("plan fee is monthly x months at its default", line(full, "elevenlabs_plan").aud!, 24.2 * months * 1.55, 0.05);
  close("hosting is monthly x months at the override", line(full, "railway").aud!, 8 * months * 1.55, 0.02);
  equal("subscriptions are labelled configured", line(full, "railway").provenance, "configured");
  check(
    "the total is the sum of the priced, non-pool-excluded lines",
    Math.abs(
      full.totalAud - full.lines.filter((l) => !l.excludedFromTotal).reduce((sum, l) => sum + (l.aud ?? 0), 0),
    ) < 0.02,
  );
  check(
    "the total is still flagged incomplete — the number rental is still unpriced",
    full.incomplete,
  );

  console.log("\n8. Unit economics\n");

  const units = costs.unitCosts(full);
  equal("three calls counted", units.calls, 3);
  equal("one booking counted", units.bookings, 1);
  close("cost per call is the total over three", units.perCallAud!, full.totalAud / 3, 0.01);
  close("cost per booking is the total over one", units.perBookingAud!, full.totalAud, 0.01);

  // A fourth call, failed at the telephony layer — Bob's instruction: exclude
  // it from every stat, including the "calls" denominator here. The real
  // total spend (full.totalAud) doesn't change; only the count does.
  database
    .prepare(`INSERT INTO calls (conversation_id, outcome, created_at) VALUES (?, 'failed', ?)`)
    .run("conv_failed", now);
  const unitsWithFailed = costs.unitCosts(full);
  equal("the failed call does not inflate the calls count", unitsWithFailed.calls, 3);

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

main().catch((err) => {
  console.error("\nCosts test crashed:", err);
  process.exit(1);
});
