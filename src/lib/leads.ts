/**
 * Lead import.
 *
 * Three ways in, all landing in the same validation path:
 *   1. Paste a block of text (one lead per line)
 *   2. Upload a CSV exported from a spreadsheet
 *   3. POST JSON to /api/leads — ready for the lead-finder Bob is building
 *
 * Numbers are normalised to E.164 on the way in, which also gives duplicate
 * detection for free (the phone column is UNIQUE).
 */

import { db, logEvent } from "./db";
import { normaliseAuPhone } from "./phone";
import { isSuppressed, suppress } from "./suppression";

export interface IncomingLead {
  businessName: string;
  phone: string;
  contactName?: string;
  suburb?: string;
  state?: string;
  trade?: string;
  notes?: string;

  // --- Set by the lead finder; absent for pasted and uploaded leads. -------
  /** Google's stable id for the business. Survives renames and number changes. */
  sourcePlaceId?: string;
  icpScore?: number;
  icpReasons?: string[];
  vertical?: string;
  leadRunId?: number;
  abn?: string;
  abnStatus?: string;
  website?: string;
  googleRating?: number;
  googleReviewCount?: number;
  openingHoursJson?: string;
  /** Where the number came from and why it's lawful to ring it. */
  sourceRecord?: unknown;
}

export interface ImportResult {
  imported: number;
  duplicates: number;
  /** Numbers refused because they're on the do-not-contact list. */
  suppressed: number;
  rejected: Array<{ line: string; reason: string }>;
}

/** Minimal RFC4180-ish CSV parser: handles quoted fields and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * The fields a human can put in a spreadsheet. The lead-finder-only fields on
 * IncomingLead (place id, ICP score, source record…) are deliberately not
 * here — they're machine-generated provenance, not something to type in.
 */
type CsvField = "businessName" | "phone" | "contactName" | "suburb" | "state" | "trade" | "notes";

const HEADER_ALIASES: Record<CsvField, string[]> = {
  businessName: ["business", "business name", "name", "company", "company name", "trading name"],
  phone: ["phone", "phone number", "mobile", "number", "telephone", "contact number"],
  contactName: ["contact", "contact name", "owner", "first name", "person"],
  suburb: ["suburb", "city", "town", "locality"],
  state: ["state", "region"],
  trade: ["trade", "category", "industry", "type", "business type"],
  notes: ["notes", "note", "comment", "comments"],
};

function matchHeader(header: string): CsvField | null {
  const clean = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(clean)) return field as CsvField;
  }
  return null;
}

/** Turn CSV text into leads, using the header row if there is one. */
export function leadsFromCsv(text: string): { leads: IncomingLead[]; rejected: ImportResult["rejected"] } {
  const rows = parseCsv(text);
  const rejected: ImportResult["rejected"] = [];
  if (rows.length === 0) return { leads: [], rejected };

  const headerRow = rows[0].map(matchHeader);
  const hasHeader = headerRow.filter(Boolean).length >= 2;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const leads: IncomingLead[] = [];

  for (const row of dataRows) {
    let lead: IncomingLead;

    if (hasHeader) {
      const record: Partial<IncomingLead> = {};
      headerRow.forEach((field, index) => {
        if (field && row[index]) record[field] = row[index].trim();
      });
      lead = {
        businessName: record.businessName ?? "",
        phone: record.phone ?? "",
        contactName: record.contactName,
        suburb: record.suburb,
        state: record.state,
        trade: record.trade,
        notes: record.notes,
      };
    } else {
      // No header — assume the first column is the name, second the number.
      lead = { businessName: (row[0] ?? "").trim(), phone: (row[1] ?? "").trim() };
    }

    if (!lead.businessName && !lead.phone) continue;
    if (!lead.phone) {
      rejected.push({ line: row.join(", "), reason: "no phone number found" });
      continue;
    }
    leads.push(lead);
  }

  return { leads, rejected };
}

/**
 * Parse pasted text. One lead per line, name and number separated by a comma,
 * tab, or a run of two or more spaces. A line that is only a phone number is
 * accepted too — the business name falls back to the number.
 */
export function leadsFromPaste(text: string): { leads: IncomingLead[]; rejected: ImportResult["rejected"] } {
  const leads: IncomingLead[] = [];
  const rejected: ImportResult["rejected"] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);

    if (parts.length === 1) {
      const only = parts[0];
      if (normaliseAuPhone(only).ok) {
        leads.push({ businessName: only, phone: only });
      } else {
        rejected.push({ line, reason: "no phone number on this line" });
      }
      continue;
    }

    // Find the part that actually looks like a phone number; the rest is the name.
    const phoneIndex = parts.findIndex((p) => normaliseAuPhone(p).ok);
    if (phoneIndex === -1) {
      rejected.push({ line, reason: "no valid Australian phone number on this line" });
      continue;
    }

    const phone = parts[phoneIndex];
    const name = parts.filter((_, i) => i !== phoneIndex).join(" ").trim();
    leads.push({ businessName: name || phone, phone });
  }

  return { leads, rejected };
}

/**
 * Validate and insert. Duplicates are counted, not treated as errors.
 *
 * EVERY route into the leads table comes through here — paste, CSV, the JSON
 * API and the lead finder — which is what makes the do-not-contact check
 * below a real guarantee rather than something each caller has to remember.
 * A number that once asked to be removed cannot get back on the list.
 */
