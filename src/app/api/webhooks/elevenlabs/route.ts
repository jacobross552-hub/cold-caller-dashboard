/**
 * ElevenLabs post-call webhook.
 *
 * Fires when a call ends, carrying the transcript and call metadata. The
 * signature is verified with the official SDK helper rather than a hand-rolled
 * HMAC — it checks the `t=…,v0=…` header, the 30-minute timestamp tolerance,
 * and the digest, and refuses the payload if any of it is wrong.
 *
 * This route is deliberately outside the login gate (ElevenLabs can't log in);
 * the signature is what authenticates it.
 */

import { NextResponse } from "next/server";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { optional } from "@/lib/env";
import { logEvent } from "@/lib/db";
import { analyseAndStore, recordCall } from "@/lib/calls";
import type { WebhookCallData } from "@/lib/outcomes";

export const runtime = "nodejs";
// Never cache — every delivery must be processed.
export const dynamic = "force-dynamic";

interface PostCallWebhook {
  type?: string;
  event_timestamp?: number;
  data?: WebhookCallData;
}

export async function POST(request: Request) {
  const secret = optional("ELEVENLABS_WEBHOOK_SECRET");
  if (!secret) {
    logEvent("webhook.rejected", "Webhook arrived but ELEVENLABS_WEBHOOK_SECRET isn't set.");
    return NextResponse.json({ error: "Webhook secret not configured." }, { status: 500 });
  }

  // Must be the raw body — parsing and re-serialising would break the digest.
  const rawBody = await request.text();
  const signature =
    request.headers.get("elevenlabs-signature") ?? request.headers.get("ElevenLabs-Signature");

  let event: PostCallWebhook;
  try {
    const client = new ElevenLabsClient({ apiKey: optional("ELEVENLABS_API_KEY") ?? "unused" });
    event = (await client.webhooks.constructEvent(rawBody, signature ?? "", secret)) as PostCallWebhook;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("webhook.rejected", `Rejected a webhook with a bad signature: ${detail}`);
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  if (event.type && event.type !== "post_call_transcription") {
    // Other event types (audio, etc.) aren't used here.
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  const data = event.data;
  if (!data?.conversation_id) {
    return NextResponse.json({ error: "Payload had no conversation_id." }, { status: 400 });
  }

  let callId: number;
  try {
    ({ callId } = recordCall(data));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("webhook.error", `Failed to store call ${data.conversation_id}: ${detail}`);
    return NextResponse.json({ error: "Failed to store call." }, { status: 500 });
  }

  // Acknowledge fast, then summarise. ElevenLabs shouldn't wait on Claude.
  void analyseAndStore(callId).catch((err) =>
    logEvent("call.analysis_failed", `Background analysis failed for call ${callId}`, String(err)),
  );

  return NextResponse.json({ ok: true, callId });
}

/** Lets you confirm the URL is reachable from a browser before going live. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message:
      "ElevenLabs post-call webhook endpoint is live. Point your ElevenLabs post-call webhook at this URL (POST).",
  });
}
