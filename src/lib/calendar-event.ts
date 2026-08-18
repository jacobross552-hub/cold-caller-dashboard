/**
 * Pulling the booked calendar event out of a post-call webhook.
 *
 * Verified against a real ElevenLabs payload (conversation
 * conv_2201m08wdf5cf5793cxrgkb585qz, 18 Aug 2026). The shape is:
 *
 *   turn N     -> tool_calls:   [{ tool_name: "google_calendar_create_event", ... }]
 *   turn N+1   -> tool_results: [{ tool_name: "google_calendar_create_event",
 *                                  result_value: "<JSON STRING>",
 *                                  is_error: false }]
 *
 * Two things that bite:
 *   1. `result_value` is a JSON *string*, not an object — it must be parsed.
 *   2. The result and the call sit on DIFFERENT turns.
 *
 * Inside the parsed result, the Meet link appears twice:
 *   hangoutLink: "https://meet.google.com/jpu-zurh-bks"
 *   conferenceData.entryPoints[] : { entryPointType: "video", uri: "https://meet.google.com/..." }
 * We read hangoutLink first and fall back to entryPoints, then to a plain
 * text search, so a shape change doesn't silently drop the link.
 */

import type { TranscriptTurn } from "./outcomes";

/** Tool names that mean a booking was actually created (not just checked). */
const BOOKING_TOOLS = ["create_event", "book_appointment", "create_appointment"];

const MEET_URL = /https:\/\/meet\.google\.com\/[a-z0-9-]+/i;

export interface BookedEvent {
  /** True only when the calendar tool returned successfully. */
  created: boolean;
  meetLink?: string;
  /** Link to the event in Google Calendar's web UI. */
  eventLink?: string;
  /** ISO start time as Google returned it, e.g. 2026-08-20T10:00:00+10:00 */
  startsAt?: string;
  summary?: string;
  /** Populated when the calendar tool was called but errored. */
  error?: string;
}

function isBookingTool(name: unknown): boolean {
  return typeof name === "string" && BOOKING_TOOLS.some((t) => name.includes(t));
}

/** Dig a Meet URL out of a parsed calendar event, trying each known location. */
function meetLinkFrom(event: Record<string, unknown>, rawText: string): string | undefined {
  const hangout = event.hangoutLink;
  if (typeof hangout === "string" && hangout) return hangout;

  const conference = event.conferenceData as
    | { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
    | undefined;

  const entries = conference?.entryPoints;
  if (Array.isArray(entries)) {
    const video = entries.find((e) => e?.entryPointType === "video" && e.uri);
    if (video?.uri) return video.uri;
    const anyUri = entries.find((e) => typeof e?.uri === "string" && MEET_URL.test(e.uri!));
    if (anyUri?.uri) return anyUri.uri;
  }

  // Last resort: the raw result text. Catches shapes we haven't seen.
  return rawText.match(MEET_URL)?.[0];
}

/**
 * Find the booking made on this call, if any.
 * Returns null when no booking tool was called at all.
 */
export function findBookedEvent(transcript: TranscriptTurn[] | undefined): BookedEvent | null {
  if (!Array.isArray(transcript)) return null;

  let attempted = false;
  let lastError: string | undefined;

  for (const turn of transcript) {
    const results = turn.tool_results;
    if (!Array.isArray(results)) continue;

    for (const result of results as Array<Record<string, unknown>>) {
      if (!isBookingTool(result?.tool_name)) continue;
      attempted = true;

      if (result.is_error === true) {
        lastError =
          typeof result.raw_error_message === "string" && result.raw_error_message
            ? result.raw_error_message
            : typeof result.result_value === "string"
              ? result.result_value
              : "calendar tool returned an error";
        continue;
      }

      const raw = typeof result.result_value === "string" ? result.result_value : "";
      let event: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") event = parsed as Record<string, unknown>;
      } catch {
        // Not JSON — still try the text search below.
      }

      const start = event.start as { dateTime?: string; date?: string } | undefined;

      return {
        created: true,
        meetLink: meetLinkFrom(event, raw),
        eventLink: typeof event.htmlLink === "string" ? event.htmlLink : undefined,
        startsAt: start?.dateTime ?? start?.date,
        summary: typeof event.summary === "string" ? event.summary : undefined,
      };
    }
  }

  // A booking tool ran but every attempt failed.
  if (attempted) return { created: false, error: lastError };

  // Tool was called but no result came back in the payload.
  const calledWithoutResult = transcript.some(
    (turn) =>
      Array.isArray(turn.tool_calls) &&
      (turn.tool_calls as Array<Record<string, unknown>>).some((c) => isBookingTool(c?.tool_name)),
  );
  if (calledWithoutResult) return { created: false, error: "no result returned for the booking" };

  return null;
}

/**
 * Format the Meet link for an SMS. Google Meet links are short enough to sit
 * inside a single 160-character segment alongside the rest of the message.
 */
function meetLinkLine(event: BookedEvent | null): string {
  return event?.meetLink ? ` Join: ${event.meetLink}` : "";
}

/**
 * Build the booking-alert SMS body.
 *
 * Kept as a pure function so it can be tested without a database or Twilio.
 * When there's no Meet link — no calendar event, or the tool failed — the
 * message degrades to the plain confirmation rather than erroring.
 */
export function buildBookingSms(params: {
  business: string;
  when: string;
  /** Optional trailing sentence, e.g. the weekly loss figure. Include its own full stop. */
  figureLine?: string;
  event: BookedEvent | null;
}): string {
  const figure = params.figureLine ? `${params.figureLine} ` : "";
  return (
    `MEETING BOOKED: ${params.business} — ${params.when}.` +
    meetLinkLine(params.event) +
    ` ${figure}Full brief in the dashboard.`
  );
}
