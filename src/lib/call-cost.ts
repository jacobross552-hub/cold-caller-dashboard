/**
 * Reading ElevenLabs' own cost figures off a post-call webhook.
 *
 * Its own module, with no imports at all, because three very different places
 * need it: the live webhook, the boot-time backfill inside db.ts, and the
 * costs aggregation. db.ts cannot import costs.ts (costs.ts imports db.ts), so
 * the shared piece lives here rather than being written out three times.
 */

/**
 * WATCH OUT FOR THE `cost` FIELD. `metadata.cost` is ElevenLabs CREDITS, not
 * money — a 157-second call reports 2092. Summing that column into a dollar
 * figure produces nonsense. The real money is `metadata.cost_fiat` (USD), and
 * `metadata.charging` splits it:
 *
 *     cost_fiat = charging.platform_price + charging.llm_price
 *
 * platform_price is speech synthesis, transcription and telephony;
 * llm_price is the model the agent thinks with, which ElevenLabs bills
 * directly and which has nothing to do with the dashboard's Anthropic key.
 *
 * Shared by the live webhook and the backfill script so both read the payload
 * the same way.
 */
export interface CallFiatCost {
  costFiatUsd: number | null;
  platformPriceUsd: number | null;
  llmPriceUsd: number | null;
  /**
   * ElevenLabs' own billable-minute count for the call. This is what the
   * plan's included-minutes pool is drawn against, and it runs slightly under
   * wall-clock duration — so pool accounting must use this rather than
   * duration_secs / 60.
   */
  platformMinutes: number | null;
  /**
   * Twilio's id for the same call. ElevenLabs dials through our own Twilio
   * number, so Twilio bills the minutes separately; this is what lets the real
   * charge be fetched back afterwards.
   */
  twilioCallSid: string | null;
}

/**
 * Deliberately loose: this is somebody else's payload, read defensively. A
 * missing or reshaped field yields null rather than throwing or, worse,
 * quietly becoming a zero.
 */
export function extractCallCost(
  metadata: Record<string, unknown> | null | undefined,
): CallFiatCost {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

  const charging = obj(metadata?.charging);

  const platform = num(charging?.platform_price);
  const llm = num(charging?.llm_price);
  const total = num(metadata?.cost_fiat);

  // charging.platform_usage.category_usage.voice.quantity — nested four deep
  // in someone else's payload, so every level is guarded.
  const platformUsage = obj(charging?.platform_usage);
  const categoryUsage = obj(platformUsage?.category_usage);
  const voice = obj(categoryUsage?.voice);

  const phoneCall = obj(metadata?.phone_call);
  const sid = typeof phoneCall?.call_sid === "string" ? phoneCall.call_sid : null;

  return {
    // Prefer what ElevenLabs called the total; fall back to the two halves so
    // an older payload shape still yields a usable figure.
    costFiatUsd: total ?? (platform !== null || llm !== null ? (platform ?? 0) + (llm ?? 0) : null),
    platformPriceUsd: platform,
    llmPriceUsd: llm,
    platformMinutes: num(voice?.quantity),
    twilioCallSid: sid,
  };
}
