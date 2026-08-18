/**
 * The permanent do-not-contact list.
 *
 * ACMA can fine a corporation up to $2.2M for serious breaches, and "we lost
 * track of who opted out" is exactly the kind of thing that turns a complaint
 * into a finding. So an opt-out here is permanent and lives independently of
 * the lead row it came from.
 *
 * Two rules that make it actually durable:
 *   1. Checked at IMPORT time, not just at call time. A suppressed number can
 *      never come back onto the list via a lead run, so it can never be dialled
 *      by a future run that forgot to check.
 *   2. Never deleted by the app. `leads` rows come and go; this table only
 *      grows.
 *
 * Everything is keyed on E.164 so "0412 345 678" and "+61412345678" are the
 * same number.
 */

import { db, logEvent } from "./db";
import { normaliseAuPhone } from "./phone";

export interface SuppressionRow {
  id: number;
  phone: string;
  reason: string;
  source: string | null;
  added_by: string | null;
  added_at: number;
}

/**
 * Add a number to the list. Idempotent — re-adding keeps the original reason
 * and date, because the first opt-out is the one that matters.
 */
export function suppress(
  phone: string,
  reason: string,
  options: { source?: string; addedBy?: string } = {},
): { ok: boolean; detail: string } {
  const normalised = normaliseAuPhone(phone);
  if (!normalised.ok || !normalised.e164) {
    return { ok: false, detail: normalised.reason ?? "not a valid Australian number" };
  }

  const result = db()
    .prepare(
      "INSERT OR IGNORE INTO do_not_contact (phone, reason, source, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(normalised.e164, reason, options.source ?? null, options.addedBy ?? null, Date.now());

  const added = Number(result.changes) > 0;

  // Keep the lead row in step with the list.
  //
  // Without this the two halves of the system disagree: the number is on the
  // do-not-contact list, but its lead row is still status='new', and the
  // dispatcher selects on lead status. A number suppressed AFTER it was
  // imported would still have been dialled. Belt to the dispatcher's braces.
  const touched = db()
    .prepare(
      "UPDATE leads SET status = 'do_not_call' WHERE phone = ? AND status != 'do_not_call'",
    )
    .run(normalised.e164);

  const leadsUpdated = Number(touched.changes);

  if (added) {
    logEvent(
      "suppression.added",
      `${normalised.e164} added to the do-not-contact list: ${reason}` +
        (leadsUpdated ? ` (${leadsUpdated} lead row marked do-not-call)` : ""),
      { source: options.source },
    );
  }

  return {
    ok: true,
    detail: added ? "Added to the do-not-contact list." : "Already on the do-not-contact list.",
  };
}

/** True if this number must never be contacted. Accepts any AU format. */
export function isSuppressed(phone: string): boolean {
  const normalised = normaliseAuPhone(phone);
  if (!normalised.ok || !normalised.e164) return false;
  return Boolean(
    db().prepare("SELECT 1 FROM do_not_contact WHERE phone = ?").get(normalised.e164),
  );
}

/**
 * Bulk check, for import runs that would otherwise do one query per candidate.
 * Returns the set of E.164 numbers from `phones` that are suppressed.
 */
export function suppressedAmong(phones: string[]): Set<string> {
  const found = new Set<string>();
  if (phones.length === 0) return found;

  const statement = db().prepare("SELECT phone FROM do_not_contact WHERE phone = ?");
  for (const phone of phones) {
    const normalised = normaliseAuPhone(phone);
    if (!normalised.ok || !normalised.e164) continue;
    if (statement.get(normalised.e164)) found.add(normalised.e164);
  }
  return found;
}

/**
 * Take a number back off the list.
 *
 * Deliberately its own function with its own button, never a side effect of
 * anything else. Removing an opt-out is a decision someone has to make on
 * purpose — the usual reason is a number added by mistake, not a change of
 * heart by the person who asked to be left alone.
 */
export function unsuppress(phone: string, removedBy = "operator"): { ok: boolean; detail: string } {
  const normalised = normaliseAuPhone(phone);
  if (!normalised.ok || !normalised.e164) {
    return { ok: false, detail: normalised.reason ?? "not a valid Australian number" };
  }

  const result = db()
    .prepare("DELETE FROM do_not_contact WHERE phone = ?")
    .run(normalised.e164);

  if (Number(result.changes) === 0) {
    return { ok: false, detail: "That number wasn't on the list." };
  }

  logEvent(
    "suppression.removed",
    `${normalised.e164} was taken OFF the do-not-contact list by ${removedBy}. It can be called again.`,
  );
  return { ok: true, detail: "Removed from the do-not-contact list." };
}

export function listSuppressed(limit = 500): SuppressionRow[] {
  return db()
    .prepare("SELECT * FROM do_not_contact ORDER BY added_at DESC LIMIT ?")
    .all(limit) as unknown as SuppressionRow[];
}

export function suppressionCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM do_not_contact").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
