/**
 * Credential check.
 *
 * Run with:  npm run check:creds
 *
 * Reads `.env` and actually calls each service, rather than just checking a
 * value is present. Use it straight after rotating keys, before starting a
 * live run — a rotated-but-not-pasted key looks identical to a working one
 * until the first call fails.
 *
 * Read-only. It fetches account and agent details; it never places a call,
 * sends a message, or changes anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { optional, config } from "../src/lib/env";

type Status = "pass" | "fail" | "warn" | "skip";

interface Result {
  status: Status;
  detail: string;
}

const results: Array<{ group: string; name: string; result: Result }> = [];

function record(group: string, name: string, result: Result) {
  results.push({ group, name, result });
}

function missing(names: string[]): string {
  return `Not set in .env: ${names.join(", ")}`;
}

async function checkElevenLabs() {
  const group = "ElevenLabs";
  const key = optional("ELEVENLABS_API_KEY");
  const agentId = optional("ELEVENLABS_AGENT_ID");
  const phoneId = optional("ELEVENLABS_PHONE_NUMBER_ID");

  if (!key) {
    record(group, "API key", { status: "fail", detail: missing(["ELEVENLABS_API_KEY"]) });
    return;
  }

  const headers = { "xi-api-key": key };

  // --- Agent ---
  if (!agentId) {
    record(group, "Agent", { status: "fail", detail: missing(["ELEVENLABS_AGENT_ID"]) });
  } else {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`,
        { headers },
      );
      if (response.status === 401) {
        record(group, "API key", {
          status: "fail",
          detail: "Rejected (401). The key is wrong, or was rotated and not updated here.",
        });
        return;
      }
      if (response.status === 404) {
        record(group, "Agent", {
          status: "fail",
          detail: `No agent with id ${agentId}. Check the id in the agent's URL.`,
        });
      } else if (!response.ok) {
        record(group, "Agent", {
          status: "fail",
          detail: `ElevenLabs returned ${response.status}.`,
        });
      } else {
        const agent = (await response.json()) as { name?: string };
        record(group, "API key + agent", {
          status: "pass",
          detail: `Key accepted. Agent "${agent.name ?? agentId}" reachable.`,
        });
      }
    } catch (err) {
      record(group, "Agent", { status: "fail", detail: describe(err) });
    }
  }

  // --- Phone number ---
  if (!phoneId) {
    record(group, "Phone number", {
      status: "fail",
      detail: missing(["ELEVENLABS_PHONE_NUMBER_ID"]),
    });
  } else {
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", { headers });
      if (!response.ok) {
        record(group, "Phone number", {
          status: "warn",
          detail: `Couldn't list phone numbers (${response.status}) — check it by hand.`,
        });
      } else {
        const numbers = (await response.json()) as Array<{
          phone_number_id?: string;
          phone_number?: string;
          label?: string;
        }>;
        const match = Array.isArray(numbers)
          ? numbers.find((n) => n.phone_number_id === phoneId)
          : undefined;

        if (match) {
          record(group, "Phone number", {
            status: "pass",
            detail: `${match.phone_number ?? phoneId}${match.label ? ` (${match.label})` : ""} is on the account.`,
          });
        } else {
          const available = Array.isArray(numbers)
            ? numbers.map((n) => `${n.phone_number} = ${n.phone_number_id}`).join("; ")
            : "none";
          record(group, "Phone number", {
            status: "fail",
            detail: `ELEVENLABS_PHONE_NUMBER_ID doesn't match any number on the account. Available: ${available || "none"}`,
          });
        }
      }
    } catch (err) {
      record(group, "Phone number", { status: "fail", detail: describe(err) });
    }
  }
}

async function checkTwilio() {
  const group = "Twilio";
  const sid = optional("TWILIO_ACCOUNT_SID");
  const token = optional("TWILIO_AUTH_TOKEN");

  if (!sid || !token) {
    record(group, "Account", {
      status: "fail",
      detail: missing(
        [!sid ? "TWILIO_ACCOUNT_SID" : null, !token ? "TWILIO_AUTH_TOKEN" : null].filter(
          Boolean,
        ) as string[],
      ),
    });
    return;
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        },
      },
    );

    if (response.status === 401) {
      record(group, "Account", {
        status: "fail",
        detail: "Rejected (401). SID or auth token is wrong, or was rotated and not updated here.",
      });
      return;
    }
    if (!response.ok) {
      record(group, "Account", { status: "fail", detail: `Twilio returned ${response.status}.` });
      return;
    }

    const account = (await response.json()) as { friendly_name?: string; type?: string; status?: string };

    record(group, "Account", {
      status: "pass",
      detail: `Credentials valid — "${account.friendly_name ?? sid}" (status: ${account.status ?? "unknown"}).`,
    });

    // This answers the question left open in build-log.md since Segment 0.
    if (account.type === "Trial") {
      record(group, "Account type", {
        status: "warn",
        detail:
          "TRIAL account. Outbound calls only reach numbers you've verified in Twilio — real prospects will fail. Upgrade before a live run.",
      });
    } else if (account.type === "Full") {
      record(group, "Account type", {
        status: "pass",
        detail: "Full (upgraded) account — can call any number.",
      });
    } else {
      record(group, "Account type", {
        status: "warn",
        detail: `Unrecognised account type "${account.type}". Check the console.`,
      });
    }
  } catch (err) {
    record(group, "Account", { status: "fail", detail: describe(err) });
  }
}

async function checkAnthropic() {
  const group = "Anthropic";
  const key = optional("ANTHROPIC_API_KEY");

  if (!key) {
    record(group, "API key", {
      status: "fail",
      detail: missing(["ANTHROPIC_API_KEY"]) + " — summaries and pre-call briefs will be skipped.",
    });
    return;
  }

  try {
    // Free, read-only, and confirms both the key and the configured model.
    const response = await fetch(
      `https://api.anthropic.com/v1/models/${encodeURIComponent(config.anthropicModel)}`,
      {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      },
    );

    if (response.status === 401) {
      record(group, "API key", {
        status: "fail",
        detail: "Rejected (401). The key is wrong, or was rotated and not updated here.",
      });
    } else if (response.status === 404) {
      record(group, "Model", {
        status: "fail",
        detail: `Key works, but model "${config.anthropicModel}" wasn't found. Check ANTHROPIC_MODEL.`,
      });
    } else if (!response.ok) {
      record(group, "API key", { status: "fail", detail: `Anthropic returned ${response.status}.` });
    } else {
      const model = (await response.json()) as { display_name?: string };
      record(group, "API key + model", {
        status: "pass",
        detail: `Key accepted. Using ${model.display_name ?? config.anthropicModel}.`,
      });
    }
  } catch (err) {
    record(group, "API key", { status: "fail", detail: describe(err) });
  }
}

/**
 * Lead finder keys.
 *
 * Presence only — deliberately no live call. Every Places request bills, and
 * there is no free "is this key valid?" endpoint. The first small lead run is
 * the real test, and it's a safe one: a bad key comes back 403, and Google
 * doesn't charge for rejected requests.
 */
