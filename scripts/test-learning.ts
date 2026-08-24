/**
 * Tests for weekly auto-learning (Segment 6): the diff engine, aggregation,
 * run orchestration, and the accept/reject/revert safety mechanism.
 *
 * Run with:  npm run test:learning
 *
 * No real network, no real Anthropic/ElevenLabs spend: synthesizeProposals,
 * getAgentConfig, and updateAgentPrompt are stubbed at the module boundary,
 * same pattern as test-integration.ts stubs brief.analyseCall. Uses its own
 * scratch database.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `learning-test-${process.pid}.db`);

process.env.DATABASE_PATH = SCRATCH;
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ANTHROPIC_API_KEY = "test-key";

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const elevenlabs = require("../src/lib/elevenlabs") as typeof import("../src/lib/elevenlabs");
const deals = require("../src/lib/deals") as typeof import("../src/lib/deals");
const synthesis = require("../src/lib/learning-synthesis") as typeof import("../src/lib/learning-synthesis");
const learning = require("../src/lib/learning") as typeof import("../src/lib/learning");

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

async function main() {
  console.log("\n1. computeDiff — pure function correctness\n");

  equal("identical text is all 'same'", learning.computeDiff("a\nb\nc", "a\nb\nc").map((l) => l.type), [
    "same",
    "same",
    "same",
  ]);

  const oneLineChanged = learning.computeDiff("a\nb\nc", "a\nX\nc");
  equal(
    "a single changed line shows as removed+added, context unchanged",
    oneLineChanged.map((l) => `${l.type}:${l.text}`),
    ["same:a", "removed:b", "added:X", "same:c"],
  );

  const appended = learning.computeDiff("a\nb", "a\nb\nc");
  equal("an appended line shows only as added", appended.map((l) => l.type), ["same", "same", "added"]);

  const removedFromStart = learning.computeDiff("a\nb\nc", "b\nc");
  equal("a removed leading line shows only as removed", removedFromStart.map((l) => l.type), [
    "removed",
    "same",
    "same",
  ]);

  equal("empty vs empty is empty", learning.computeDiff("", ""), [{ type: "same", text: "" }]);

  console.log("\n2. aggregateWeek — windowing and counting\n");

  const database = db();
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  function seedAnalysedCall(opts: {
    conversationId: string;
    createdAt: number;
    outcome: string;
    objections?: string[];
    slips?: string[];
    askedIfAi?: boolean;
    quoteStatus?: string;
  }) {
    const analysisJson = JSON.stringify({
      analysis: {
        furthest_stage: "booked",
        asked_if_ai: opts.askedIfAi ?? false,
        figure_agreed: "agreed",
        objections: (opts.objections ?? []).map((o) => ({ objection: o })),
        agent_slips: opts.slips ?? [],
        discounted_weekly_loss: 300,
      },
      quoteCheck: { status: opts.quoteStatus ?? "matches" },
    });
    database
      .prepare(`INSERT INTO calls (conversation_id, outcome, created_at, analysis_json) VALUES (?, ?, ?, ?)`)
      .run(opts.conversationId, opts.outcome, opts.createdAt, analysisJson);
  }

  seedAnalysedCall({ conversationId: "conv_in_1", createdAt: now - 1000, outcome: "completed", objections: ["too busy"], askedIfAi: true });
  seedAnalysedCall({ conversationId: "conv_in_2", createdAt: now - 2000, outcome: "hung_up_early", objections: ["too busy", "tried it before"] });
  seedAnalysedCall({ conversationId: "conv_out_of_window", createdAt: weekAgo - 100_000, outcome: "completed", objections: ["should not be counted"] });

  const stats = await learning.aggregateWeek(weekAgo, now);
  equal("only in-window analysed calls counted", stats.callsAnalysed, 2);
  equal("objection counts aggregated across in-window calls only", stats.objectionCounts, { "too busy": 2, "tried it before": 1 });
  equal("asked-if-AI counted", stats.askedIfAiCount, 1);
  check("out-of-window objection never appears", !("should not be counted" in stats.objectionCounts));

  console.log("\n3. aggregateWeek — pricing recommended vs actually charged\n");

  database.prepare(`INSERT INTO calls (conversation_id, outcome, created_at, analysis_json) VALUES (?, 'completed', ?, ?)`).run(
    "conv_won_pricing",
    now - 500,
    JSON.stringify({ analysis: { discounted_weekly_loss: 300 }, quoteCheck: { status: "matches" } }), // $300/wk -> "$250-$600/wk" band -> $2,200 setup / $800 retainer
  );
  const wonCall = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_won_pricing") as { id: number };
  deals.recordWon(wonCall.id, 2500, 900); // actually charged more than recommended — recordWon stamps its own Date.now(), so query the window generously past it

  const stats2 = await learning.aggregateWeek(weekAgo, Date.now() + 60_000);
  const band = stats2.pricingVsActual.find((b) => b.band === "$250–$600/wk");
  check("pricing-vs-actual band found", Boolean(band));
  equal("recommended setup matches the table", band?.recommendedSetup, 2200);
  equal("actual setup reflects what was really charged", band?.actualSetup, 2500);

  console.log("\n4. runWeeklyLearning — orchestration, stubbed model and ElevenLabs\n");

  elevenlabs.getAgentConfig = (async () => ({
    conversation_config: { agent: { prompt: { prompt: "ORIGINAL PROMPT TEXT", llm: "claude-sonnet-4-6" } } },
  })) as typeof elevenlabs.getAgentConfig;

  const synthCalls: Array<{ currentPrompt: string; priorRejections: unknown[] }> = [];
  const trackingStub = (async (stats: unknown, currentPrompt: string, priorRejections: unknown[]) => {
    synthCalls.push({ currentPrompt, priorRejections });
    return {
      proposals: [
        {
          category: "script" as const,
          title: "Soften the opener",
          reasoning: "3 of 5 hang-ups happened within the first line this week.",
          confidence: "moderate (N=5)",
          sample_size: 5,
          new_prompt_text: "ORIGINAL PROMPT TEXT, but softer",
        },
        {
          category: "pricing" as const,
          title: "Raise the bottom band",
          reasoning: "Small sample suggests underpricing.",
          confidence: "low (N=2)",
          sample_size: 2, // below MIN_PRICING_SAMPLE — must be filtered
          new_prompt_text: null,
        },
        {
          category: "other" as const,
          title: "Call earlier in the day",
          reasoning: "Connect rate higher before 11am this week.",
          confidence: "moderate (N=20)",
          sample_size: 20,
          new_prompt_text: null,
        },
      ],
      overallNotes: "Quiet week otherwise.",
      usage: { model: "claude-opus-5", inputTokens: 1000, outputTokens: 200 },
    };
  }) as typeof synthesis.synthesizeProposals;
  synthesis.synthesizeProposals = trackingStub;

  const run1 = await learning.runWeeklyLearning(now);
  check("run completed", run1?.status === "completed", run1?.error ?? "");

  const allProposals = database.prepare("SELECT * FROM learning_proposals WHERE run_id = ?").all(run1!.id) as Array<{
    category: string;
  }>;
  equal("the below-threshold pricing proposal was filtered out by the code-level backstop", allProposals.length, 2);
  check(
    "the script and other proposals survived",
    allProposals.some((p) => p.category === "script") && allProposals.some((p) => p.category === "other"),
  );

  const aiUsageRow = database.prepare("SELECT * FROM ai_usage WHERE purpose = 'weekly_learning'").get() as
    | { input_tokens: number; cost_usd: number }
    | undefined;
  check("the synthesis call was logged to the cost ledger, same as any other Anthropic spend", Boolean(aiUsageRow));
  equal("token counts recorded as reported", aiUsageRow?.input_tokens, 1000);

  console.log("\n4b. At most one script proposal survives per run, even if the model returns more\n");

  synthesis.synthesizeProposals = (async () => ({
    proposals: [
      { category: "script" as const, title: "First script change", reasoning: "r1", confidence: "c1", sample_size: 10, new_prompt_text: "PROMPT A" },
      { category: "script" as const, title: "Second script change", reasoning: "r2", confidence: "c2", sample_size: 10, new_prompt_text: "PROMPT B" },
      { category: "other" as const, title: "An other one", reasoning: "r3", confidence: "c3", sample_size: 10, new_prompt_text: null },
    ],
    overallNotes: "",
    usage: { model: "claude-opus-5", inputTokens: 500, outputTokens: 100 },
  })) as typeof synthesis.synthesizeProposals;

  const multiScriptWeekEnd = now - 27 * 86_400_000; // a week window not used anywhere else in this file
  const run4 = await learning.runWeeklyLearning(multiScriptWeekEnd);
  check("run completed", run4?.status === "completed", run4?.error ?? "");

  const run4Proposals = database.prepare("SELECT category FROM learning_proposals WHERE run_id = ?").all(run4!.id) as Array<{
    category: string;
  }>;
  equal(
    "only one script proposal kept even though the model returned two",
    run4Proposals.filter((p) => p.category === "script").length,
    1,
  );
  equal("the non-script proposal is untouched by the script cap", run4Proposals.filter((p) => p.category === "other").length, 1);

  synthesis.synthesizeProposals = trackingStub; // restore — later sections depend on synthCalls tracking

  console.log("\n5. runWeeklyLearning is idempotent for the same week\n");

  const callCountBefore = synthCalls.length;
  const run2 = await learning.runWeeklyLearning(now);
  equal("returns the SAME run, doesn't create a second one", run2?.id, run1?.id);
  equal("synthesis was not called again", synthCalls.length, callCountBefore);

  console.log("\n6. acceptProposal — script category patches ElevenLabs, only after success\n");

  const scriptProposal = database
    .prepare("SELECT * FROM learning_proposals WHERE run_id = ? AND category = 'script'")
    .get(run1!.id) as { id: number };

  const patchCalls: Array<{ agentId: string; text: string }> = [];
  elevenlabs.updateAgentPrompt = (async (agentId: string, text: string) => {
    patchCalls.push({ agentId, text });
  }) as typeof elevenlabs.updateAgentPrompt;

  await learning.acceptProposal(scriptProposal.id);
  equal("updateAgentPrompt called with the exact new text", patchCalls, [{ agentId: "agent_test", text: "ORIGINAL PROMPT TEXT, but softer" }]);

  const acceptedRow = database.prepare("SELECT * FROM learning_proposals WHERE id = ?").get(scriptProposal.id) as {
    status: string;
    applied_at: number | null;
    previous_prompt_text: string | null;
  };
  equal("status flipped to accepted", acceptedRow.status, "accepted");
  check("applied_at set", acceptedRow.applied_at !== null);
  equal("exact previous prompt text stored for revert", acceptedRow.previous_prompt_text, "ORIGINAL PROMPT TEXT");

  console.log("\n7. acceptProposal — other categories never touch ElevenLabs\n");

  const otherProposal = database
    .prepare("SELECT * FROM learning_proposals WHERE run_id = ? AND category = 'other'")
    .get(run1!.id) as { id: number };

  const patchCallsBefore = patchCalls.length;
  await learning.acceptProposal(otherProposal.id);
  equal("updateAgentPrompt not called for an advisory-only category", patchCalls.length, patchCallsBefore);
  const otherRow = database.prepare("SELECT status FROM learning_proposals WHERE id = ?").get(otherProposal.id) as {
    status: string;
  };
  equal("still marked accepted (acknowledged)", otherRow.status, "accepted");

  console.log("\n8. acceptProposal — a failed apply leaves the proposal pending, not silently accepted\n");

  // Seed a second run with a fresh script proposal to accept-and-fail.
  database.prepare("DELETE FROM learning_runs WHERE week_start = ?").run(now - 14 * 86_400_000); // no-op safety
  const run3Id = database
    .prepare("INSERT INTO learning_runs (week_start, week_end, status, created_at) VALUES (?, ?, 'completed', ?)")
    .run(now - 20 * 86_400_000, now - 13 * 86_400_000, Date.now()).lastInsertRowid as number;
  const failProposalId = database
    .prepare(
      `INSERT INTO learning_proposals (run_id, category, title, reasoning, confidence, sample_size, previous_prompt_text, new_prompt_text, status, created_at)
       VALUES (?, 'script', 'Will fail', 'test', 'test', 5, 'BEFORE', 'AFTER', 'pending', ?)`,
    )
    .run(run3Id, Date.now()).lastInsertRowid as number;

  elevenlabs.updateAgentPrompt = (async () => {
    throw new Error("ElevenLabs 500");
  }) as typeof elevenlabs.updateAgentPrompt;

  let threw = false;
  try {
    await learning.acceptProposal(failProposalId);
  } catch {
    threw = true;
  }
  check("acceptProposal propagates the failure rather than swallowing it", threw);
  const stillPending = database.prepare("SELECT status FROM learning_proposals WHERE id = ?").get(failProposalId) as {
    status: string;
  };
  equal("proposal stays pending — retryable, not silently marked applied", stillPending.status, "pending");

  console.log("\n9. rejectProposal — requires being pending, feeds the next run's context\n");

  learning.rejectProposal(otherProposal.id, "already-accepted, should be a no-op");
  const stillAccepted = database.prepare("SELECT status FROM learning_proposals WHERE id = ?").get(otherProposal.id) as {
    status: string;
  };
  equal("cannot reject an already-accepted proposal", stillAccepted.status, "accepted");

  learning.rejectProposal(failProposalId, "Too risky without more data.");
  const rejectedRow = database.prepare("SELECT status, rejected_reason FROM learning_proposals WHERE id = ?").get(failProposalId) as {
    status: string;
    rejected_reason: string;
  };
  equal("status is rejected", rejectedRow.status, "rejected");
  equal("reason stored", rejectedRow.rejected_reason, "Too risky without more data.");

  // A new run should be told about this rejection.
  elevenlabs.updateAgentPrompt = (async () => {}) as typeof elevenlabs.updateAgentPrompt;
  const laterWeekEnd = now - 6 * 86_400_000; // a window that doesn't collide with run1's week_start
  await learning.runWeeklyLearning(laterWeekEnd);
  const sawRejection = synthCalls[synthCalls.length - 1].priorRejections as Array<{ title: string }>;
  check("the next run's synthesis call was given the prior rejection", sawRejection.some((r) => r.title === "Will fail"));

  console.log("\n10. revertProposal — restores the exact previous prompt text\n");

  elevenlabs.updateAgentPrompt = (async (agentId: string, text: string) => {
    patchCalls.push({ agentId, text });
  }) as typeof elevenlabs.updateAgentPrompt;

  const beforeRevert = patchCalls.length;
  await learning.revertProposal(scriptProposal.id);
  equal("exactly one PATCH sent for the revert", patchCalls.length - beforeRevert, 1);
  equal("reverted to the EXACT stored previous text", patchCalls[patchCalls.length - 1].text, "ORIGINAL PROMPT TEXT");

  const revertedRow = database.prepare("SELECT reverted_at FROM learning_proposals WHERE id = ?").get(scriptProposal.id) as {
    reverted_at: number | null;
  };
  check("reverted_at set", revertedRow.reverted_at !== null);

  const beforeSecondRevert = patchCalls.length;
  await learning.revertProposal(scriptProposal.id); // already reverted — must be a no-op
  equal("reverting an already-reverted proposal does nothing", patchCalls.length, beforeSecondRevert);

  console.log("\n11. pendingProposals / appliedHistory — separate views\n");

  const pending = learning.pendingProposals();
  check("pending list excludes accepted/rejected proposals", pending.every((p) => p.status === "pending"));

  const history = learning.appliedHistory();
  check("applied history is script-only", history.every((p) => p.category === "script"));
  check("applied history includes the reverted one (with reverted_at set)", history.some((p) => p.id === scriptProposal.id && p.reverted_at !== null));

  console.log("\n12. weeklyLearningTick — only fires Monday 6:00-6:09 Sydney, dedupes within the grace window\n");

  database.exec("DELETE FROM learning_runs");
  database.exec("DELETE FROM learning_proposals");
  const tickSynthCallsBefore = synthCalls.length;

  // A known Monday 06:03 Sydney time (AEDT, UTC+11 in early Jan) — 2027-01-04 is a Monday.
  const mondaySydney0603 = new Date("2027-01-03T19:03:00Z"); // 2027-01-04 06:03 AEDT
  await learning.weeklyLearningTick(mondaySydney0603);
  equal("fires inside the Monday 6:00-6:09 window", synthCalls.length, tickSynthCallsBefore + 1);

  await learning.weeklyLearningTick(new Date(mondaySydney0603.getTime() + 3 * 60_000)); // 06:06, same morning
  equal("does not fire again within the grace window (deduped)", synthCalls.length, tickSynthCallsBefore + 1);

  const tuesday = new Date("2027-01-04T19:03:00Z"); // Tuesday
  await learning.weeklyLearningTick(tuesday);
  equal("does not fire on a non-Monday", synthCalls.length, tickSynthCallsBefore + 1);

  const mondayWrongHour = new Date("2027-01-03T21:03:00Z"); // Monday, but 08:03 Sydney
  await learning.weeklyLearningTick(mondayWrongHour);
  equal("does not fire outside the 6am hour", synthCalls.length, tickSynthCallsBefore + 1);

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
  console.error("\nLearning test crashed:", err);
  process.exit(1);
});
