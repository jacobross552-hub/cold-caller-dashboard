/**
 * Lead import.
 *
 * Accepts three shapes so the same endpoint serves the paste box, the CSV
 * upload, and — later — whatever Bob's lead-finder produces:
 *
 *   multipart/form-data  file=<csv>            (CSV upload)
 *   multipart/form-data  paste=<text>          (paste box)
 *   application/json     { leads: [ {...} ] }  (for the lead-finder)
 */

import { NextResponse } from "next/server";
import { importLeads, leadsFromCsv, leadsFromPaste, type IncomingLead } from "@/lib/leads";
import { appUrl } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { leads?: IncomingLead[]; source?: string };
      if (!Array.isArray(body.leads)) {
        return NextResponse.json(
          { error: 'Expected {"leads": [{"businessName": "...", "phone": "..."}]}' },
          { status: 400 },
        );
      }
      const result = importLeads(body.leads, body.source ?? "api");
      return NextResponse.json(result);
    }

    const form = await request.formData();
    const file = form.get("file");
    const paste = form.get("paste");

    if (file && typeof file !== "string" && file.size > 0) {
      const text = await file.text();
      const { leads, rejected } = leadsFromCsv(text);
      const result = importLeads(leads, `csv:${file.name}`);
      result.rejected.push(...rejected);
      return redirectBack(request, result);
    }

    if (typeof paste === "string" && paste.trim()) {
      const { leads, rejected } = leadsFromPaste(paste);
      const result = importLeads(leads, "paste");
      result.rejected.push(...rejected);
      return redirectBack(request, result);
    }

    return redirectBack(request, {
      imported: 0,
      duplicates: 0,
      suppressed: 0,
      rejected: [{ line: "-", reason: "Nothing was pasted or uploaded." }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function redirectBack(
  request: Request,
  result: {
    imported: number;
    duplicates: number;
    suppressed: number;
    rejected: Array<{ line: string; reason: string }>;
  },
) {
  const url = appUrl(request, "/leads");
  url.searchParams.set("imported", String(result.imported));
  url.searchParams.set("duplicates", String(result.duplicates));
  if (result.suppressed) url.searchParams.set("suppressed", String(result.suppressed));
  if (result.rejected.length) {
    url.searchParams.set("rejected", String(result.rejected.length));
    url.searchParams.set("firstError", result.rejected[0].reason);
  }
  return NextResponse.redirect(url, { status: 303 });
}
