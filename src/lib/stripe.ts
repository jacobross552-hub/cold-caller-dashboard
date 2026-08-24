/**
 * Stripe, READ-ONLY.
 *
 * Bob creates every invoice and subscription in Stripe himself — this file
 * never writes anything there. Its only job is pulling back what was actually
 * PAID, so it can be checked against what the deals table says was agreed.
 *
 * THE MATCHING IS A HEURISTIC, NOT A GUARANTEED LINK. Stripe charges created
 * by hand carry no id back to a `deals` row, so a Won deal is matched to a
 * Stripe payment by amount, within a time window after it was recorded. That
 * is honest enough to catch the two things worth catching — an agreed price
 * that never actually landed, and a payment that doesn't match anything
 * agreed — but it is not proof of identity. Reconcile results say so.
 *
 * Style follows twilio.ts: plain fetch with HTTP Basic (the secret key as the
 * username, blank password — Stripe's own convention), no SDK, nothing
 * throws. A reconciliation panel is decoration on a page; it must never be
 * able to break one.
 */

import { config, optional } from "./env";
import { logEvent } from "./db";

const API_BASE = "https://api.stripe.com/v1";
const TIMEOUT_MS = 8_000;

export function stripeConfigured(): boolean {
  return Boolean(optional("STRIPE_SECRET_KEY"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One GET, JSON back, never a throw. Returns null on any failure — missing
 * key, network, timeout, non-2xx — and logs it, same contract as twilio.ts's
 * getJson.
 */
async function getJson(path: string, what: string): Promise<Record<string, unknown> | null> {
  const key = optional("STRIPE_SECRET_KEY");
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        // Stripe's Basic Auth convention: secret key as the username, no password.
        Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64"),
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      logEvent("stripe.lookup_failed", `${what} failed (${response.status})`, text.slice(0, 500));
      return null;
    }

    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) {
      logEvent("stripe.lookup_failed", `${what} returned a body that wasn't an object`);
      return null;
    }
    return payload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("stripe.lookup_failed", `${what} failed`, detail);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface StripePayment {
  id: string;
  /** Real currency units (dollars), not Stripe's smallest-unit cents. */
  amount: number;
  /** ISO currency, upper-cased, as Stripe reports it (e.g. "aud" -> "AUD"). */
  currency: string;
  createdAt: number;
  description: string | null;
}

/**
 * Every successful charge Stripe has on file, most recent first.
 *
 * A single page (up to `limit`, Stripe's own cap is 100) — this is a solo
 * pre-revenue operation, not a payments platform; if that ever stops being
 * true, this is the line to add pagination to. Zero-decimal currencies (JPY
 * and similar) don't divide by 100, but AUD and USD — the only two this
 * business will ever see — both do, so that's the only conversion applied.
 */
export async function fetchRecentPayments(limit = 100): Promise<StripePayment[]> {
  const payload = await getJson(`/charges?limit=${limit}`, "Stripe charge list");
  if (!payload) return [];

  const rows: unknown[] = Array.isArray(payload["data"]) ? (payload["data"] as unknown[]) : [];
  const payments: StripePayment[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row["paid"] !== true || row["status"] !== "succeeded") continue;
    if (row["refunded"] === true) continue;

    const amountCents = row["amount"];
    const currency = row["currency"];
    const created = row["created"];
    if (typeof amountCents !== "number" || typeof currency !== "string" || typeof created !== "number") {
      continue;
    }

    payments.push({
      id: String(row["id"] ?? ""),
      amount: amountCents / 100,
      currency: currency.toUpperCase(),
      createdAt: created * 1000,
      description: typeof row["description"] === "string" ? row["description"] : null,
    });
  }

  return payments;
}

export interface ReconciledDeal {
  callId: number;
  /** Setup fee + retainer, as recorded on the deal. */
  expectedAud: number;
  /** The Stripe payment matched by amount within the window, if any. */
  matched: StripePayment | null;
}

export interface ReconcileResult {
  configured: boolean;
  /** Every Won deal, paired with a matched Stripe payment or null. */
  deals: ReconciledDeal[];
  /**
   * Stripe payments in the lookback window that matched no deal's expected
   * amount — worth a look, not necessarily wrong (a retainer renewal has the
   * same amount as the deal that's already claimed a match, for instance).
   */
  unmatchedPayments: StripePayment[];
}

/**
 * How far a payment's timestamp can sit from the moment a deal was recorded
 * Won and still count as a match. Asymmetric on purpose: a customer often
 * pays an invoice before Bob gets around to logging the deal in the
 * dashboard (same-day, sometimes the next), so a short window BEFORE
 * recording is allowed; AFTER recording covers slower payment terms.
 */
const MATCH_WINDOW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const MATCH_WINDOW_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
/** Amounts are compared to the cent; Stripe and the deal record are both exact dollars. */
const AMOUNT_TOLERANCE = 0.01;

/**
 * Deals are recorded in AUD (Bob's own currency) — a Stripe payment must be
 * converted to the same currency before its amount can be compared, or a
 * $500 USD charge silently "matches" a $500 AUD deal at the wrong value.
 * Same rule as costs.ts's toAud: only AUD and USD are convertible; anything
 * else is left unmatched rather than guessed at.
 */
function toAudEquivalent(payment: StripePayment): number | null {
  if (payment.currency === "AUD") return payment.amount;
  if (payment.currency === "USD") return payment.amount * config.usdAudRate;
  return null;
}

/**
 * Match every Won deal's expected price against Stripe's actual charges.
 *
 * Read-only both ways: this never writes to Stripe, and it never writes back
 * onto the deals table either — a mismatch is surfaced for Bob to look at,
 * not silently corrected.
 */
export async function reconcileWonDeals(
  wonDeals: Array<{
    call_id: number;
    agreed_setup_fee: number | null;
    agreed_monthly_retainer: number | null;
    recorded_at: number;
  }>,
): Promise<ReconcileResult> {
  if (!stripeConfigured()) {
    return { configured: false, deals: [], unmatchedPayments: [] };
  }

  const payments = await fetchRecentPayments();
  const claimed = new Set<string>();

  const deals: ReconciledDeal[] = wonDeals.map((deal) => {
    const expected = (deal.agreed_setup_fee ?? 0) + (deal.agreed_monthly_retainer ?? 0);
    const match = payments.find((p) => {
      if (claimed.has(p.id)) return false;
      const audEquivalent = toAudEquivalent(p);
      if (audEquivalent === null) return false;
      if (Math.abs(audEquivalent - expected) > AMOUNT_TOLERANCE) return false;
      return (
        p.createdAt >= deal.recorded_at - MATCH_WINDOW_BEFORE_MS &&
        p.createdAt <= deal.recorded_at + MATCH_WINDOW_AFTER_MS
      );
    });
    if (match) claimed.add(match.id);

    return { callId: deal.call_id, expectedAud: expected, matched: match ?? null };
  });

  const unmatchedPayments = payments.filter((p) => !claimed.has(p.id));

  return { configured: true, deals, unmatchedPayments };
}
