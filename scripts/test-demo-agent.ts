/**
 * Tests for the auto-generated demo agent (Segment 5): research gathering,
 * provisioning (with retry-after-failure), and teardown.
 *
 * Run with:  npm run test:demo-agent
 *
 * No real network: elevenlabs.ts's createAgent/deleteAgent are stubbed at the
 * module boundary (same pattern test-integration.ts uses), and global fetch
 * is stubbed for the website-research step. No API key, no spend. Uses its
 * own scratch database.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const SCRATCH = resolve(process.cwd(), ".test-build", `demo-agent-test-${process.pid}.db`);

process.env.DATABASE_PATH = SCRATCH;
process.env.ELEVENLABS_API_KEY = "test-key";

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const elevenlabs = require("../src/lib/elevenlabs") as typeof import("../src/lib/elevenlabs");
const research = require("../src/lib/demo-research") as typeof import("../src/lib/demo-research");
const demoAgent = require("../src/lib/demo-agent") as typeof import("../src/lib/demo-agent");

type LeadRow = import("../src/lib/leads").LeadRow;

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

function fakeLead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 1,
    business_name: "Test Plumbing Co",
    phone: "+61490001111",
    contact_name: null,
    suburb: "Newcastle",
    state: "NSW",
    trade: "plumber",
    notes: null,
    source: "test",
    status: "new",
    call_count: 1,
    last_called_at: null,
    created_at: Date.now(),
    source_place_id: null,
    icp_score: null,
    icp_reasons: null,
    vertical: "plumber",
    lead_run_id: null,
    abn: null,
    abn_status: null,
    website: null,
    google_rating: 4.6,
    google_review_count: 42,
    opening_hours_json: null,
    source_record: null,
    ...overrides,
  };
}

async function main() {
  console.log("\n1. gatherResearch degrades gracefully — no lead, no analysis, no website\n");

  const bare = await research.gatherResearch(null, null);
  equal("falls back to a generic business name", bare.businessName, "the business");
  check("notes the missing lead", bare.gaps.some((g) => g.includes("No lead record")));
  check("notes the missing analysis", bare.gaps.some((g) => g.includes("No call analysis")));
  check("no website means no website text, and it's noted", bare.websiteText === null && bare.gaps.some((g) => g.includes("No website")));

  console.log("\n2. gatherResearch reads the website when the fetch succeeds\n");

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response("<html><body><h1>Test Plumbing Co</h1><p>We fix pipes fast. Open 7 days.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

  const withSite = await research.gatherResearch(fakeLead({ website: "https://example.invalid" }), null);
  check("website text extracted and tags stripped", withSite.websiteText?.includes("We fix pipes fast") ?? false);
  check("no gap recorded for a successful fetch", !withSite.gaps.some((g) => g.toLowerCase().includes("website")));

  console.log("\n3. gatherResearch degrades gracefully when the website fetch fails\n");

  global.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;

  const brokenSite = await research.gatherResearch(fakeLead({ website: "https://example.invalid" }), null);
  equal("website text is null, not a thrown error", brokenSite.websiteText, null);
  check("the failure is recorded as a gap, not swallowed silently", brokenSite.gaps.some((g) => g.includes("Couldn't reach")));

  console.log("\n4. gatherResearch degrades gracefully on a non-HTML response\n");

  global.fetch = (async () =>
    new Response("%PDF-1.4 not html", { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch;
  const pdfSite = await research.gatherResearch(fakeLead({ website: "https://example.invalid/brochure.pdf" }), null);
  equal("non-HTML content is skipped, not mis-parsed", pdfSite.websiteText, null);

  global.fetch = originalFetch;

  console.log("\n5. Malformed stored opening hours don't crash research\n");

  const badHours = await research.gatherResearch(fakeLead({ opening_hours_json: "{not json" }), null);
  equal("opening hours null on parse failure", badHours.openingHours, null);
  check("the parse failure is recorded", badHours.gaps.some((g) => g.includes("opening hours")));

  console.log("\n6. provisionDemoAgent — happy path\n");

  const database = db();
  database.prepare(`INSERT INTO calls (conversation_id, booked, created_at) VALUES (?, 1, ?)`).run("conv_demo_1", Date.now());
  const call1 = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_demo_1") as { id: number };

  const createCalls: Array<{ name: string }> = [];
  elevenlabs.createAgent = (async (params: { name: string }) => {
    createCalls.push({ name: params.name });
    return { agent_id: "agent_fake_1", main_branch_id: "branch_fake_1" };
  }) as typeof elevenlabs.createAgent;

  await demoAgent.provisionDemoAgent(call1.id);
  const row1 = demoAgent.getDemoAgent(call1.id)!;
  equal("status is ready", row1.status, "ready");
  equal("agent id stored", row1.elevenlabs_agent_id, "agent_fake_1");
  equal("branch id stored — needed for a working dashboard link", row1.branch_id, "branch_fake_1");
  check("research was stored", Boolean(row1.research_json));
  equal("createAgent called exactly once", createCalls.length, 1);

  console.log("\n7. provisionDemoAgent is idempotent once ready\n");

  await demoAgent.provisionDemoAgent(call1.id);
  equal("createAgent NOT called again for an already-ready agent", createCalls.length, 1);

  console.log("\n8. provisionDemoAgent records failure without throwing, and retry recovers\n");

  database.prepare(`INSERT INTO calls (conversation_id, booked, created_at) VALUES (?, 1, ?)`).run("conv_demo_2", Date.now());
  const call2 = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_demo_2") as { id: number };

  elevenlabs.createAgent = (async () => {
    throw new Error("ElevenLabs 500");
  }) as typeof elevenlabs.createAgent;

  await demoAgent.provisionDemoAgent(call2.id); // must not throw
  const failedRow = demoAgent.getDemoAgent(call2.id)!;
  equal("status is failed", failedRow.status, "failed");
  check("error message stored", (failedRow.error ?? "").includes("ElevenLabs 500"));

  elevenlabs.createAgent = (async (params: { name: string }) => {
    createCalls.push({ name: params.name });
    return { agent_id: "agent_fake_2", main_branch_id: "branch_fake_2" };
  }) as typeof elevenlabs.createAgent;

  await demoAgent.provisionDemoAgent(call2.id); // retry
  const retriedRow = demoAgent.getDemoAgent(call2.id)!;
  equal("retry recovers to ready", retriedRow.status, "ready");
  equal("retry got the new agent id", retriedRow.elevenlabs_agent_id, "agent_fake_2");

  console.log("\n8b. launchDemoUrl — the exact format that actually works\n");

  // Confirmed against a real working link pasted back from the ElevenLabs
  // dashboard: the path has agents/agents (doubled, not a typo) and needs
  // ?branchId= — the agent-id-only URL 404s in production.
  equal(
    "URL includes the doubled agents/agents path and branchId query param",
    demoAgent.launchDemoUrl("agent_xyz", "agtbrch_abc"),
    "https://elevenlabs.io/app/agents/agents/agent_xyz?branchId=agtbrch_abc",
  );
  equal(
    "falls back to no query param when branch id is missing, rather than a broken '?branchId=null'",
    demoAgent.launchDemoUrl("agent_xyz", null),
    "https://elevenlabs.io/app/agents/agents/agent_xyz",
  );

  console.log("\n9. teardownDemoAgent deletes on ElevenLabs and marks torn down, once\n");

  const deleteCalls: string[] = [];
  elevenlabs.deleteAgent = (async (agentId: string) => {
    deleteCalls.push(agentId);
  }) as typeof elevenlabs.deleteAgent;

  await demoAgent.teardownDemoAgent(call1.id, "won");
  const tornDown = demoAgent.getDemoAgent(call1.id)!;
  equal("status is torn_down", tornDown.status, "torn_down");
  equal("teardown reason recorded", tornDown.teardown_reason, "won");
  equal("deleteAgent called with the right id", deleteCalls, ["agent_fake_1"]);

  await demoAgent.teardownDemoAgent(call1.id, "won"); // idempotent
  equal("deleteAgent not called again for an already-torn-down agent", deleteCalls.length, 1);

  console.log("\n10. teardownDemoAgent never throws, even when ElevenLabs deletion fails\n");

  elevenlabs.deleteAgent = (async () => {
    throw new Error("ElevenLabs 500 on delete");
  }) as typeof elevenlabs.deleteAgent;

  await demoAgent.teardownDemoAgent(call2.id, "lost"); // must not throw
  const tornDown2 = demoAgent.getDemoAgent(call2.id)!;
  equal(
    "still marked torn down locally even though the remote delete failed — recording the outcome must not be blocked",
    tornDown2.status,
    "torn_down",
  );

  console.log("\n11. teardownDemoAgent on a call with no demo agent is a harmless no-op\n");

  database.prepare(`INSERT INTO calls (conversation_id, booked, created_at) VALUES (?, 1, ?)`).run("conv_demo_3", Date.now());
  const call3 = database.prepare("SELECT id FROM calls WHERE conversation_id = ?").get("conv_demo_3") as { id: number };
  await demoAgent.teardownDemoAgent(call3.id, "lost"); // must not throw
  check("still no demo agent row", demoAgent.getDemoAgent(call3.id) === null);

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
  console.error("\nDemo-agent test crashed:", err);
  process.exit(1);
});
