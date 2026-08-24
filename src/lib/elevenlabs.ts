/**
 * The ElevenLabs Agents Platform client: batch-calling (the cold-calling side)
 * plus agent create/get/delete (the demo-agent side, Segment 5).
 *
 * Batch-calling endpoints verified against
 * elevenlabs.io/docs/api-reference/batch-calling (17 Aug 2026):
 *   POST /v1/convai/batch-calling/submit
 *   GET  /v1/convai/batch-calling/{batch_id}
 *   POST /v1/convai/batch-calling/{batch_id}/cancel
 *
 * We deliberately do NOT hand ElevenLabs a whole run at once, and we do not
 * use its `scheduled_time_unix` field. Our own dispatcher owns the schedule so
 * the calling-hours guard stays in our control and a run can be paused at a
 * window boundary and resumed the next morning.
 *
 * Agent endpoints verified against
 * elevenlabs.io/docs/agents-platform/api-reference/agents (24 Aug 2026):
 *   POST   /v1/convai/agents/create
 *   GET    /v1/convai/agents/{agent_id}
 *   DELETE /v1/convai/agents/{agent_id}
 */

import { required } from "./env";

const BASE = "https://api.elevenlabs.io/v1";

export interface BatchRecipient {
  phone_number: string;
  id?: string;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, string | number | boolean>;
  };
}

