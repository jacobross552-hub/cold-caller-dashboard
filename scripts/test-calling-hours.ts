/**
 * Tests for the calling-hours guard.
 *
 * Run with:  npm run test:hours
 *
 * These matter more than the rest of the app: getting them wrong means calls
 * going out at times Australian telemarketing rules don't permit. Each case
 * uses an explicit UTC offset (+10:00 = AEST winter, +11:00 = AEDT summer) so
 * the daylight-saving switch is covered rather than assumed.
 */

import {
  checkCallingWindow,
  checkCallingWindowForState,
  formatSydney,
} from "../src/lib/calling-hours";

interface Case {
  name: string;
  /** ISO instant with an explicit Sydney offset. */
  at: string;
  expectAllowed: boolean;
  /** Sydney-formatted string the next window should start at, if closed. */
  expectNextOpen?: string;
}

const cases: Case[] = [
  // --- Weekday boundaries (Mon-Fri 9am-8pm) ---
  { name: "Monday 8:59am — one minute early", at: "2026-08-17T08:59:00+10:00", expectAllowed: false },
  { name: "Monday 9:00am — window opens", at: "2026-08-17T09:00:00+10:00", expectAllowed: true },
  { name: "Monday 7:59pm — last minute open", at: "2026-08-17T19:59:00+10:00", expectAllowed: true },
  { name: "Monday 8:00pm — window shuts exactly on the hour", at: "2026-08-17T20:00:00+10:00", expectAllowed: false },
  { name: "Monday 8:01pm — one minute past close", at: "2026-08-17T20:01:00+10:00", expectAllowed: false },
  { name: "Wednesday 2pm — mid-window", at: "2026-08-19T14:00:00+10:00", expectAllowed: true },

  // --- Saturday closes at 5pm, not 8pm ---
  // These four are the Saturday equivalents of the weekday boundary above.
  // Under the 5pm rule (plan.md step 9, handover E3, Standard 2017 s8) BOTH
  // 7:59pm and 8:01pm are shut. If the Saturday close is ever widened to 8pm,
  // the 7:59pm case flips to open and 8:01pm stays shut — so this pair is the
  // test that tells you which rule is actually in force.
  { name: "Saturday 4:59pm — still open", at: "2026-08-22T16:59:00+10:00", expectAllowed: true },
  { name: "Saturday 5:00pm — shut", at: "2026-08-22T17:00:00+10:00", expectAllowed: false },
  { name: "Saturday 7pm — shut (would be legal on a weekday)", at: "2026-08-22T19:00:00+10:00", expectAllowed: false },
  { name: "Saturday 7:59pm — shut under the 5pm rule", at: "2026-08-22T19:59:00+10:00", expectAllowed: false },
  { name: "Saturday 8:01pm — shut under either rule", at: "2026-08-22T20:01:00+10:00", expectAllowed: false },

  // --- No Sunday calling at all ---
  { name: "Sunday 10am — no calling on Sundays", at: "2026-08-23T10:00:00+10:00", expectAllowed: false },
  { name: "Sunday 2pm — still no", at: "2026-08-23T14:00:00+10:00", expectAllowed: false },

  // --- Public holidays ---
  {
    name: "Christmas Day 2026 (Friday) — public holiday",
    at: "2026-12-25T10:00:00+11:00",
    expectAllowed: false,
  },
  {
    name: "Boxing Day 2026 (Saturday) — public holiday",
    at: "2026-12-26T10:00:00+11:00",
    expectAllowed: false,
  },
  {
    name: "28 Dec 2026 (Monday, Additional Day) — public holiday",
    at: "2026-12-28T10:00:00+11:00",
    expectAllowed: false,
  },
  {
    name: "29 Dec 2026 (Tuesday) — back to normal",
    at: "2026-12-29T10:00:00+11:00",
    expectAllowed: true,
  },
  {
    name: "Anzac Day 2026 (Saturday) — public holiday",
    at: "2026-04-25T10:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "27 Apr 2026 (Monday, Anzac additional day) — public holiday",
    at: "2026-04-27T10:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "Labour Day 2026 (Mon 5 Oct) — public holiday",
    at: "2026-10-05T10:00:00+11:00",
    expectAllowed: false,
  },

  // --- Daylight saving boundaries ---
  {
    name: "Day AEDT ends (Sun 5 Apr 2026) — Sunday anyway",
    at: "2026-04-05T10:00:00+11:00",
    expectAllowed: false,
  },
  {
    name: "Easter Monday 2026 (6 Apr) — public holiday, first day of AEST",
    at: "2026-04-06T10:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "Tue 7 Apr 2026 10am AEST — first normal day after Easter",
    at: "2026-04-07T10:00:00+10:00",
    expectAllowed: true,
  },
  {
    name: "Tue 6 Oct 2026 9am AEDT — first normal day after DST starts",
    at: "2026-10-06T09:00:00+11:00",
    expectAllowed: true,
  },
];

