/**
 * Call analysis: the plain-English summary and the pre-call briefing.
 *
 * This is the part ElevenLabs' own dashboard doesn't give you. It reads the
 * transcript and pulls out the things you'd want in your head before walking
 * into the demo: the numbers they gave, what they pushed back on, what they
 * seemed to care about, and any price already quoted.
 *
 * Two hard rules, enforced in the prompt and re-checked in code:
 *   1. Nothing is invented. Every figure must have been said out loud on the
 *      call. Anything not said comes back null.
 *   2. Pricing is checked against the table in pricing-engine-notes.md rather
 *      than trusted — the agent quoting off-table is exactly the kind of thing
 *      worth knowing before the demo.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config, required } from "./env";
import { checkQuoteAgainstTable, type QuoteCheck } from "./pricing";
import {
  spokenTurns,
  transcriptToText,
  type Outcome,
  type WebhookCallData,
} from "./outcomes";
import { findBookedEvent, type BookedEvent } from "./calendar-event";

/**
 * Tell the model what the calendar tool actually did, so it doesn't have to
 * infer a booking from the conversation alone. A failed booking is stated as
 * failed — the agent may well have told the prospect it was booked.
 */
function describeBooking(event: BookedEvent | null): string {
  if (!event) return "no booking tool was called";
  if (!event.created) return `booking tool FAILED (${event.error ?? "unknown error"}) — no event exists`;
  return (
    "event created successfully" +
    (event.startsAt ? ` for ${event.startsAt}` : "") +
    (event.meetLink ? ` with Meet link ${event.meetLink}` : "")
  );
}

/**
 * The stages of the call, taken from the flow in system-prompt-v8.txt.
 * Knowing how far a call got is the metric the handover doc says to judge
 * the script on ("judge the script on how far into the call people get").
 */
export const CALL_STAGES = [
  "no_contact",
  "opener",
  "permission_granted",
  "questions_asked",
  "numbers_given",
  "maths_done",
  "demo_offered",
  "booked",
] as const;

export const STAGE_LABELS: Record<(typeof CALL_STAGES)[number], string> = {
  no_contact: "Never got going",
  opener: "Died on the opener",
  permission_granted: "Got permission, then died",
  questions_asked: "Reached the two questions",
  numbers_given: "Gave their numbers",
  maths_done: "Heard the loss figure",
  demo_offered: "Demo offered",
  booked: "Meeting booked",
};

const AnalysisSchema = z.object({
  summary: z
    .string()
    .describe(
      "Two to four sentences of plain English describing what actually happened on this call, as you would tell a colleague. No jargon, no bullet points.",
    ),
  business_description: z
    .string()
    .nullable()
    .describe("What the business does, in their own words. Null if they never said."),
  missed_calls_per_week: z
    .number()
    .nullable()
    .describe("The number of missed calls per week the prospect gave. Null if they never gave one."),
  job_value_dollars: z
    .number()
    .nullable()
    .describe("The average job value in dollars the prospect gave. Null if they never gave one."),
  raw_weekly_loss: z
    .number()
    .nullable()
    .describe("The undiscounted weekly figure stated on the call, in dollars. Null if not stated."),
  discounted_weekly_loss: z
    .number()
    .nullable()
    .describe(
      "The discounted weekly figure (roughly a third of raw) that the agent presented as the real number. This is X. Null if not stated.",
    ),
  figure_agreed: z
    .enum(["agreed", "disputed", "not_discussed"])
    .describe("How the prospect responded to 'does that sound about right to you?'"),
  prospect_own_figure: z
    .number()
    .nullable()
    .describe("If they disputed the number and gave their own, that figure. Otherwise null."),
  price_quoted: z.boolean().describe("Did the agent state a price on this call?"),
  quoted_setup_fee: z
    .number()
    .nullable()
    .describe("The setup fee quoted, in dollars. Null if none was quoted."),
  quoted_monthly_retainer: z
    .number()
    .nullable()
    .describe("The monthly retainer quoted, in dollars. Null if none was quoted."),
  objections: z
    .array(
      z.object({
        objection: z.string().describe("Short label, e.g. 'tried it before' or 'too busy'."),
        what_they_said: z.string().describe("A short quote or close paraphrase."),
        how_it_landed: z
          .string()
          .describe("Whether the agent's answer satisfied them, and how they reacted."),
      }),
    )
    .describe("Every objection the prospect raised. Empty array if none."),
  cared_about: z
    .array(z.string())
    .describe(
      "Things the prospect showed real interest or concern about, in short phrases. Base this only on what they said.",
    ),
  booking: z.object({
    booked: z.boolean().describe("Was a demo actually agreed and booked?"),
    day: z.string().nullable().describe("The day agreed, as said on the call."),
    time: z.string().nullable().describe("The time agreed, as said on the call."),
    email: z.string().nullable().describe("Email address given, if any."),
  }),
  furthest_stage: z
    .enum(CALL_STAGES)
    .describe("The furthest point in the call flow this call reached."),
  asked_if_ai: z.boolean().describe("Did the prospect ask whether they were talking to a bot?"),
  do_not_call_requested: z
    .boolean()
    .describe("Did they ask to be removed from the list or not called again?"),
  talking_points: z
    .array(z.string())
    .describe(
      "Two to five things worth knowing before the demo call. Only include what follows from this transcript.",
    ),
  agent_slips: z
    .array(z.string())
    .describe(
      "Places where the agent broke its own rules: appraising the prospect's business rather than using what they said, stating a figure then going silent, repeating an acknowledgement, or quoting an unsourced statistic. Empty array if none.",
    ),
});

