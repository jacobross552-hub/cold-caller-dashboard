/**
 * Auto-generated demo agent (Segment 5).
 *
 * Triggered when a meeting books (hooked into calls.ts, same place the
 * booking-alert SMS fires). Researches the business, builds a receptionist
 * agent on ElevenLabs, and gives the meetings/call pages a "Launch demo"
 * link that opens ElevenLabs' own browser-based test-call widget for that
 * specific agent — already inside Bob's authenticated ElevenLabs session, so
 * nothing here has to embed a public widget or handle its own auth.
 *
 * SCOPE, STATED PLAINLY: the demo agent talks the receptionist role — answers
 * questions, takes messages, offers appointment times — but carries no real
 * calendar or SMS tools. It's a disposable conversation demo, not a working
 * integration. Bob confirmed on Won this stops at tearing down the demo —
 * no auto-provisioned production agent — same as Lost, since a real client
 * build needs a real number and tool wiring this deliberately doesn't do.
 *
 * Disposable by design: torn down after Segment 2 records an outcome, Won or
 * Lost either way (see teardownDemoAgent, called from the outcome API route).
 *
 * Optionally phone-callable: Bob's explicit choice to reuse the existing
 * cold-calling number rather than pay for a dedicated one, accepting the
 * tradeoff that a real prospect calling back while claimed reaches the demo
 * agent instead of Jacob. See claimPhoneForDemo/releasePhoneClaim below.
 */

import { db, logEvent } from "./db";
import { createAgent, deleteAgent, assignPhoneNumberAgent } from "./elevenlabs";
import { gatherResearch, type DemoResearch } from "./demo-research";
import { getLead, type LeadRow } from "./leads";
import { required } from "./env";
import type { CallAnalysis } from "./brief";

export type DemoAgentStatus = "provisioning" | "ready" | "failed" | "torn_down";

export interface DemoAgentRow {
  id: number;
  call_id: number;
  elevenlabs_agent_id: string | null;
  status: DemoAgentStatus;
  research_json: string | null;
  error: string | null;
  created_at: number;
  ready_at: number | null;
  torn_down_at: number | null;
  teardown_reason: string | null;
  branch_id: string | null;
}

export function getDemoAgent(callId: number): DemoAgentRow | null {
  return (db().prepare("SELECT * FROM demo_agents WHERE call_id = ?").get(callId) ?? null) as DemoAgentRow | null;
}

export function getDemoAgentsByCallIds(callIds: number[]): Map<number, DemoAgentRow> {
  const map = new Map<number, DemoAgentRow>();
  if (callIds.length === 0) return map;
  const placeholders = callIds.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM demo_agents WHERE call_id IN (${placeholders})`)
    .all(...callIds) as unknown as DemoAgentRow[];
  for (const row of rows) map.set(row.call_id, row);
  return map;
}

/**
 * The URL that opens ElevenLabs' own agent editor — its browser test-call
 * widget lives inside it. Confirmed against a real working link: the path is
 * /app/agents/agents/{agentId} (the doubled "agents" is real, not a typo),
 * and it needs ?branchId=... too — the agent-id-only URL 404s.
 */
export function launchDemoUrl(agentId: string, branchId: string | null): string {
  const base = `https://elevenlabs.io/app/agents/agents/${encodeURIComponent(agentId)}`;
  return branchId ? `${base}?branchId=${encodeURIComponent(branchId)}` : base;
}