export function importLeads(incoming: IncomingLead[], source: string): ImportResult {
  const database = db();
  const result: ImportResult = { imported: 0, duplicates: 0, suppressed: 0, rejected: [] };

  const insert = database.prepare(`
    INSERT INTO leads (
      business_name, phone, phone_raw, contact_name, suburb, state, trade, notes, source,
      source_place_id, icp_score, icp_reasons, vertical, lead_run_id, abn, abn_status,
      website, google_rating, google_review_count, opening_hours_json, source_record,
      status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `);
  const existingPhone = database.prepare("SELECT id FROM leads WHERE phone = ?");
  const existingPlace = database.prepare("SELECT id FROM leads WHERE source_place_id = ?");

  for (const lead of incoming) {
    const label = `${lead.businessName || "(no name)"} — ${lead.phone}`;
    const normalised = normaliseAuPhone(lead.phone);

    if (!normalised.ok || !normalised.e164) {
      result.rejected.push({ line: label, reason: normalised.reason ?? "invalid number" });
      continue;
    }

    // The hard guardrail. Checked here, at import, so a suppressed number can
    // never sit in the leads table waiting to be dialled.
    if (isSuppressed(normalised.e164)) {
      result.suppressed++;
      continue;
    }

    if (existingPhone.get(normalised.e164)) {
      result.duplicates++;
      continue;
    }

    // Same business, new phone number: the place_id catches what the phone
    // check can't.
    if (lead.sourcePlaceId && existingPlace.get(lead.sourcePlaceId)) {
      result.duplicates++;
      continue;
    }

    insert.run(
      lead.businessName?.trim() || normalised.e164,
      normalised.e164,
      lead.phone,
      lead.contactName?.trim() || null,
      lead.suburb?.trim() || null,
      lead.state?.trim() || null,
      // `trade` is the column the rest of the dashboard already reads, so the
      // vertical is written to both rather than splitting the meaning.
      lead.trade?.trim() || lead.vertical?.trim() || null,
      lead.notes?.trim() || null,
      source,
      lead.sourcePlaceId ?? null,
      lead.icpScore ?? null,
      lead.icpReasons ? JSON.stringify(lead.icpReasons) : null,
      lead.vertical ?? null,
      lead.leadRunId ?? null,
      lead.abn ?? null,
      lead.abnStatus ?? null,
      lead.website ?? null,
      lead.googleRating ?? null,
      lead.googleReviewCount ?? null,
      lead.openingHoursJson ?? null,
      lead.sourceRecord ? JSON.stringify(lead.sourceRecord) : null,
      Date.now(),
    );
    result.imported++;
  }

  logEvent(
    "leads.import",
    `Imported ${result.imported} lead${result.imported === 1 ? "" : "s"} from ${source}` +
      (result.duplicates ? `, skipped ${result.duplicates} already on the list` : "") +
      (result.suppressed ? `, blocked ${result.suppressed} on the do-not-contact list` : "") +
      (result.rejected.length ? `, rejected ${result.rejected.length}` : ""),
    { source, ...result },
  );

  return result;
}

export interface LeadRow {
  id: number;
  business_name: string;
  phone: string;
  contact_name: string | null;
  suburb: string | null;
  state: string | null;
  trade: string | null;
  notes: string | null;
  source: string | null;
  status: string;
  call_count: number;
  last_called_at: number | null;
  created_at: number;
  source_place_id: string | null;
  icp_score: number | null;
  icp_reasons: string | null;
  vertical: string | null;
  lead_run_id: number | null;
  abn: string | null;
  abn_status: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  opening_hours_json: string | null;
  source_record: string | null;
}

/**
 * Cheap "have we already got this one?" check.
 *
 * The lead finder calls this before spending time on an ABN lookup, so a
 * business already on the list costs nothing extra to skip. `importLeads`
 * re-checks anyway — this is an optimisation, not the guarantee.
 */
export function leadExists(phoneE164: string, placeId?: string): boolean {
  const database = db();
  if (database.prepare("SELECT 1 FROM leads WHERE phone = ?").get(phoneE164)) return true;
  if (placeId && database.prepare("SELECT 1 FROM leads WHERE source_place_id = ?").get(placeId)) {
    return true;
  }
  return false;
}

/**
 * One lead, with everything the finder learned about it.
 *
 * Used by the call log and the pre-call briefing so the two halves of the
 * system share a view of the business: the finder's listing data sits
 * alongside what was actually said on the call.
 */
export function getLead(id: number | null | undefined): LeadRow | null {
  if (id === null || id === undefined) return null;
  return (db().prepare("SELECT * FROM leads WHERE id = ?").get(id) ?? null) as LeadRow | null;
}

export function listLeads(limit = 500): LeadRow[] {
  return db()
    .prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as LeadRow[];
}

export function leadCounts() {
  const rows = db()
    .prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status")
    .all() as unknown as Array<{ status: string; n: number }>;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    total += row.n;
  }
  return { counts, total, callable: counts.new ?? 0 };
}

/**
 * Mark a lead do-not-call. Used for "take me off your list" requests.
 *
 * Marking do-not-call also writes the number to the permanent suppression
 * list, so the opt-out outlives this lead row and no future lead run can
 * source the same number back onto the list.
 *
 * Restoring a lead to 'new' deliberately does NOT remove it from that list —
 * un-suppressing is a decision that should be made explicitly, not as a
 * side-effect of clicking "restore".
 */
export function setLeadStatus(id: number, status: string) {
  const database = db();

  if (status === "do_not_call") {
    const lead = database.prepare("SELECT phone, business_name FROM leads WHERE id = ?").get(id) as
      | { phone: string; business_name: string }
      | undefined;

    if (lead) {
      suppress(lead.phone, `${lead.business_name} asked not to be called again.`, {
        source: "dashboard",
        addedBy: "operator",
      });
    }
  }

  database.prepare("UPDATE leads SET status = ? WHERE id = ?").run(status, id);
}
