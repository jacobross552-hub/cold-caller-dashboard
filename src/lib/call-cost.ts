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

  const charging =
    metadata && typeof metadata.charging === "object" && metadata.charging !== null
      ? (metadata.charging as Record<string, unknown>)
      : null;

  const platform = num(charging?.platform_price);
  const llm = num(charging?.llm_price);
  const total = num(metadata?.cost_fiat);

  return {
    // Prefer what ElevenLabs called the total; fall back to the two halves so
    // an older payload shape still yields a usable figure.
    costFiatUsd: total ?? (platform !== null || llm !== null ? (platform ?? 0) + (llm ?? 0) : null),
    platformPriceUsd: platform,
    llmPriceUsd: llm,
  };
}
