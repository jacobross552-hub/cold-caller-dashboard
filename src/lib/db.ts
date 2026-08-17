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

  // Google's place_id is the stable dedup key — the same business survives a
  // rename or a number change. Partial index so the many rows with no
  // place_id (pasted/CSV leads) don't collide with each other on NULL.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_place_id
      ON leads(source_place_id) WHERE source_place_id IS NOT NULL;
  `);

  backfillDoNotContact(database);
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
