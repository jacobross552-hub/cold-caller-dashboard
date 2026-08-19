/**
 * Fill in the real per-call cost for calls recorded before the cost columns
 * existed.
 *
 * Nothing is fetched and nothing is estimated. The figures were in the webhook
 * payload all along — `raw_json` on every call row — they just weren't being
 * read out of it. The dashboard was storing `metadata.cost`, which is
 * ElevenLabs CREDITS (2092 for a 157-second call), and ignoring
 * `metadata.cost_fiat`, which is the actual money.
 *
 * Safe to run as often as you like: it only touches rows whose cost columns
 * are still empty, and it never writes a row it couldn't read a figure from.
 *
 *     npm run backfill:costs
 */

import { db } from "../src/lib/db";
import { extractCallCost } from "../src/lib/costs";

interface Row {
  id: number;
  raw_json: string | null;
  duration_secs: number | null;
}

function main() {
  const database = db();

  const rows = database
    .prepare(
      `SELECT id, raw_json, duration_secs
         FROM calls
        WHERE cost_fiat_usd IS NULL AND raw_json IS NOT NULL
        ORDER BY id`,
    )
    .all() as unknown as Row[];

  if (rows.length === 0) {
    console.log("Nothing to do — every call already has its real cost stored.");
    return;
  }

  console.log(`${rows.length} call(s) to price.\n`);

  const update = database.prepare(
    `UPDATE calls
        SET cost_fiat_usd = ?, platform_price_usd = ?, llm_price_usd = ?
      WHERE id = ?`,
  );

  let filled = 0;
  let skipped = 0;
  let totalUsd = 0;

  for (const row of rows) {
    let metadata;
    try {
      metadata = JSON.parse(row.raw_json!)?.metadata;
    } catch {
      console.log(`  call ${row.id}: raw_json wouldn't parse — left alone.`);
      skipped++;
      continue;
    }

    const fiat = extractCallCost(metadata);
    if (fiat.costFiatUsd === null) {
      console.log(`  call ${row.id}: payload carries no cost_fiat — left alone.`);
      skipped++;
      continue;
    }

    update.run(fiat.costFiatUsd, fiat.platformPriceUsd, fiat.llmPriceUsd, row.id);
    totalUsd += fiat.costFiatUsd;
    filled++;

    const secs = row.duration_secs ?? 0;
    console.log(
      `  call ${row.id}: ${secs}s → $${fiat.costFiatUsd.toFixed(4)} USD ` +
        `(voice $${(fiat.platformPriceUsd ?? 0).toFixed(4)} + agent LLM $${(fiat.llmPriceUsd ?? 0).toFixed(4)})`,
    );
  }

  console.log(
    `\nPriced ${filled} call(s), $${totalUsd.toFixed(4)} USD in total.` +
      (skipped > 0 ? ` ${skipped} left alone.` : ""),
  );
}

main();