function buildSystemPrompt(research: DemoResearch): string {
  const lines: string[] = [];

  lines.push(
    `You are the AI phone-answering receptionist for ${research.businessName}${research.vertical ? `, a ${research.vertical} business` : ""}${research.suburb ? ` in ${research.suburb}${research.state ? `, ${research.state}` : ""}` : ""}.`,
  );
  lines.push(
    "This is a DEMO call — the person you're talking to is deciding whether to buy this service for their own business, not a real customer ringing in. Your whole job on this call is to show them how good and how useful this can be for their business. Speak naturally, sound genuinely well-informed, and use every fact given to you below — don't let a good answer go unused. If directly asked whether this is a demo, say so honestly, then keep going.",
  );
  lines.push("");
  lines.push(
    "Your job on a real call: answer the phone, answer questions using what you actually know about this business, take a message if you can't help, and get the caller booked in for a technician to come out and quote the job. Keep replies short — this is a phone conversation, not an essay.",
  );
  lines.push(
    "You do not have a real calendar or messaging system connected. When you 'book' someone in below, say it exactly like a real booking — a specific day and time, confirmed, a reminder text on its way — and sound just as confident as you would if it were real. Never say anything that gives away it isn't (no 'I would book you in', no 'this is simulated') — the whole point is showing how this looks and sounds for real.",
  );

  if (research.openingHours && research.openingHours.length > 0) {
    lines.push("");
    lines.push(`OPENING HOURS — you know these exactly, state them confidently if asked:\n${research.openingHours.join("\n")}`);
  }

  if (research.businessDescription) {
    lines.push("");
    lines.push(`WHAT THIS BUSINESS DOES: ${research.businessDescription}`);
  }

  if (research.websiteText) {
    lines.push("");
    lines.push(
      `FACTS FROM THE BUSINESS'S OWN WEBSITE — this is your main source for FAQs (what they do, areas covered, what to expect). Read it properly and use it; don't invent anything beyond it:\n${research.websiteText}`,
    );
  }

  if (research.googleRating !== null) {
    lines.push("");
    lines.push(
      `GOOGLE REVIEWS: ${research.googleRating.toFixed(1)} stars${research.googleReviewCount ? ` from ${research.googleReviewCount} reviews` : ""}. You may mention this if it comes up naturally — never as a scripted boast.`,
    );
  }

  if (research.caredAbout.length > 0) {
    lines.push("");
    lines.push(`THINGS THE OWNER SAID THEY CARE ABOUT (from the sales call — lean into these if relevant):\n${research.caredAbout.map((c) => `- ${c}`).join("\n")}`);
  }

  lines.push("");
  lines.push(
    [
      "GETTING A QUOTE AND BOOKING A VISIT — this is the main flow to demonstrate, do it properly:",
      "- Never quote a price over the phone, and never invent one. That's normal and expected for this kind of work — the honest line is that someone needs to see the job to price it accurately.",
      "- Once they want a quote, ask what the job actually is, in your own words — don't just repeat 'what's the issue' robotically.",
      "- Ask roughly where they are (suburb is enough for a demo — don't push for a full street address).",
      "- Then offer two specific days/times for a tech to come out and have a look, e.g. 'I could get someone out Thursday morning, or Friday afternoon — what suits?' Never ask an open 'when works for you' question — always offer two named options.",
      "- Once they pick one, confirm it back clearly and completely: the day, the time, what happens next (a text confirmation, the tech will call ahead, whatever's natural). Say it like it's genuinely booked.",
      "- If they push back on the day, offer one more alternative rather than opening it up entirely.",
    ].join("\n"),
  );

  lines.push("");
  lines.push(
    "If you're asked something you genuinely don't know (not covered above), don't guess and don't make something up — say you'll double check and have someone call back, exactly like a real receptionist would when they're not sure. That's a good answer, not a failure.",
  );

  if (research.gaps.length > 0) {
    lines.push("");
    lines.push(`NOTE: some research couldn't be gathered (${research.gaps.join(" ")}) — answer from what's given above, and take a message for anything you're not sure of.`);
  }

  return lines.join("\n");
}

function firstMessage(research: DemoResearch): string {
  return `Thanks for calling ${research.businessName}, how can I help you today?`;
}

/**
 * Idempotent for anything already provisioning, ready, or torn down — safe to
 * call from a webhook path that might fire more than once for the same
 * booking. A row stuck at 'failed' is the one exception: this re-attempts it
 * in place, which is what backs the UI's manual "Retry" action.
 */
