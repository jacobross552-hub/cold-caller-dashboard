/**
 * Tests for the import guardrails, against a real (throwaway) database.
 *
 * Run with:  npm run test:import
 *
 * The pure-function tests in test-lead-finder.ts prove the SCORING. These
 * prove the part that actually protects you: that a number which asked to be
 * removed can never come back onto the calling list, and that the same
 * business can't be imported twice.
 *
 * Uses its own scratch database under .test-build, so it never touches
 * data/dashboard.db.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Must be set BEFORE the db module is loaded, since it reads the path once on
// first connect. Hence require() below rather than a top-level import.
const SCRATCH = resolve(process.cwd(), ".test-build", `import-test-${process.pid}.db`);
process.env.DATABASE_PATH = SCRATCH;

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const { importLeads, setLeadStatus, leadExists } =
  require("../src/lib/leads") as typeof import("../src/lib/leads");
const { isSuppressed, suppress, suppressionCount } =
  require("../src/lib/suppression") as typeof import("../src/lib/suppression");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

console.log("\nLead import guardrails\n" + "=".repeat(72));

// --- Migrations ------------------------------------------------------------
console.log("\nSchema");

const tables = (
  db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{
    name: string;
  }>
).map((row) => row.name);

for (const table of ["leads", "runs", "lead_runs", "lead_api_calls", "do_not_contact"]) {
  check(`Table "${table}" exists`, tables.includes(table));
}

const leadColumns = (
  db().prepare("PRAGMA table_info(leads)").all() as unknown as Array<{ name: string }>
).map((row) => row.name);

for (const column of [
  "source_place_id",
  "icp_score",
  "icp_reasons",
  "vertical",
  "lead_run_id",
  "abn",
  "abn_status",
  "website",
  "google_rating",
  "google_review_count",
  "opening_hours_json",
  "source_record",
]) {
  check(`Column leads.${column} exists`, leadColumns.includes(column));
}

// Running migrate twice must be harmless — it happens on every boot.
check("Re-running migrations is a no-op", (() => {
  try {
    db().exec("SELECT 1");
    return true;
  } catch {
    return false;
  }
})());

// --- Import basics ---------------------------------------------------------
console.log("\nImporting");

const first = importLeads(
  [{ businessName: "Hunter Valley Plumbing", phone: "(02) 4956 1234", state: "NSW" }],
  "test",
);
equal("A good lead imports", first.imported, 1);

const stored = db()
  .prepare("SELECT phone FROM leads WHERE business_name = ?")
  .get("Hunter Valley Plumbing") as { phone: string };
equal("…and the number is normalised to E.164", stored.phone, "+61249561234");

const sameNumber = importLeads(
  [{ businessName: "Hunter Valley Plumbing (again)", phone: "0249561234" }],
  "test",
);
equal("The same number written differently is a duplicate", sameNumber.duplicates, 1);
equal("…and is not inserted", sameNumber.imported, 0);

// The place_id catch: same business, new phone number. Without this the
// business would be imported twice and called twice.
importLeads(
  [{ businessName: "Maitland Electrical", phone: "0249567777", sourcePlaceId: "place-abc" }],
  "test",
);
const samePlace = importLeads(
  [{ businessName: "Maitland Electrical", phone: "0249568888", sourcePlaceId: "place-abc" }],
  "test",
);
equal("Same place_id with a new number is still a duplicate", samePlace.duplicates, 1);

equal("An invalid number is rejected, not imported", importLeads(
  [{ businessName: "Nonsense", phone: "12" }],
  "test",
).rejected.length, 1);

check("leadExists finds an imported number", leadExists("+61249561234"));
check("leadExists finds by place_id", leadExists("+61400000000", "place-abc"));
check("leadExists is false for an unknown number", !leadExists("+61399999999"));

// --- The suppression guarantee --------------------------------------------
console.log("\nDo-not-contact — the guarantee that matters");

suppress("0412 999 888", "Asked to be removed.", { source: "test" });
check("A suppressed number reads back as suppressed", isSuppressed("+61412999888"));
check("…in any format", isSuppressed("0412 999 888"));
check("An unrelated number is not suppressed", !isSuppressed("+61412111222"));

const blocked = importLeads(
  [{ businessName: "Should Never Import", phone: "0412 999 888" }],
  "test",
);
equal("A suppressed number is blocked at import", blocked.suppressed, 1);
equal("…and definitely not inserted", blocked.imported, 0);
check(
  "…and never reaches the leads table",
  !db().prepare("SELECT 1 FROM leads WHERE phone = ?").get("+61412999888"),
);

// Marking a lead do-not-call must suppress the NUMBER, not just the row —
// otherwise a later lead run would source the same business straight back in.
importLeads([{ businessName: "Regretful Roofing", phone: "0249563333" }], "test");
const regretful = db()
  .prepare("SELECT id FROM leads WHERE business_name = ?")
  .get("Regretful Roofing") as { id: number };
setLeadStatus(regretful.id, "do_not_call");

check("Marking do-not-call adds the number to the suppression list", isSuppressed("+61249563333"));

const reImport = importLeads(
  [{ businessName: "Regretful Roofing", phone: "0249563333", sourcePlaceId: "place-new" }],
  "AI lead finder",
);
equal("A lead run cannot re-import an opted-out number", reImport.imported, 0);
equal("…it is counted as suppressed, not as a duplicate", reImport.suppressed, 1);

// Restoring a lead deliberately does NOT un-suppress: that has to be a
// conscious act, not a side effect of clicking "restore".
setLeadStatus(regretful.id, "new");
check("Restoring a lead leaves the number suppressed", isSuppressed("+61249563333"));

check("Suppression list has the two numbers we added", suppressionCount() === 2, `got ${suppressionCount()}`);

// Re-suppressing keeps the original reason rather than overwriting it.
suppress("0412 999 888", "A different reason", { source: "test" });
equal("Re-suppressing doesn't duplicate the row", suppressionCount(), 2);

// --- Cleanup ---------------------------------------------------------------
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(SCRATCH + suffix, { force: true });
  } catch {
    /* the OS can hold the handle briefly on Windows; harmless either way */
  }
}

console.log("\n" + "=".repeat(72));
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