export interface BatchJob {
  id: string;
  name?: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  total_calls_dispatched?: number;
  total_calls_scheduled?: number;
  total_calls_finished?: number;
  recipients?: Array<{
    id: string;
    phone_number?: string | null;
    status:
      | "pending"
      | "dispatched"
      | "initiated"
      | "in_progress"
      | "completed"
      | "failed"
      | "cancelled"
      | "voicemail";
    conversation_id?: string | null;
  }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "xi-api-key": required("ELEVENLABS_API_KEY"),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `ElevenLabs ${init?.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  return body ? (JSON.parse(body) as T) : ({} as T);
}

/**
 * Hand a chunk of numbers to ElevenLabs to dial now.
 *
 * `target_concurrency_limit` keeps simultaneous calls low — at 10-20 calls a
 * day (plan.md's target volume) there is no reason to blast the list, and a
 * low concurrency reduces the chance of the number getting flagged as spam.
 */
export async function submitBatch(params: {
  name: string;
  recipients: BatchRecipient[];
  concurrency: number;
}): Promise<BatchJob> {
  return call<BatchJob>("/convai/batch-calling/submit", {
    method: "POST",
    body: JSON.stringify({
      call_name: params.name,
      agent_id: required("ELEVENLABS_AGENT_ID"),
      agent_phone_number_id: required("ELEVENLABS_PHONE_NUMBER_ID"),
      recipients: params.recipients,
      target_concurrency_limit: params.concurrency,
    }),
  });
}

export async function getBatch(batchId: string): Promise<BatchJob> {
  return call<BatchJob>(`/convai/batch-calling/${encodeURIComponent(batchId)}`);
}

export async function cancelBatch(batchId: string): Promise<void> {
  await call(`/convai/batch-calling/${encodeURIComponent(batchId)}/cancel`, {
    method: "POST",
  });
}

// --- Agents (demo-agent provisioning, Segment 5) ----------------------------

export interface CreateAgentParams {
  name: string;
  /** The full system prompt — demo agents inline everything rather than using a knowledge base, same call as the live cold-calling agent (see brief.ts's note on RAG latency during a live conversation). */
  systemPrompt: string;
  firstMessage: string;
  llm?: string;
  language?: string;
}

export interface CreatedAgent {
  agent_id: string;
  /** Needed to build a working dashboard link — see launchDemoUrl below. */
  main_branch_id: string;
}

/**
 * Create a new Conversational AI agent. No voice/TTS override is sent — the
 * demo agent inherits ElevenLabs' own default voice, which is fine for a
 * disposable demo that gets torn down once the outcome is recorded.
 */
export async function createAgent(params: CreateAgentParams): Promise<CreatedAgent> {
  return call<CreatedAgent>("/convai/agents/create", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      conversation_config: {
        agent: {
          first_message: params.firstMessage,
          language: params.language ?? "en",
          prompt: {
            prompt: params.systemPrompt,
            llm: params.llm ?? "claude-sonnet-4-6",
          },
        },
      },
    }),
  });
}

// --- Agent prompt read/update (weekly auto-learning, Segment 6) ------------
//
// ElevenLabs' own docs state PATCH /v1/convai/agents/{id} is a partial
// update, but don't confirm the MERGE semantics of the nested
// conversation_config object specifically — and this is the one write path
// in the whole app that touches the live sales script's tools and voice
// config, not just its text. Rather than trust an unconfirmed partial-merge
// behavior, updateAgentPrompt always reads the full current config first and
// PATCHes the WHOLE conversation_config back with only the prompt string
// changed. That's correct regardless of whether ElevenLabs deep-merges or
// replaces wholesale — the one thing that must never happen here is a prompt
// update silently detaching send_sms or the calendar tools.

/** The full agent config, typed loosely — only conversation_config.agent.prompt.prompt is ever read or written here. */
export async function getAgentConfig(agentId: string): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(`/convai/agents/${encodeURIComponent(agentId)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Phone number → agent assignment (repointing for a callable demo) ------
//
// Verified against a real round trip on the live number before this was
// built on: PATCH /v1/convai/phone-numbers/{id} with { agent_id } governs
// INBOUND routing only — who answers when someone dials the number. It does
// NOT affect outbound dialling, which always names its agent explicitly (see
// submitBatch above), so cold-calling keeps working unaffected while the
// number is pointed at a demo agent for inbound.

/** Repoint a phone number's inbound routing to a different agent. */
export async function assignPhoneNumberAgent(phoneNumberId: string, agentId: string): Promise<void> {
  await call(`/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
    method: "PATCH",
    body: JSON.stringify({ agent_id: agentId }),
  });
}

/** Read-only: pulls just the live prompt text out of a fetched config, for diffing against a proposal. */
export function currentPromptText(agentConfig: Record<string, unknown>): string {
  const cc = agentConfig["conversation_config"];
  if (!isRecord(cc)) return "";
  const agent = cc["agent"];
  if (!isRecord(agent)) return "";
  const prompt = agent["prompt"];
  if (!isRecord(prompt)) return "";
  return typeof prompt["prompt"] === "string" ? prompt["prompt"] : "";
}

/**
 * Fetch the current config, splice in the new prompt text, PATCH the whole
 * conversation_config back. Throws on any failure — the caller (accept/revert
 * in learning.ts) must not silently mark a change applied when it wasn't.
 */
export async function updateAgentPrompt(agentId: string, newPromptText: string): Promise<void> {
  const current = await getAgentConfig(agentId);
  const cc = current["conversation_config"];
  if (!isRecord(cc)) throw new Error("Agent config has no conversation_config to update.");
  const agent = cc["agent"];
  if (!isRecord(agent)) throw new Error("Agent config has no conversation_config.agent to update.");
  const prompt = agent["prompt"];
  if (!isRecord(prompt)) throw new Error("Agent config has no conversation_config.agent.prompt to update.");

  // GET returns BOTH `tools` (the tool definitions, expanded for reading)
  // and `tool_ids` (the same tools by reference — the canonical, writable
  // form) under prompt. Sending both back on a PATCH is rejected outright:
  // "Cannot specify both tools and tool IDs" (confirmed against a real
  // agent — this agent's `tools` array is exactly `tool_ids` expanded, plus
  // the voicemail-detection system tool, which is separately configured via
  // `built_in_tools` and doesn't need to travel through `tools` either).
  // Drop `tools`, keep `tool_ids` — never both.
  const { tools: _expandedTools, ...promptWithoutExpandedTools } = prompt;
  void _expandedTools;
  const updatedPrompt = { ...promptWithoutExpandedTools, prompt: newPromptText };
  const updatedAgent = { ...agent, prompt: updatedPrompt };
  const updatedConversationConfig = { ...cc, agent: updatedAgent };

  await call(`/convai/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify({ conversation_config: updatedConversationConfig }),
  });
}

/** True (not an error) when the agent is already gone — teardown must be idempotent. */
export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`${BASE}/convai/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": required("ELEVENLABS_API_KEY") },
    cache: "no-store",
  });

  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`ElevenLabs DELETE /convai/agents/${agentId} failed (${response.status}): ${body.slice(0, 500)}`);
  }
}
