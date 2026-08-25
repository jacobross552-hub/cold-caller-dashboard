/**
 * Twilio's own figures: what a call actually cost, and what this account
 * actually pays. Replaces the flat per-minute rates that used to be typed into
 * `.env`, which were wrong in three separate ways:
 *
 *   1. ONE RATE CANNOT COVER THE CALL LIST. AU landline and AU mobile are about
 *      three times apart (~$0.0252 vs ~$0.0750 a minute) and the list is a mix,
 *      so any single figure is wrong for most of the calls it prices.
 *   2. NUMBER RENTAL WAS NEVER MODELLED. The monthly fee for the number itself
 *      simply did not appear anywhere in the cost page.
 *   3. A TYPED RATE GOES STALE IN SILENCE. Twilio changes prices; a number in
 *      `.env` does not, and nothing ever tells you it has drifted.
 *
 * Twilio exposes both the real per-account rates and the actual charged amounts
 * over the API, using credentials the app already holds, so there is no reason
 * to be guessing.
 *
 * TWO TRAPS WORTH KNOWING BEFORE YOU CHANGE ANYTHING HERE:
 *
 * A price of `null` means "Twilio has not settled the charge yet", NOT "free".
 * Settlement lags the end of a call by minutes, so null is the normal answer
 * immediately after a call, and callers must show it as pending rather than as
 * $0.00. That is why every money field is `number | null` and never defaults.
 *
 * The currency is NOT assumed to be USD. The account currency is unconfirmed
 * and Twilio reports it per response, so every amount here is returned with the
 * `price_unit` Twilio gave it. Nothing in this file hardcodes a currency, and
 * nothing downstream should either.
 *
 * Style follows `sms.ts`: plain `fetch` with HTTP Basic, no SDK. Nothing throws
 * — a pricing lookup is decoration on a page, and must never be able to break
 * one. Failures return null (or an empty array) and land in the event log.
 */

import { optional } from "./env";
import { logEvent } from "./db";

/** Actual charges (what was billed). */
const API_BASE = "https://api.twilio.com";
/** Published rates for this account (what things cost). */
const PRICING_BASE = "https://pricing.twilio.com";

/**
 * These lookups can happen during a server render, so a Twilio that has gone
 * slow must lose the race rather than hold the page open. A missing price is a
 * far smaller problem than a page that never arrives.
 */
const TIMEOUT_MS = 5_000;

/**
 * True when all Twilio credentials needed to call the API are present.
 *
 * Only the account SID and auth token, deliberately: every endpoint in this
 * file is a read, so TWILIO_FROM_NUMBER is irrelevant to it. Gating on the
 * from-number would hide real prices from an account that simply hasn't bought
 * a number yet — see `smsConfigured()` in sms.ts for the sending-side check,
 * which does need it.
 */
export function twilioConfigured(): boolean {
  return Boolean(optional("TWILIO_ACCOUNT_SID") && optional("TWILIO_AUTH_TOKEN"));
}

// --- Plumbing --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing and malformed lists both become an empty one, so callers can loop. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Twilio sends money as a string ("-0.0252", "0.00000") and sends null until
 * billing settles.
 *
 * The explicit empty/null guard is the whole point: `Number(null)` and
 * `Number("")` are both 0, which would quietly turn "not settled yet" into
 * "free" — the one confusion this file exists to prevent.
 */
function asMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = asText(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One GET, JSON back, never a throw.
 *
 * `what` is a plain-English label for the event log. The URL is deliberately
 * not logged: it carries the account SID. The auth header never appears in a
 * log or an error message under any circumstances.
 */
async function getJson(url: string, what: string): Promise<Record<string, unknown> | null> {
  const accountSid = optional("TWILIO_ACCOUNT_SID");
  const authToken = optional("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) {
    // Not worth an event: this is an account that isn't wired up, not a fault.
    // Callers who want to say so in the UI should ask twilioConfigured() first.
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      logEvent("twilio.lookup_failed", `${what} failed (${response.status})`, text.slice(0, 500));
      return null;
    }

    // A 200 with an unparseable body lands in the catch below, same as a
    // network failure. Either way the caller gets null and carries on.
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) {
      logEvent("twilio.lookup_failed", `${what} returned a body that wasn't an object`);
      return null;
    }
    return payload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("twilio.lookup_failed", `${what} failed`, detail);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- What was actually charged ---------------------------------------------

/** A charged amount as Twilio reports it. Never assume the currency is USD. */
export interface TwilioPrice {
  /** Twilio reports charges as a NEGATIVE string, e.g. "-0.0252". Positive here. */
  price: number | null;
  /** ISO currency, e.g. "USD" or "AUD". Null when Twilio hasn't populated it. */
  priceUnit: string | null;
}

async function fetchChargedPrice(
  resource: "Calls" | "Messages",
  sid: string,
  what: string,
): Promise<TwilioPrice | null> {
  const accountSid = optional("TWILIO_ACCOUNT_SID");
  if (!accountSid) return null;

  const payload = await getJson(
    `${API_BASE}/2010-04-01/Accounts/${accountSid}/${resource}/${encodeURIComponent(sid)}.json`,
    what,
  );
  if (!payload) return null;

  const raw = asMoney(payload["price"]);
  return {
    // Twilio states a charge as a negative because it is describing a debit
    // against the balance, not a rate. Flipped once, here, so that nothing
    // downstream has to remember to — and so a stray minus sign can never
    // sneak into a total.
    price: raw === null ? null : Math.abs(raw),
    priceUnit: asText(payload["price_unit"]),
  };
}

/**
 * Actual charge for one outbound call. Returns { price: null } when Twilio has
 * accepted the SID but not yet settled the price — that is the normal case for
 * minutes after a call ends, NOT an error.
 * Returns null only when the call could not be fetched at all (bad SID, auth
 * failure, network).
 */
export async function fetchCallPrice(callSid: string): Promise<TwilioPrice | null> {
  return fetchChargedPrice("Calls", callSid, "Call price lookup");
}

/**
 * Twilio's delivery states for an outbound message, in rough chronological
 * order. "delivered" is the only genuinely good outcome; "failed" and
 * "undelivered" both mean the recipient never got it (Twilio distinguishes
 * "we couldn't even send it" from "carrier rejected it after we sent it", but
 * neither is worth telling apart for a reminder text — both mean call them).
 */
export type TwilioMessageStatus =
  | "accepted"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed"
  | "canceled";

export interface TwilioMessageDetails extends TwilioPrice {
  status: TwilioMessageStatus | null;
  errorMessage: string | null;
}

/** Same API call as fetchMessagePrice, but also reads the delivery status Twilio returns in the same response — no extra request. */
export async function fetchMessageDetails(messageSid: string): Promise<TwilioMessageDetails | null> {
  const accountSid = optional("TWILIO_ACCOUNT_SID");
  if (!accountSid) return null;

  const payload = await getJson(
    `${API_BASE}/2010-04-01/Accounts/${accountSid}/Messages/${encodeURIComponent(messageSid)}.json`,
    "Message status lookup",
  );
  if (!payload) return null;

  const raw = asMoney(payload["price"]);
  const status = asText(payload["status"]);

  return {
    price: raw === null ? null : Math.abs(raw),
    priceUnit: asText(payload["price_unit"]),
    status: (status as TwilioMessageStatus) ?? null,
    errorMessage: asText(payload["error_message"]),
  };
}

/** Same contract as fetchCallPrice, for an SMS message SID. */
export async function fetchMessagePrice(messageSid: string): Promise<TwilioPrice | null> {
  return fetchChargedPrice("Messages", messageSid, "Message price lookup");
}

// --- What things cost -------------------------------------------------------
//
// Everything below reads `current_price` and ignores `base_price`. The Pricing
// API returns both: `base_price` is Twilio's list price, `current_price` is
// what THIS account actually pays once any negotiated discount is applied.
// Reading `base_price` compiles, runs, looks right, and silently misreports
// the bill by whatever the discount happens to be. Do not swap them.

function countryPath(base: string, resource: string, isoCountry: string): string {
  return `${base}/v1/${resource}/Countries/${encodeURIComponent(isoCountry.trim().toUpperCase())}`;
}

export interface TwilioNumberRental {
  numberType: string;
  monthlyPrice: number;
  priceUnit: string;
}

/**
 * Monthly rental for a number type in a country, from the Pricing API.
 * numberType is one of "local" | "mobile" | "national" | "toll free".
 *
 * Matched case-insensitively and on the trimmed string, because Twilio's
 * spelling of these varies by country ("toll free" vs "Toll Free").
 */
export async function fetchNumberRental(
  isoCountry: string,
  numberType: string,
): Promise<TwilioNumberRental | null> {
  const payload = await getJson(
    countryPath(PRICING_BASE, "PhoneNumbers", isoCountry),
    `Number rental lookup for ${isoCountry}`,
  );
  if (!payload) return null;

  // No unit, no answer. Returning a bare number and letting a caller guess the
  // currency is exactly the failure this file was written to remove.
  const priceUnit = asText(payload["price_unit"]);
  if (priceUnit === null) return null;

  const wanted = numberType.trim().toLowerCase();
  for (const entry of asArray(payload["phone_number_prices"])) {
    if (!isRecord(entry)) continue;
    const type = asText(entry["number_type"]);
    if (type === null || type.toLowerCase() !== wanted) continue;

    const currentPrice = asMoney(entry["current_price"]);
    if (currentPrice === null) continue;

    return { numberType: type, monthlyPrice: currentPrice, priceUnit };
  }

  // The country is real but doesn't sell that number type — a legitimate
  // answer, not a fault, so it isn't logged as one.
  return null;
}

export interface TwilioVoiceRate {
  destinationPrefix: string;
  friendlyName: string;
  currentPrice: number;
  priceUnit: string;
}

/**
 * Outbound voice rates by destination prefix for a country.
 *
 * Twilio groups several prefixes under one price, so one of its entries becomes
 * several rows here — one per prefix. That is what makes this useful: pricing a
 * call means longest-prefix matching the dialled number against these rows,
 * which is how the landline/mobile split gets resolved per call instead of
 * being averaged into a single wrong rate.
 *
 * Empty array on any failure. A caller that gets nothing back should say the
 * rates are unavailable, never fall back to a hardcoded figure.
 */
export async function fetchVoiceRates(isoCountry: string): Promise<TwilioVoiceRate[]> {
  const payload = await getJson(
    countryPath(PRICING_BASE, "Voice", isoCountry),
    `Voice rate lookup for ${isoCountry}`,
  );
  if (!payload) return [];

  const priceUnit = asText(payload["price_unit"]);
  if (priceUnit === null) return [];

  const rates: TwilioVoiceRate[] = [];
  for (const entry of asArray(payload["outbound_prefix_prices"])) {
    if (!isRecord(entry)) continue;

    const currentPrice = asMoney(entry["current_price"]);
    if (currentPrice === null) continue;

    const friendlyName = asText(entry["friendly_name"]) ?? "Unnamed destination";
    for (const prefix of asArray(entry["destination_prefixes"])) {
      const destinationPrefix = asText(prefix);
      if (destinationPrefix === null) continue;
      rates.push({ destinationPrefix, friendlyName, currentPrice, priceUnit });
    }
  }

  return rates;
}

/**
 * Outbound messaging rate for a country.
 *
 * Twilio quotes SMS per carrier, not as one number, so this has to choose. It
 * prefers the "Other" row — Twilio's own catch-all for carriers it hasn't
 * listed — and otherwise takes the DEAREST rate on offer. Deliberately
 * pessimistic: an SMS estimate that comes in over is a shrug, one that comes in
 * under is a surprise on the invoice.
 *
 * For what a specific text really cost, use fetchMessagePrice — this is for
 * estimating before the fact.
 */
export async function fetchMessagingRate(
  isoCountry: string,
): Promise<{ currentPrice: number; priceUnit: string } | null> {
  const payload = await getJson(
    countryPath(PRICING_BASE, "Messaging", isoCountry),
    `Messaging rate lookup for ${isoCountry}`,
  );
  if (!payload) return null;

  const priceUnit = asText(payload["price_unit"]);
  if (priceUnit === null) return null;

  let catchAll: number | null = null;
  let dearest: number | null = null;

  const consider = (value: unknown, isCatchAll: boolean): void => {
    const currentPrice = asMoney(value);
    if (currentPrice === null) return;
    if (isCatchAll && (catchAll === null || currentPrice > catchAll)) catchAll = currentPrice;
    if (dearest === null || currentPrice > dearest) dearest = currentPrice;
  };

  for (const entry of asArray(payload["outbound_sms_prices"])) {
    if (!isRecord(entry)) continue;

    const carrier = asText(entry["carrier"]);
    const isCatchAll = carrier !== null && carrier.toLowerCase() === "other";

    // Normal shape: prices nested one level down, split by number type.
    for (const row of asArray(entry["prices"])) {
      if (!isRecord(row)) continue;
      consider(row["current_price"], isCatchAll);
    }
    // Some countries come back flat, with the price on the carrier entry
    // itself. Cheap to tolerate, and beats returning null for those.
    consider(entry["current_price"], isCatchAll);
  }

  const chosen: number | null = catchAll ?? dearest;
  if (chosen === null) return null;

  return { currentPrice: chosen, priceUnit };
}