function checkLeadFinder() {
  const group = "Lead finder";

  const places = optional("GOOGLE_PLACES_API_KEY");
  record(group, "Google Places key", places
    ? {
        status: "pass",
        detail:
          "Set. Not called from here — every Places request bills, so the first small run is " +
          "what proves it. A wrong key returns 403 and costs nothing.",
      }
    : {
        status: "fail",
        detail:
          "Not set in .env. The Find leads page won't run without it. Needs a Google Cloud " +
          "project with Places API (NEW) enabled and billing switched on.",
      });

  const abn = optional("ABN_LOOKUP_GUID");
  record(group, "ABN Lookup GUID", abn
    ? { status: "pass", detail: "Set. Businesses will be cross-checked against the business register." }
    : {
        status: "warn",
        detail:
          "Not set — optional. Without it, sole-trader mobile numbers only get imported when a " +
          "website or business category backs them up, so you'll find fewer of them.",
      });
}

function checkLocalOnly() {
  // The webhook secret can't be verified remotely — ElevenLabs shows it once
  // at creation and never again. Presence is all we can check here; the real
  // proof is a call landing in the call log.
  const secret = optional("ELEVENLABS_WEBHOOK_SECRET");
  record("Webhook", "Signing secret", {
    status: secret ? "pass" : "fail",
    detail: secret
      ? "Set. Can't be verified from here — the proof is a finished call appearing in the call log."
      : "Not set. Calls will go out but nothing will come back into the call log.",
  });

  const password = optional("DASHBOARD_PASSWORD");
  const sessionSecret = optional("SESSION_SECRET");

  record("Dashboard", "Login", {
    status: !password || !sessionSecret ? "fail" : password === "changeme" ? "warn" : "pass",
    detail:
      !password || !sessionSecret
        ? missing(
            [!password ? "DASHBOARD_PASSWORD" : null, !sessionSecret ? "SESSION_SECRET" : null].filter(
              Boolean,
            ) as string[],
          )
        : password === "changeme"
          ? 'Still the temporary password "changeme". Change it before this goes on the internet.'
          : "Password and session secret set.",
  });

  const alertTo = optional("ALERT_TO_NUMBER");
  record("Dashboard", "Booking alerts", {
    status: alertTo ? "pass" : "warn",
    detail: alertTo
      ? `Booking texts go to ${alertTo}.`
      : "ALERT_TO_NUMBER not set — you won't get a text when a meeting books.",
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const LABELS: Record<Status, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

/**
 * Where is each credential actually coming from?
 *
 * WHY THIS EXISTS. Node's --env-file does NOT overwrite a variable that is
 * already in the environment. So if a key is set as a Windows user environment
 * variable, it silently wins over `.env` — and the moment you rotate that key
 * and paste the new one into `.env`, the app carries on using the old one.
 * Everything looks fine until the old key is revoked, and then the error points
 * at `.env`, which is correct and being ignored.
 *
 * Comparing the file on disk against the live environment catches it.
 */
function checkCredentialSources() {
  const group = "Where keys come from";
  const path = resolve(process.cwd(), ".env");

  if (!existsSync(path)) {
    record(group, ".env", { status: "warn", detail: "No .env file found in this folder." });
    return;
  }

  const fromFile = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) fromFile.set(match[1], match[2].trim());
  }

  const watched = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_PHONE_NUMBER_ID",
    "ELEVENLABS_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "GOOGLE_PLACES_API_KEY",
    "ABN_LOOKUP_GUID",
  ];

  let anythingOdd = false;

  for (const name of watched) {
    const inFile = fromFile.get(name) ?? "";
    const live = (process.env[name] ?? "").trim();

    if (!live) continue; // Not set anywhere — the per-service checks report it.

    if (inFile && inFile === live) continue; // Normal: .env is the source.

    anythingOdd = true;

    if (!inFile) {
      record(group, name, {
        status: "warn",
        detail:
          "Set in your Windows/shell environment, NOT in .env. It works now, but when you " +
          "rotate this key the old environment value will override whatever you paste into " +
          ".env. Remove it from Windows and keep the key in .env only.",
      });
    } else {
      record(group, name, {
        status: "fail",
        detail:
          "Your Windows/shell environment and .env hold DIFFERENT values, and the environment " +
          "wins — .env is being ignored for this key. Remove it from Windows so .env is the " +
          "single source.",
      });
    }
  }

  if (!anythingOdd) {
    record(group, "Source", { status: "pass", detail: ".env is the single source for every key." });
  }
}

