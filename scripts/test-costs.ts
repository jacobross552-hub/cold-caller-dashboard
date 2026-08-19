/**
 * Tests for the cost accounting.
 *
 * Run with:  npm run test:costs
 *
 * The thing under test is not really the arithmetic — it's the honesty rules.
 * A costs page that quietly invents a figure is worse than no costs page, so
 * most of what's checked here is that unpriced things stay unpriced, that
 * credits are never mistaken for money, and that a total which omits something
 * says so.
 *
 * No API key, no network, no spend. Uses its own scratch database.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `costs-test-${process.pid}.db`);

// Must be set before any module is required — config is read at load time.
process.env.DATABASE_PATH = SCRATCH;
process.env.USD_AUD_RATE = "1.55";
// Start with every configurable rate UNSET, so the default state under test is
// the one that must refuse to guess.
delete process.env.TWILIO_SMS_COST_USD;
delete process.env.TWILIO_CALL_COST_USD_PER_MIN;
delete process.env.ELEVENLABS_PLAN_MONTHLY_AUD;
delete process.env.RAILWAY_MONTHLY_AUD;
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

function main() {
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

  console.log("\n3. An empty system costs nothing and admits what it can't see\n");

  const empty0 = costs.lifetimeCosts();
  equal("nothing measured yet", empty0.totalAud, 0);
  check("but the total is flagged incomplete", empty0.incomplete);
  equal("Twilio SMS is unpriced, not zero", line(empty0, "twilio_sms").aud, null);
  equal("Twilio call minutes are unpriced, not zero", line(empty0, "twilio_voice").aud, null);
  equal("hosting is unpriced, not zero", line(empty0, "railway").aud, null);
  check(
    "every unpriced line says what to set",
    empty0.lines.filter((l) => l.aud === null).every((l) => (l.missing ?? "").length > 10),
  );
  check(
    "the ABN line is a genuine zero, not a missing one",
    line(empty0, "abn_lookup").aud === 0 && !line(empty0, "abn_lookup").missing,
  );

  console.log("\n4. Measured spend adds up\n");

  const now = Date.now();
  const insertCall = database.prepare(
    `INSERT INTO calls (conversation_id, business_name, phone, started_at, duration_secs,
                        outcome, cost, booked, created_at,
                        cost_fiat_usd, platform_price_usd, llm_price_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Three calls, the same shape as the real ones already in production.
  insertCall.run("conv_a", "A Plumbing", "+61400000001", now, 157, "completed", 2092, 1, now, 0.3786, 0.2071, 0.1715);
  insertCall.run("conv_b", "B Electrical", "+61400000002", now, 155, "completed", 2281, 0, now, 0.4133, 0.2063, 0.207);
  insertCall.run("conv_c", "C Roofing", "+61400000003", now, 167, "completed", 2555, 0, now, 0.4633, 0.2216, 0.2417);

  const withCalls = costs.lifetimeCosts();
  // (0.2071 + 0.2063 + 0.2216) * 1.55
  close("voice spend converted to AUD", line(withCalls, "elevenlabs_platform").aud!, 0.99, 0.02);
  // (0.1715 + 0.207 + 0.2417) * 1.55
  close("agent LLM spend converted to AUD", line(withCalls, "elevenlabs_llm").aud!, 0.96, 0.02);

  database
    .prepare(
      `INSERT INTO ai_usage (call_id, purpose, model, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(null, "call_analysis", "claude-opus-5", 20_000, 2_000, 0, 0, 0.15, now);

  const withAi = costs.lifetimeCosts();
  close("dashboard model spend appears", line(withAi, "anthropic").aud!, 0.15 * 1.55, 0.01);
  check(
    "the two LLM bills are separate lines",
    line(withAi, "anthropic").aud !== line(withAi, "elevenlabs_llm").aud,
  );

  console.log("\n5. Rated lines stay unpriced until a rate is set\n");

  database
    .prepare(
      `INSERT INTO sms_sends (call_id, purpose, provider_sid, segments, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(null, "booking_alert", "SM_fake_sid", 2, 0, now);

  const stillUnset = costs.lifetimeCosts();
  equal("a real send with no rate is still unpriced", line(stillUnset, "twilio_sms").aud, null);
  check(
    "but the send is counted in the basis",
    line(stillUnset, "twilio_sms").basis.includes("1 text"),
  );

  // Now set the rates and confirm the same recorded usage becomes a figure.
  process.env.TWILIO_SMS_COST_USD = "0.05";
  process.env.TWILIO_CALL_COST_USD_PER_MIN = "0.03";

  const rated = costs.lifetimeCosts();
  close("2 segments at 5c, in AUD", line(rated, "twilio_sms").aud!, 2 * 0.05 * 1.55, 0.005);
  // 479 seconds of calls = 7.983 minutes at 3c.
  close("call minutes priced from real duration", line(rated, "twilio_voice").aud!, (479 / 60) * 0.03 * 1.55, 0.02);
  check("both are labelled rated, not measured", line(rated, "twilio_sms").provenance === "rated");

  console.log("\n6. Subscriptions are prorated and clearly configured\n");

  process.env.ELEVENLABS_PLAN_MONTHLY_AUD = "33";
  process.env.RAILWAY_MONTHLY_AUD = "8";

  const full = costs.lifetimeCosts();
  const months = full.monthsLive;
  check("months running is at least 1", months >= 1);
  close("plan fee is monthly x months", line(full, "elevenlabs_plan").aud!, 33 * months, 0.01);
  close("hosting is monthly x months", line(full, "railway").aud!, 8 * months, 0.01);
  equal("subscriptions are labelled configured", line(full, "railway").provenance, "configured");

  check("with every rate set, the total is no longer a floor", !full.incomplete);
  check(
    "the total is the sum of the priced lines",
    Math.abs(
      full.totalAud - full.lines.reduce((sum, l) => sum + (l.aud ?? 0), 0),
    ) < 0.02,
  );

  console.log("\n7. Unit economics\n");

  const units = costs.unitCosts(full);
  equal("three calls counted", units.calls, 3);
  equal("one booking counted", units.bookings, 1);
  close("cost per call is the total over three", units.perCallAud!, full.totalAud / 3, 0.01);
  close("cost per booking is the total over one", units.perBookingAud!, full.totalAud, 0.01);

  console.log("\n8. A total never silently includes a guess\n");

  // Drop one rate back out and confirm the page returns to "floor" mode.
  delete process.env.RAILWAY_MONTHLY_AUD;
  const regressed = costs.lifetimeCosts();
  check("removing a rate makes the total incomplete again", regressed.incomplete);
  check(
    "and the total drops by exactly the removed line",
    Math.abs(full.totalAud - regressed.totalAud - 8 * months) < 0.02,
  );

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
