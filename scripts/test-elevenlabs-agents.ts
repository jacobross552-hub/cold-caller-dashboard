/**
 * Tests for elevenlabs.ts's agent read/update functions — specifically the
 * PATCH payload construction in updateAgentPrompt, which every other test
 * suite stubs out entirely at the orchestration level (test-learning.ts,
 * test-demo-agent.ts). That's exactly how a real bug shipped undetected: GET
 * returns BOTH `tools` (expanded) and `tool_ids` (canonical) under
 * conversation_config.agent.prompt, and PATCHing both back is rejected by
 * ElevenLabs outright ("Cannot specify both tools and tool IDs"). This file
 * tests the actual request-building logic against that real response shape.
 *
 * Run with:  npm run test:elevenlabs-agents
 *
 * No real network: global fetch is stubbed. No API key spend.
 */

process.env.ELEVENLABS_API_KEY = "test-key";

const elevenlabs = require("../src/lib/elevenlabs") as typeof import("../src/lib/elevenlabs");

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

/** Shaped like a real GET response — trimmed to the fields that matter here. */
function realisticAgentConfig(promptText: string) {
  return {
    agent_id: "agent_real",
    name: "My Agent",
    conversation_config: {
      agent: {
        first_message: "Hi there",
        language: "en",
        prompt: {
          prompt: promptText,
          llm: "claude-sonnet-4-6",
          temperature: 0.5,
          tool_ids: ["tool_calendar_create", "tool_calendar_check", "tool_send_sms"],
          // GET's expanded, read-only convenience view of the same tools —
          // this is the field that must NOT be sent back on a PATCH.
          tools: [
            { type: "api_integration_webhook", name: "google_calendar_create_event" },
            { type: "api_integration_webhook", name: "google_calendar_check_availability" },
            { type: "webhook", name: "send_sms" },
            { type: "system", name: "voicemail_detection" },
          ],
          knowledge_base: [],
        },
      },
      tts: { voice_id: "abc123" },
    },
    platform_settings: { widget: {} },
  };
}

async function main() {
  console.log("\n1. updateAgentPrompt strips the expanded `tools` array, keeps `tool_ids`\n");

  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(realisticAgentConfig("OLD PROMPT")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The PATCH itself — this is what would have 400'd against the real API.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await elevenlabs.updateAgentPrompt("agent_real", "NEW PROMPT TEXT");

  const patchCall = requests.find((r) => r.method === "PATCH");
  check("a PATCH request was made", Boolean(patchCall));

  const patchedPrompt = (patchCall?.body as { conversation_config: { agent: { prompt: Record<string, unknown> } } })
    .conversation_config.agent.prompt;

  check("`tools` is absent from the PATCH body — this is the field ElevenLabs rejects alongside tool_ids", !("tools" in patchedPrompt));
  equal("`tool_ids` is preserved exactly as GET returned it", patchedPrompt.tool_ids, [
    "tool_calendar_create",
    "tool_calendar_check",
    "tool_send_sms",
  ]);
  equal("the prompt text is updated", patchedPrompt.prompt, "NEW PROMPT TEXT");
  equal("unrelated prompt fields survive untouched", patchedPrompt.temperature, 0.5);
  equal("unrelated fields elsewhere in conversation_config survive untouched", (patchCall?.body as { conversation_config: { tts: { voice_id: string } } }).conversation_config.tts.voice_id, "abc123");

  console.log("\n2. currentPromptText reads the live prompt out of a fetched config\n");

  equal("extracts the prompt string", elevenlabs.currentPromptText(realisticAgentConfig("SOME PROMPT")), "SOME PROMPT");
  equal("missing conversation_config returns empty string, not a throw", elevenlabs.currentPromptText({}), "");

  console.log("\n3. updateAgentPrompt throws (doesn't silently no-op) when the config shape is unexpected\n");

  global.fetch = (async () =>
    new Response(JSON.stringify({ conversation_config: {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  let threw = false;
  try {
    await elevenlabs.updateAgentPrompt("agent_real", "won't get here");
  } catch {
    threw = true;
  }
  check("throws rather than silently doing nothing on a malformed config", threw);

  global.fetch = originalFetch;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nElevenLabs-agents test crashed:", err);
  process.exit(1);
});