async function main() {
  console.log("\nChecking credentials in .env (read-only — nothing is called or sent)\n");

  checkCredentialSources();
  checkLocalOnly();
  await checkElevenLabs();
  await checkTwilio();
  await checkAnthropic();
  checkLeadFinder();

  let lastGroup = "";
  for (const row of results) {
    if (row.group !== lastGroup) {
      console.log(`\n${row.group}`);
      lastGroup = row.group;
    }
    console.log(`  ${LABELS[row.result.status].padEnd(5)} ${row.name}: ${row.result.detail}`);
  }

  const failures = results.filter((r) => r.result.status === "fail").length;
  const warnings = results.filter((r) => r.result.status === "warn").length;

  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log("Everything checks out. Safe to start a live run.\n");
  } else if (failures === 0) {
    console.log(`No failures, ${warnings} thing(s) worth reading above before a live run.\n`);
  } else {
    console.log(`${failures} problem(s) to fix before a live run, ${warnings} warning(s).\n`);
  }

  await shutdown(failures === 0 ? 0 : 1);
}

/**
 * Wind down instead of calling process.exit().
 *
 * process.exit() kills the process while fetch's keep-alive sockets are still
 * open, which trips a libuv assertion on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * The report has already printed by that point, so it reads as a crash at the
 * end of a perfectly good run. Closing the connection pool and setting an exit
 * code lets Node shut down in order and still report success or failure to the
 * shell.
 */
async function shutdown(code: number) {
  process.exitCode = code;

  const dispatcher = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;

  try {
    await dispatcher?.close?.();
  } catch {
    // Nothing open, or already closed. Either way there's nothing to do.
  }
}

main().catch(async (err) => {
  console.error("\nThe check itself failed:", describe(err), "\n");
  await shutdown(1);
});
