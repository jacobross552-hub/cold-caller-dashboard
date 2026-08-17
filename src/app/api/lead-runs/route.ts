/**
 * Start a lead-finding run.
 *
 * Form post from the Find Leads page, same shape as every other form in the
 * dashboard: validate, act, 303 back with the outcome in the query string.
 *
 * The response returns as soon as the run row is written. The searching
 * happens in the background — see lead-finder/orchestrator.ts.
 */

import { NextResponse } from "next/server";
import {
  LeadRunError,
  resolveVerticals,
  runLeadFinder,
  startLeadRun,
} from "@/lib/lead-finder/orchestrator";
import { parseLocations } from "@/lib/lead-finder/queries";
import { placesConfigured } from "@/lib/lead-finder/places";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();

  const back = (params: Record<string, string>) => {
    const url = new URL("/find-leads", request.url);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return NextResponse.redirect(url, { status: 303 });
  };

  if (!placesConfigured()) {
    return back({
      error:
        "No GOOGLE_PLACES_API_KEY in .env, so there's nothing to search with. Add it and restart.",
    });
  }

  const verticalIds = form.getAll("verticals").map(String);
  const customTerms = String(form.get("customVerticals") ?? "")
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

  try {
    const run = startLeadRun({
      verticals: resolveVerticals(verticalIds, customTerms),
      locations: parseLocations(String(form.get("locations") ?? "")),
      targetCount: Number(form.get("targetCount") ?? 0),
      requester: "dashboard",
      overrideCostCap: form.get("overrideCostCap") === "on",
    });

    // Kick the worker now rather than waiting up to a minute for the ticker.
    void runLeadFinder(run.id).catch(() => {});

    return back({ started: String(run.id) });
  } catch (err) {
    return back({
      error: err instanceof LeadRunError ? err.message : "Couldn't start that run.",
    });
  }
}