export async function provisionDemoAgent(callId: number): Promise<void> {
  const database = db();
  const existing = getDemoAgent(callId);
  if (existing && existing.status !== "failed") return;

  const now = Date.now();
  if (existing) {
    database
      .prepare(`UPDATE demo_agents SET status = 'provisioning', error = NULL, created_at = ? WHERE call_id = ?`)
      .run(now, callId);
  } else {
    database
      .prepare(`INSERT INTO demo_agents (call_id, status, created_at) VALUES (?, 'provisioning', ?)`)
      .run(callId, now);
  }

  try {
    const call = database.prepare("SELECT lead_id, analysis_json FROM calls WHERE id = ?").get(callId) as
      | { lead_id: number | null; analysis_json: string | null }
      | undefined;

    const lead: LeadRow | null = call ? getLead(call.lead_id) : null;
    let analysis: CallAnalysis | null = null;
    if (call?.analysis_json) {
      try {
        analysis = (JSON.parse(call.analysis_json) as { analysis: CallAnalysis }).analysis;
      } catch {
        // Malformed stored analysis just means less context, not a failure.
      }
    }

    const research = await gatherResearch(lead, analysis);
    const agent = await createAgent({
      name: `Demo — ${research.businessName} (call ${callId})`,
      systemPrompt: buildSystemPrompt(research),
      firstMessage: firstMessage(research),
    });

    database
      .prepare(
        `UPDATE demo_agents SET status = 'ready', elevenlabs_agent_id = ?, branch_id = ?, research_json = ?, ready_at = ? WHERE call_id = ?`,
      )
      .run(agent.agent_id, agent.main_branch_id, JSON.stringify(research), Date.now(), callId);

    logEvent("demo_agent.ready", `Demo agent built for call ${callId} (${research.businessName}).`, {
      callId,
      agentId: agent.agent_id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    database.prepare(`UPDATE demo_agents SET status = 'failed', error = ? WHERE call_id = ?`).run(detail, callId);
    logEvent("demo_agent.failed", `Demo agent build failed for call ${callId}: ${detail}`, { callId });
  }
}

/**
 * Delete the demo agent's ElevenLabs resources and mark it torn down. Called
 * once Segment 2 records Won or Lost — either outcome, per the standing
 * decision that demo agents are disposable regardless of how the meeting
 * went. Safe to call when there's no demo agent, or it's already torn down.
 */
export async function teardownDemoAgent(callId: number, reason: "won" | "lost"): Promise<void> {
  const row = getDemoAgent(callId);
  if (!row || row.status === "torn_down") return;

  // Must happen BEFORE deleting the agent — leaving the phone number pointed
  // at an agent that's about to stop existing would break inbound calls to
  // the shared cold-calling number entirely, not just misroute them. Same
  // "log and proceed" contract as the delete below: recording the outcome
  // must never be blocked by an ElevenLabs-side failure.
  const claim = getPhoneClaim();
  if (claim && claim.callId === callId) {
    try {
      await releasePhoneClaim();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logEvent("demo_agent.phone_release_failed", `Couldn't release the phone claim for call ${callId}: ${detail}`, {
        callId,
      });
    }
  }

  if (row.elevenlabs_agent_id) {
    try {
      await deleteAgent(row.elevenlabs_agent_id);
    } catch (err) {
      // Log and proceed anyway — a demo agent that fails to delete on
      // ElevenLabs' side must not block recording the deal outcome, which is
      // the far more important write. It'll show up in the event log for a
      // manual cleanup if it keeps happening.
      const detail = err instanceof Error ? err.message : String(err);
      logEvent("demo_agent.teardown_failed", `Couldn't delete demo agent for call ${callId}: ${detail}`, { callId });
    }
  }

  db()
    .prepare(`UPDATE demo_agents SET status = 'torn_down', torn_down_at = ?, teardown_reason = ? WHERE call_id = ?`)
    .run(Date.now(), reason, callId);

  logEvent("demo_agent.torn_down", `Demo agent for call ${callId} torn down (${reason}).`, { callId });
}

/* ---------------------------------------------------------------------------
 * Phone-callable demos — repointing the shared cold-calling number
 * ------------------------------------------------------------------------ */

export interface PhoneClaim {
  callId: number;
  claimedAt: number;
}

/** Auto-released if left claimed this long — the safety net for "Bob forgot to switch it back". */
export const PHONE_CLAIM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function getPhoneClaim(): PhoneClaim | null {
  const row = db().prepare("SELECT call_id, claimed_at FROM phone_claim WHERE id = 1").get() as
    | { call_id: number; claimed_at: number }
    | undefined;
  return row ? { callId: row.call_id, claimedAt: row.claimed_at } : null;
}

/**
 * Point the shared cold-calling number's inbound routing at this demo agent.
 * Claiming a different demo simply overwrites this — a number can only point
 * at one agent at a time, so the previous claim is implicitly gone the
 * instant a new one succeeds; there's nothing separate to release on
 * ElevenLabs' side first.
 */
export async function claimPhoneForDemo(callId: number): Promise<void> {
  const row = getDemoAgent(callId);
  if (!row || row.status !== "ready" || !row.elevenlabs_agent_id) {
    throw new Error("This demo agent isn't ready yet — nothing to point the number at.");
  }

  const phoneNumberId = required("ELEVENLABS_PHONE_NUMBER_ID");
  await assignPhoneNumberAgent(phoneNumberId, row.elevenlabs_agent_id);

  db()
    .prepare(
      `INSERT INTO phone_claim (id, call_id, claimed_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET call_id = excluded.call_id, claimed_at = excluded.claimed_at`,
    )
    .run(callId, Date.now());

  logEvent(
    "demo_agent.phone_claimed",
    `Cold-calling number repointed to the demo agent for call ${callId} (${row.elevenlabs_agent_id}). Real inbound calls will reach it until released.`,
    { callId },
  );
}

/** Point the number back at the real cold-calling agent. Safe to call when nothing is claimed. */
export async function releasePhoneClaim(): Promise<void> {
  const claim = getPhoneClaim();
  if (!claim) return;

  const phoneNumberId = required("ELEVENLABS_PHONE_NUMBER_ID");
  const jacobAgentId = required("ELEVENLABS_AGENT_ID");
  await assignPhoneNumberAgent(phoneNumberId, jacobAgentId);

  db().prepare("DELETE FROM phone_claim WHERE id = 1").run();

  logEvent("demo_agent.phone_released", `Cold-calling number pointed back to Jacob (was claimed by call ${claim.callId}).`, {
    callId: claim.callId,
  });
}

/**
 * Called from dispatcher.ts's one-minute heartbeat. Auto-releases a claim
 * that's been held past PHONE_CLAIM_TIMEOUT_MS — the safety net for a demo
 * that was never explicitly released, so the real callback number doesn't
 * stay pointed at a demo agent indefinitely by accident.
 */
export async function phoneClaimTick(): Promise<void> {
  const claim = getPhoneClaim();
  if (!claim) return;
  if (Date.now() - claim.claimedAt < PHONE_CLAIM_TIMEOUT_MS) return;

  logEvent("demo_agent.phone_claim_timed_out", `Auto-releasing the phone claim from call ${claim.callId} after ${PHONE_CLAIM_TIMEOUT_MS / 3_600_000}h.`, {
    callId: claim.callId,
  });
  await releasePhoneClaim();
}
