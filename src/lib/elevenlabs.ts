/**
 * ElevenLabs batch-calling client.
 *
 * Endpoints verified against elevenlabs.io/docs/api-reference/batch-calling
 * (17 Aug 2026):
 *   POST /v1/convai/batch-calling/submit
 *   GET  /v1/convai/batch-calling/{batch_id}
 *   POST /v1/convai/batch-calling/{batch_id}/cancel
 *
 * We deliberately do NOT hand ElevenLabs a whole run at once, and we do not
 * use its `scheduled_time_unix` field. Our own dispatcher owns the schedule so
 * the calling-hours guard stays in our control and a run can be paused at a
 * window boundary and resumed the next morning.
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

/** Sanity check used by the settings page — confirms the key and agent exist. */
export async function checkAgent(): Promise<{ ok: boolean; detail: string }> {
  try {
    const agentId = required("ELEVENLABS_AGENT_ID");
    const agent = await call<{ name?: string; agent_id?: string }>(
      `/convai/agents/${encodeURIComponent(agentId)}`,
    );
    return {
      ok: true,
      detail: `Connected to agent "${agent.name ?? agentId}".`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