export type CallAnalysis = z.infer<typeof AnalysisSchema>;

const SYSTEM_PROMPT = `You are reading the transcript of an outbound cold call and extracting a factual record of it.

THE CALL YOU ARE READING
The caller is "Jacob", an AI voice agent selling AI phone-answering systems to Australian small businesses. Its only goal on the call is to book a free fifteen-minute video demo. The scripted flow is:
1. Opener — asks for twenty seconds.
2. Reason + bridge — says what he does, offers two quick questions.
3. Question one — roughly how many calls a week get missed or go to voicemail.
4. Question two — what a job is worth on average.
5. The maths — multiplies the two out loud, then DISCOUNTS it to roughly a third and presents that smaller number as the real one, ending on "does that sound about right to you?"
6. Pivot, offer the demo, ask what day suits.
7. Narrow to a time.
8. Book it with the calendar tool.
If asked, the agent quotes a real setup fee and monthly retainer. If asked whether it is AI, it says yes.

YOUR RULES
- Report only what was actually said. If a number was never spoken, return null for it. Never estimate, never infer a figure from another figure, never carry a number over from your own arithmetic.
- The discounted weekly figure is the one the agent presents as the real number after cutting the raw total to roughly a third. Do not confuse it with the raw total.
- Dollar figures are spoken as words ("thirteen hundred a week", "thirty-eight hundred"). Convert to plain numbers: 1300, 3800.
- For "cared_about", only list things the prospect themselves showed interest or concern about. Do not infer what a business like theirs would probably care about.
- Write the summary the way you would describe the call to a colleague who asked how it went. Say what happened and how it ended. No sales language, no evaluation of the prospect's business.
- If the transcript is empty, near-empty, or an answering machine, say so plainly and return nulls throughout.`;

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });
  return client;
}

export interface AnalysisResult {
  analysis: CallAnalysis;
  quoteCheck: QuoteCheck;
}

/**
 * Run the analysis over one call's transcript.
 * Throws if the Anthropic key is missing or the call fails — the caller
 * records the error against the call and carries on.
 */
export async function analyseCall(
  data: WebhookCallData,
  context: { businessName?: string | null; phone?: string | null },
): Promise<AnalysisResult> {
  const transcript = transcriptToText(data.transcript);

  const response = await anthropic().messages.parse({
    model: config.anthropicModel,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "low",
      format: zodOutputFormat(AnalysisSchema),
    },
    messages: [
      {
        role: "user",
        content: [
          `Business called: ${context.businessName ?? "unknown"}`,
          `Number: ${context.phone ?? "unknown"}`,
          `Call length: ${data.metadata?.call_duration_secs ?? "unknown"} seconds`,
          `Calendar booking tool result: ${describeBooking(findBookedEvent(data.transcript))}`,
          "",
          "TRANSCRIPT",
          transcript || "(no speech was recorded on this call)",
        ].join("\n"),
      },
    ],
  });

  const analysis = response.parsed_output;
  if (!analysis) {
    throw new Error("Analysis returned no structured output.");
  }

  return {
    analysis,
    quoteCheck: checkQuoteAgainstTable(
      analysis.discounted_weekly_loss ?? analysis.prospect_own_figure,
      analysis.quoted_setup_fee,
      analysis.quoted_monthly_retainer,
    ),
  };
}

/**
 * Calls with nothing said on them don't need an LLM. Returns a canned summary
 * for those, or null when the call is worth analysing properly.
 */
export function trivialSummary(data: WebhookCallData, outcome: Outcome): string | null {
  const turns = spokenTurns(data.transcript);
  const userTurns = turns.filter((t) => t.role === "user");

  if (outcome === "voicemail") {
    return "Hit an answering machine. The agent said nothing and ended the call, as scripted.";
  }
  if (outcome === "no_answer") {
    return "No answer — nobody picked up.";
  }
  if (outcome === "failed") {
    return "The call failed to connect properly.";
  }
  if (userTurns.length === 0) {
    return "Connected, but the other end never said anything.";
  }
  return null;
}

/**
 * If the analysis shows the call got as far as the offer, upgrade the
 * mechanical outcome from "connected" to "completed".
 */
export function refineOutcome(current: Outcome, analysis: CallAnalysis): Outcome {
  if (current !== "connected") return current;
  if (analysis.furthest_stage === "demo_offered" || analysis.furthest_stage === "booked") {
    return "completed";
  }
  return current;
}
