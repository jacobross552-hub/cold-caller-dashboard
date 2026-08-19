/**
 * SQLite storage, using Node's built-in `node:sqlite` module.
 *
 * Deliberately no ORM and no native modules to compile — one file, one
 * database, nothing to install. The schema is created on first run.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./env";
import { extractCallCost } from "./call-cost";

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (instance) return instance;

  const path = resolve(process.cwd(), config.databasePath);
  mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);

  instance = database;
  return database;
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name  TEXT    NOT NULL,
      phone          TEXT    NOT NULL UNIQUE,
      phone_raw      TEXT,
      contact_name   TEXT,
      suburb         TEXT,
      state          TEXT,
      trade          TEXT,
      notes          TEXT,
      source         TEXT,
      status         TEXT    NOT NULL DEFAULT 'new',
      call_count     INTEGER NOT NULL DEFAULT 0,
      last_called_at INTEGER,
      created_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      requested_count INTEGER NOT NULL,
      status          TEXT    NOT NULL,
      hold_reason     TEXT,
      next_window_at  INTEGER,
      error           TEXT,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      finished_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS run_leads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      status          TEXT    NOT NULL DEFAULT 'pending',
      batch_id        TEXT,
      conversation_id TEXT,
      dispatched_at   INTEGER,
      UNIQUE(run_id, lead_id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_leads_run ON run_leads(run_id, status);

    CREATE TABLE IF NOT EXISTS batches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      elevenlabs_batch_id TEXT    NOT NULL UNIQUE,
      call_count          INTEGER NOT NULL,
      status              TEXT    NOT NULL,
      created_at          INTEGER NOT NULL,
      last_polled_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS calls (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id    TEXT    NOT NULL UNIQUE,
      lead_id            INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      run_id             INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      business_name      TEXT,
      phone              TEXT,
      started_at         INTEGER,
      duration_secs      INTEGER,
      outcome            TEXT,
      termination_reason TEXT,
      cost               REAL,
      booked             INTEGER NOT NULL DEFAULT 0,
      transcript_json    TEXT,
      raw_json           TEXT,
      summary            TEXT,
      analysis_json      TEXT,
      analysis_error     TEXT,
      analysed_at        INTEGER,
      alert_sent_at      INTEGER,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_booked  ON calls(booked);

    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      kind    TEXT    NOT NULL,
      message TEXT    NOT NULL,
      detail  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

    /* ---------------------------------------------------------------------
     * Lead finder.
     *
     * NOTE ON NAMING: the "runs" table above is a CALLING run (dial these
     * leads). "lead_runs" here is a SOURCING run (go and find leads). They are
     * different things with different lifecycles — never join them.
     * ------------------------------------------------------------------ */

    CREATE TABLE IF NOT EXISTS lead_runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      requester          TEXT,
      verticals_json     TEXT    NOT NULL,
      locations_json     TEXT    NOT NULL,
      target_count       INTEGER NOT NULL,
      status             TEXT    NOT NULL,
      stage              TEXT,
      queries_json       TEXT,
      query_cursor       INTEGER NOT NULL DEFAULT 0,
      candidates_seen    INTEGER NOT NULL DEFAULT 0,
      leads_found        INTEGER NOT NULL DEFAULT 0,
      duplicates_skipped INTEGER NOT NULL DEFAULT 0,
      suppressed_skipped INTEGER NOT NULL DEFAULT 0,
      rejected_skipped   INTEGER NOT NULL DEFAULT 0,
      estimated_cost_aud REAL,
      fx_rate            REAL    NOT NULL,
      error              TEXT,
      created_at         INTEGER NOT NULL,
      started_at         INTEGER,
      finished_at        INTEGER,
      heartbeat_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_lead_runs_status ON lead_runs(status);

    /*
     * One row per external API call. The run's cost is SUMMED FROM THESE ROWS,
     * never estimated after the fact — so the figure on screen is what was
     * actually spent, and it stays auditable months later.
     */
    CREATE TABLE IF NOT EXISTS lead_api_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_run_id   INTEGER NOT NULL REFERENCES lead_runs(id) ON DELETE CASCADE,
      provider      TEXT    NOT NULL,
      sku           TEXT    NOT NULL,
      detail        TEXT,
      http_status   INTEGER,
      result_count  INTEGER,
      unit_cost_usd REAL    NOT NULL,
      called_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lead_api_calls_run ON lead_api_calls(lead_run_id);

    /*
     * Permanent suppression list. Checked at IMPORT time, not just call time,
     * so a number that once asked to be removed can never be re-sourced back
     * onto the list by a later lead run.
     *
     * Deliberately separate from leads.status = 'do_not_call': that only
     * survives as long as the lead row does, and can't hold a number that was
     * never a lead in the first place.
     */
    /*
     * COST LEDGERS.
     *
     * Two tables the dashboard writes itself, so lifetime spend can be summed
     * from recorded events rather than estimated after the fact — the same
     * principle as lead_api_calls above.
     *
     * ElevenLabs needs no table: its post-call webhook reports the real fiat
     * cost of each call, so those figures live on calls (see the additive
     * columns below).
     */

    /*
     * One row per call to Anthropic made by THE DASHBOARD (call summaries and
     * pre-call briefings). Nothing to do with the LLM inside the voice agent —
     * ElevenLabs bills that separately and reports it as llm_price.
     *
     * Tokens are what the provider reports; cost_usd is priced from them at
     * the rates in src/lib/costs.ts and frozen here, so a past run keeps its
     * real cost after Anthropic changes prices.
     */
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id             INTEGER REFERENCES calls(id) ON DELETE SET NULL,
      purpose             TEXT    NOT NULL,
      model               TEXT    NOT NULL,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd            REAL    NOT NULL,
      created_at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

    /*
     * One row per SMS the dashboard sends. Twilio does not return a settled
     * price at send time, so cost_usd is the configured rate, not a billed
     * figure — the costs page labels it as such. The message SID is kept so
     * the real prices can be reconciled from Twilio later if it ever matters.
     */
    CREATE TABLE IF NOT EXISTS sms_sends (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL,
      purpose     TEXT    NOT NULL,
      provider_sid TEXT,
      segments    INTEGER NOT NULL DEFAULT 1,
      cost_usd    REAL    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sms_sends_created ON sms_sends(created_at);

    CREATE TABLE IF NOT EXISTS do_not_contact (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      phone    TEXT    NOT NULL UNIQUE,
      reason   TEXT    NOT NULL,
      source   TEXT,
      added_by TEXT,
      added_at INTEGER NOT NULL
    );
  `);

  // --- Additive columns on `leads` ----------------------------------------
  // CREATE TABLE IF NOT EXISTS above will not alter a table that already
  // exists, so new columns have to be added explicitly for databases created
  // before the lead finder landed.
  addColumn(database, "leads", "source_place_id", "TEXT");
  addColumn(database, "leads", "icp_score", "INTEGER");
  addColumn(database, "leads", "icp_reasons", "TEXT");
  addColumn(database, "leads", "vertical", "TEXT");
  addColumn(database, "leads", "lead_run_id", "INTEGER");
  addColumn(database, "leads", "abn", "TEXT");
  addColumn(database, "leads", "abn_status", "TEXT");
  addColumn(database, "leads", "website", "TEXT");
  addColumn(database, "leads", "google_rating", "REAL");
  addColumn(database, "leads", "google_review_count", "INTEGER");
  addColumn(database, "leads", "opening_hours_json", "TEXT");
  addColumn(database, "leads", "source_record", "TEXT");

  // --- Additive columns on `calls` -----------------------------------------
  // The REAL money ElevenLabs charged for each call, split the way its own
  // webhook splits it. The pre-existing `cost` column holds CREDITS, not
  // dollars (a 157-second call came back as 2092), so it can never be summed
  // into a spend figure — these three can. Backfillable from `raw_json` for
  // calls recorded before this landed: `npm run backfill:costs`.
  addColumn(database, "calls", "cost_fiat_usd", "REAL");
  addColumn(database, "calls", "platform_price_usd", "REAL");
  addColumn(database, "calls", "llm_price_usd", "REAL");

  // Google's place_id is the stable dedup key — the same business survives a
  // rename or a number change. Partial index so the many rows with no
  // place_id (pasted/CSV leads) don't collide with each other on NULL.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_place_id
      ON leads(source_place_id) WHERE source_place_id IS NOT NULL;
  `);

  backfillDoNotContact(database);
  backfillCallCosts(database);
}