// Cases where we also assert exactly when calling next becomes legal.
const nextOpenCases: Array<{ name: string; at: string; expectSydney: string }> = [
  {
    name: "Friday 9pm rolls to Saturday 9am",
    at: "2026-08-21T21:00:00+10:00",
    expectSydney: "Sat, 22 Aug, 9:00 am",
  },
  {
    name: "Saturday 6pm skips Sunday to Monday 9am",
    at: "2026-08-22T18:00:00+10:00",
    expectSydney: "Mon, 24 Aug, 9:00 am",
  },
  {
    name: "Christmas Day 2026 skips the whole holiday block to Tue 29 Dec",
    at: "2026-12-25T10:00:00+11:00",
    expectSydney: "Tue, 29 Dec, 9:00 am",
  },
  {
    name: "Anzac Day 2026 (Sat) skips Sunday and the Monday additional day",
    at: "2026-04-25T10:00:00+10:00",
    expectSydney: "Tue, 28 Apr, 9:00 am",
  },
];

/**
 * Per-state timezone cases. A lead is judged in its own state's clock, so
 * "9am in Sydney" is far too early to ring Perth and Adelaide.
 */
const stateCases: Array<{
  name: string;
  state: string | null;
  at: string;
  expectAllowed: boolean;
}> = [
  {
    name: "WA lead at Sydney 9am (7am in Perth) — too early",
    state: "WA",
    at: "2026-08-17T09:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "WA lead at Sydney 11am (9am in Perth) — window just opened",
    state: "WA",
    at: "2026-08-17T11:00:00+10:00",
    expectAllowed: true,
  },
  {
    name: "WA lead at Sydney 8pm (6pm in Perth) — still open there",
    state: "WA",
    at: "2026-08-17T20:00:00+10:00",
    expectAllowed: true,
  },
  {
    name: "WA lead at Sydney 10pm (8pm in Perth) — shut on the hour",
    state: "WA",
    at: "2026-08-17T22:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "SA lead at Sydney 9am (8:30am in Adelaide) — too early",
    state: "SA",
    at: "2026-08-17T09:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "QLD lead at Sydney 9am in daylight saving (8am in Brisbane) — too early",
    state: "QLD",
    at: "2027-01-06T09:00:00+11:00",
    expectAllowed: false,
  },
  {
    name: "QLD lead at Sydney 10am in daylight saving (9am in Brisbane) — open",
    state: "QLD",
    at: "2027-01-06T10:00:00+11:00",
    expectAllowed: true,
  },
  {
    name: "NSW lead behaves exactly like the default",
    state: "NSW",
    at: "2026-08-17T09:00:00+10:00",
    expectAllowed: true,
  },
  {
    name: "Long-form state name is understood",
    state: "Western Australia",
    at: "2026-08-17T09:00:00+10:00",
    expectAllowed: false,
  },
  {
    name: "No state stored — falls back to Sydney",
    state: null,
    at: "2026-08-17T09:00:00+10:00",
    expectAllowed: true,
  },
  {
    name: "Unrecognised state falls back to Sydney rather than failing open",
    state: "Zzz",
    at: "2026-08-17T08:00:00+10:00",
    expectAllowed: false,
  },
];

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
}

console.log("\nCalling-hours guard\n");

for (const testCase of cases) {
  const result = checkCallingWindow(new Date(testCase.at));
  check(
    testCase.name,
    result.allowed === testCase.expectAllowed,
    `expected allowed=${testCase.expectAllowed}, got ${result.allowed} — ${result.reason}`,
  );
}

console.log("\nNext permitted window\n");

for (const testCase of nextOpenCases) {
  const result = checkCallingWindow(new Date(testCase.at));
  const actual = result.nextOpen ? formatSydney(result.nextOpen) : "(none)";
  check(
    testCase.name,
    actual === testCase.expectSydney,
    `expected "${testCase.expectSydney}", got "${actual}"`,
  );
}

console.log("\nPer-state timezones\n");

for (const testCase of stateCases) {
  const result = checkCallingWindowForState(testCase.state, new Date(testCase.at));
  check(
    testCase.name,
    result.allowed === testCase.expectAllowed,
    `expected allowed=${testCase.expectAllowed}, got ${result.allowed} — ${result.reason}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
