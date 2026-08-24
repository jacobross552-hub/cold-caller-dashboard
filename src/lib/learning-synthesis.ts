/**
 * Tier 3 of the weekly learning pipeline: one call to the stronger model,
 * reading ONLY the aggregated stats from learning.ts's aggregateWeek() —
 * never raw transcripts — plus the current live agent prompt and the list of
 * previously rejected proposals.
 *
 * Split into its own file (rather than living in learning.ts alongside the
 * orchestrator that calls it) so it can be stubbed at the module boundary in
 * tests, the same way brief.ts's analyseCall is stubbed by test-integration.ts —
 * a same-file function reference can't be monkey-patched from outside, an
 * imported one can.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config, required } from "./env";
import type { WeeklyStats } from "./learning";

const ProposalSchema = z.object({
  category: z.enum(["script", "pricing", "lead_targeting", "other"]),
  title: z.string().describe("One line, plain English."),
  reasoning: z
    .string()
    .describe("The specific metric(s) behind this proposal, citing real numbers from the stats you were given — never a vague impression."),
  confidence: z
    .string()
    .describe(
      "How confident this should be treated, stated with the sample size it's based on — e.g. 'low (N=3) — worth watching, not acting on' or 'moderate (N=14 objections of this type)'.",
    ),
  sample_size: z.number().nullable().describe("The N behind this proposal. Null only if genuinely not applicable."),
  new_prompt_text: z
    .string()
    .nullable()
    .describe(
      "REQUIRED and COMPLETE for category='script' — the entire new system prompt, verbatim, with your proposed change applied and nothing else altered. Null for every other category.",
    ),
});

const SynthesisSchema = z.object({
  proposals: z.array(ProposalSchema),
  overall_notes: z
    .string()
    .describe("A short paragraph on anything worth knowing this week that isn't captured as a specific proposal — can be empty."),
});

export type Proposal = z.infer<typeof ProposalSchema>;

/** Exported so learning.ts's code-level backstop and the UI can both cite the same threshold. */
export const MIN_PRICING_SAMPLE = 5;

function statsSummaryForPrompt(stats: WeeklyStats): string {
  return JSON.stringify(
    {
      window: { start: new Date(stats.windowStart).toISOString(), end: new Date(stats.windowEnd).toISOString() },
      calls_analysed: stats.callsAnalysed,
      outcome_breakdown: stats.outcomeBreakdown,
      furthest_stage_breakdown: stats.furthestStageBreakdown,
      asked_if_ai_count: stats.askedIfAiCount,
      figure_agreed_breakdown: stats.figureAgreedBreakdown,
      objection_counts: stats.objectionCounts,
      agent_slips: stats.agentSlips,
      price_quote_check_breakdown: stats.quoteCheckBreakdown,
      pricing_recommended_vs_actually_charged: stats.pricingVsActual,
      conversion_funnel: stats.funnel,
      finance: {
        revenue_aud: stats.finance.revenueAud,
        revenue_provenance: stats.finance.revenueProvenance,
        cost_aud: stats.finance.costAud,
        profit_aud: stats.finance.profitAud,
      },
    },
    null,
    2,
  );
}

export interface PriorRejection {
  category: string;
  title: string;
  reasoning: string;
  rejected_reason: string;
}

function synthesisSystemPrompt(currentPrompt: string, priorRejections: PriorRejection[]): string {
  return `You are the weekly reviewer for an AI cold-calling sales operation. You read aggregated, ANONYMISED
statistics about the past week's calls, bookings, deals, and finances, and propose concrete improvements.
You never see raw transcripts — only the numbers you're given.

WHAT YOU'RE LOOKING AT
The agent ("Jacob") cold-calls Australian small businesses to book a demo of an AI phone-answering product.
The live system prompt driving every call is included below, verbatim.

RULES
- Every proposal must cite a specific number from the stats you were given. "Objection X seems common" is not
  good enough — say how many times, out of how many calls.
- State your confidence AND the sample size behind it, explicitly, in the confidence field. Be honest when a
  sample is too small to act on — say so rather than proposing off 2-3 data points.
- For category="pricing": only propose a pricing-table change with at least ${MIN_PRICING_SAMPLE} real Won/Lost
  outcomes behind it. Below that, do not propose it — note it in overall_notes as "not enough data yet" instead.
- For category="script": new_prompt_text must be the ENTIRE current prompt with your change applied — not a
  snippet, not an instruction to change it, the complete text. Never invent content not supported by the stats;
  a wording change should trace to a specific pattern in the data (e.g. an objection that recurs, a stage where
  calls consistently die).
- Do not propose anything from the REJECTED PROPOSALS list below again unless you have genuinely new evidence —
  if you do, say explicitly what's new and different this time.
- If nothing in the data supports a change, return an empty proposals array. A quiet week with no proposals is
  a correct answer, not a failure.

REJECTED PROPOSALS FROM PAST WEEKS (do not repeat without new evidence)
${priorRejections.length === 0 ? "(none yet)" : priorRejections.map((r) => `- [${r.category}] ${r.title} — proposed because: ${r.reasoning} — REJECTED because: ${r.rejected_reason}`).join("\n")}

CURRENT LIVE SYSTEM PROMPT (verbatim — any script proposal must be a complete replacement of this text)
"""
${currentPrompt}
"""`;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });
  return client;
}

export interface SynthesisResult {
  proposals: Proposal[];
  overallNotes: string;
  usage: { model: string; inputTokens: number; outputTokens: number };
}

export async function synthesizeProposals(
  stats: WeeklyStats,
  currentPrompt: string,
  priorRejections: PriorRejection[],
): Promise<SynthesisResult> {
  const response = await anthropic().messages.parse({
    model: config.anthropicModel,
    max_tokens: 8000,
    system: synthesisSystemPrompt(currentPrompt, priorRejections),
    output_config: { effort: "medium", format: zodOutputFormat(SynthesisSchema) },
    messages: [{ role: "user", content: `THIS WEEK'S AGGREGATED STATS\n${statsSummaryForPrompt(stats)}` }],
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Synthesis returned no structured output.");

  return {
    proposals: parsed.proposals,
    overallNotes: parsed.overall_notes,
    usage: {
      model: config.anthropicModel,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}
