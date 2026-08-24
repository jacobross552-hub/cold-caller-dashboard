/**
 * Turning a raw post-call webhook into "what actually happened".
 *
 * Done mechanically, with no LLM involved, so the call log is correct even if
 * the Anthropic key is missing or the summary step fails. The plain-English
 * summary and the pre-call brief are layered on top separately.
 */

import { findBookedEvent } from "./calendar-event";

export type Outcome =
  | "voicemail"
  | "no_answer"
  | "hung_up_early"
  | "connected"
  | "completed"
  | "failed";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  voicemail: "Voicemail",
  no_answer: "No answer",
  hung_up_early: "Hung up early",
  connected: "Connected",
  completed: "Full conversation",
  failed: "Failed",
};

/**
 * Outcomes where a real person picked up and engaged, even briefly — the
 * "answered" stage of the answered → booked → bought funnel. Voicemail is an
 * answering machine, not a person; no_answer and failed never connected at all.
 */
export const ANSWERED_OUTCOMES: Outcome[] = ["hung_up_early", "connected", "completed"];

export const OUTCOME_EXPLANATIONS: Record<Outcome, string> = {
  voicemail:
    "Hit an answering machine. Per the script the agent says nothing and ends the call, so these cost seconds, not minutes.",
  no_answer: "Nobody picked up, or the call never connected.",
  hung_up_early:
    "Answered, then ended within about 20 seconds or before saying anything much — usually a hang-up on the opener.",
  connected:
    "A real conversation happened, but it ended before the demo was offered.",
  completed:
    "The call ran its course — the demo was offered, or a booking was made.",
  failed: "The call errored out at the telephony layer.",
};

export interface TranscriptTurn {
  role: string;
  message?: string | null;
  tool_calls?: unknown;
  tool_results?: unknown;
  time_in_call_secs?: number;
}

export interface WebhookCallData {
  conversation_id: string;
  status?: string;
  transcript?: TranscriptTurn[];
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    cost?: number;
    termination_reason?: string;
    [key: string]: unknown;
  };
  analysis?: {
    transcript_summary?: string;
    call_successful?: string;
    evaluation_criteria_results?: Record<string, unknown>;
    data_collection_results?: Record<string, unknown>;
  };
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

const VOICEMAIL_HINTS = ["voicemail", "answering_machine", "answering machine", "machine_detected"];

/**
 * Tool names that mean a booking was actually made.
 *
 * Named explicitly rather than matching on "calendar", because the live agent
 * carries BOTH `google_calendar_create_event` and
 * `google_calendar_check_availability`. A loose "calendar" match would count
 * merely checking the diary as a booked meeting — which would put calls on the
 * meetings page that never booked anything.
 */
const BOOKING_TOOL_PATTERNS = ["create_event", "book_appointment", "create_appointment"];

/** Extract just the spoken turns, dropping empty/tool-only entries. */
export function spokenTurns(transcript: TranscriptTurn[] | undefined): TranscriptTurn[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.filter(
    (turn) => typeof turn.message === "string" && turn.message.trim().length > 0,
  );
}

/**
 * Did the agent call the calendar tool? This is the strongest booking signal —
 * a tool call actually happened, rather than the agent merely talking about
 * a day and time.
 */
export function calendarToolWasCalled(transcript: TranscriptTurn[] | undefined): boolean {
  if (!Array.isArray(transcript)) return false;

  for (const turn of transcript) {
    for (const field of [turn.tool_calls, turn.tool_results]) {
      if (!field) continue;
      const text = JSON.stringify(field).toLowerCase();
      if (BOOKING_TOOL_PATTERNS.some((pattern) => text.includes(pattern))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Did a booking actually get CREATED — not merely attempted?
 *
 * Distinct from `calendarToolWasCalled` on purpose. A `create_event` call that
 * comes back with `is_error: true` means no event exists, so the call must not
 * be flagged as booked or it turns up on the meetings page with a briefing for
 * a demo that was never in the diary.
 */
export function bookingWasCreated(transcript: TranscriptTurn[] | undefined): boolean {
  return findBookedEvent(transcript)?.created === true;
}

export function classifyOutcome(data: WebhookCallData): Outcome {
  const duration = data.metadata?.call_duration_secs ?? 0;
  const termination = (data.metadata?.termination_reason ?? "").toLowerCase();
  const status = (data.status ?? "").toLowerCase();
  const turns = spokenTurns(data.transcript);
  const userTurns = turns.filter((t) => t.role === "user");

  if (VOICEMAIL_HINTS.some((hint) => termination.includes(hint) || status.includes(hint))) {
    return "voicemail";
  }

  if (status === "failed" || termination.includes("error")) {
    return "failed";
  }

  // Nobody ever spoke back — either no answer, or it never connected.
  if (userTurns.length === 0) {
    // A long one-sided call with agent speech is an undetected answering machine.
    if (duration > 25 && turns.length > 1) return "voicemail";
    return "no_answer";
  }

  // Answered but bailed almost immediately.
  if (duration < 20 || userTurns.length <= 1) {
    return "hung_up_early";
  }

  // Booking made means the call definitely ran its course.
  if (calendarToolWasCalled(data.transcript)) return "completed";

  return "connected";
}

/** Flatten the transcript into "Jacob: ... / Prospect: ..." lines. */
export function transcriptToText(transcript: TranscriptTurn[] | undefined): string {
  return spokenTurns(transcript)
    .map((turn) => {
      const speaker = turn.role === "agent" ? "Jacob" : "Prospect";
      return `${speaker}: ${turn.message!.trim()}`;
    })
    .join("\n");
}