/** Add a column only if it isn't there yet. SQLite has no ADD COLUMN IF NOT EXISTS. */
function addColumn(database: DatabaseSync, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (columns.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Pull the real per-call cost out of payloads recorded before the cost columns
 * existed.
 *
 * Nothing is fetched and nothing is estimated — the figures were always in the
 * webhook body, stored verbatim in raw_json. The dashboard was reading
 * metadata.cost (ElevenLabs CREDITS: 2092 for a 157-second call) and ignoring
 * metadata.cost_fiat (the actual money).
 *
 * Runs once per boot and is a no-op after the first time, which is how it
 * reaches the production database on Railway's volume without anyone having to
 * run a script against a disk they cannot see from their laptop. Same shape as
 * backfillDoNotContact below.
 */
function backfillCallCosts(database: DatabaseSync) {
  const rows = database
    .prepare(
      `SELECT id, raw_json FROM calls WHERE cost_fiat_usd IS NULL AND raw_json IS NOT NULL`,
    )
    .all() as unknown as Array<{ id: number; raw_json: string }>;

  if (rows.length === 0) return;

  const update = database.prepare(
    `UPDATE calls SET cost_fiat_usd = ?, platform_price_usd = ?, llm_price_usd = ? WHERE id = ?`,
  );

  let filled = 0;
  for (const row of rows) {
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = (JSON.parse(row.raw_json) as { metadata?: Record<string, unknown> }).metadata;
    } catch {
      continue; // Unparseable payload — leave the row alone rather than zero it.
    }

    const fiat = extractCallCost(metadata);
    if (fiat.costFiatUsd === null) continue;

    update.run(fiat.costFiatUsd, fiat.platformPriceUsd, fiat.llmPriceUsd, row.id);
    filled++;
  }

  if (filled > 0) {
    // Written against the handle directly, NOT via logEvent(): we are inside
    // migrate(), which runs before db()'s instance is assigned, so logEvent
    // would call db() again and recurse forever.
    database
      .prepare("INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)")
      .run(
        Date.now(),
        "costs.backfilled",
        `Read the real cost of ${filled} past call${filled === 1 ? "" : "s"} out of its stored webhook payload.`,
        null,
      );
  }
}

/**
 * Move any pre-existing do-not-call leads onto the permanent suppression list.
 *
 * Without this, everyone who asked to be removed BEFORE the list existed would
 * be re-sourceable by the first lead run. Runs once per boot and is a no-op
 * after the first time (INSERT OR IGNORE against a UNIQUE phone).
 */
function backfillDoNotContact(database: DatabaseSync) {
  const rows = database
    .prepare("SELECT phone FROM leads WHERE status = 'do_not_call'")
    .all() as unknown as Array<{ phone: string }>;
  if (rows.length === 0) return;

  const insert = database.prepare(
    "INSERT OR IGNORE INTO do_not_contact (phone, reason, source, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.phone,
      "Marked do-not-call on the leads list before the suppression list existed.",
      "backfill",
      "system",
      Date.now(),
    );
  }
}

/**
 * Append to the activity log. Every calling-hours hold and every dispatch
 * lands here, so there is a record of why calls did or didn't go out.
 */
export function logEvent(kind: string, message: string, detail?: unknown) {
  try {
    db()
      .prepare("INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)")
      .run(
        Date.now(),
        kind,
        message,
        detail === undefined ? null : JSON.stringify(detail),
      );
  } catch (err) {
    // Logging must never break the operation it is describing.
    console.error("[events] failed to record event", err);
  }
}

export function recentEvents(limit = 40) {
  return db()
    .prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?")
    .all(limit) as Array<{
    id: number;
    ts: number;
    kind: string;
    message: string;
    detail: string | null;
  }>;
}
