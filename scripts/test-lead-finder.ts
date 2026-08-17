/**
 * Tests for the lead finder's pure logic.
 *
 * Run with:  npm run test:leads
 *
 * Everything here is a pure function — no database, no network, no API key. So
 * these run for free and prove the parts that decide what gets imported and
 * what it costs, without touching Google.
 *
 * The cases that matter most are the ones that stop a bad number reaching the
 * dialler: the personal-mobile guard, the closed-business guard, and the
 * 24/7 detection that stops us ranking a business that already has phone cover
 * as a hot prospect.
 */

import {
  scoreCandidate,
  verticalById,
  customVertical,
  type Candidate,
  type VerticalDefinition,
} from "../src/lib/lead-finder/icp";
import { summariseHours, EMPTY_HOURS } from "../src/lib/lead-finder/hours";
import { planQueries, parseLocations, stateFromLocation } from "../src/lib/lead-finder/queries";
import { nameSimilarity, normaliseBusinessName, parseJsonp } from "../src/lib/lead-finder/abn";
import { estimateRunCost, maxCallsWithinBudget, unitCostUsd } from "../src/lib/lead-finder/cost";
import { parseAuAddress } from "../src/lib/lead-finder/places";

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

const PLUMBER = verticalById("plumber")!;
const SALON = verticalById("hair_beauty")!;

/** A solid, ordinary Tier 1 prospect. Individual tests vary one thing off this. */
function baseCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    placeId: "place-1",
    name: "Hunter Valley Plumbing",
    address: "12 Smith St, Maitland NSW 2320, Australia",
    phoneE164: "+61249561234",
    phoneKind: "landline",
    website: "https://hvplumbing.com.au",
    rating: 4.6,
    reviewCount: 120,
    businessStatus: "OPERATIONAL",
    primaryType: "plumber",
    types: ["plumber", "point_of_interest"],
    hours: summariseHours({
      periods: [1, 2, 3, 4, 5].map((day) => ({
        open: { day, hour: 7, minute: 0 },
        close: { day, hour: 16, minute: 30 },
      })),
    }),
    vertical: PLUMBER,
    suburb: "Maitland",
    state: "NSW",
    ...overrides,
  };
}

console.log("\nLead finder\n" + "=".repeat(72));

// --- Hard disqualifiers ----------------------------------------------------
console.log("\nDisqualifiers — these must never reach the dialler");

check(
  "A permanently closed business is rejected",
  scoreCandidate(baseCandidate({ businessStatus: "CLOSED_PERMANENTLY" })).disqualified,
);

check(
  "A business with no phone number is rejected",
  scoreCandidate(baseCandidate({ phoneE164: undefined })).disqualified,
);

check(
  "A cancelled ABN is rejected",
  scoreCandidate(baseCandidate(), { abnStatus: "cancelled" }).disqualified,
);

// The personal-number guard. A mobile with nothing behind it could be someone's
// private phone, which is exactly what must never be imported.
check(
  "A bare mobile with no website, no category and no ABN is rejected",
  scoreCandidate(
    baseCandidate({
      phoneE164: "+61412345678",
      phoneKind: "mobile",
      website: undefined,
      primaryType: undefined,
    }),
    { abnStatus: "unknown" },
  ).disqualified,
);

// …but the same number IS allowed when something proves a business behind it,
// because for a sole-trader tradie the mobile is the business line.
check(
  "The same mobile is accepted once an active ABN backs it",
  !scoreCandidate(
    baseCandidate({
      phoneE164: "+61412345678",
      phoneKind: "mobile",
      website: undefined,
      primaryType: undefined,
    }),
    { abnStatus: "active" },
  ).disqualified,
);

check(
  "A mobile backed by a website alone is accepted",
  !scoreCandidate(
    baseCandidate({ phoneE164: "+61412345678", phoneKind: "mobile", primaryType: undefined }),
    { abnStatus: "unknown" },
  ).disqualified,
);

// --- Scoring behaviour -----------------------------------------------------
console.log("\nScoring");

const strong = scoreCandidate(baseCandidate());
check("A textbook Tier 1 prospect scores well", strong.score >= 70, `scored ${strong.score}`);
check("…and explains itself", strong.reasons.length >= 4);

const alwaysOpen = scoreCandidate(
  baseCandidate({
    hours: summariseHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }),
  }),
);
check(
  "A 24/7 business scores below the same business that shuts at 4:30",
  alwaysOpen.score < strong.score,
  `24/7 ${alwaysOpen.score} vs normal ${strong.score}`,
);

const advertisesService = scoreCandidate(
  baseCandidate({ name: "Hunter Valley Plumbing — 24/7 Answering Service" }),
);
check(
  "A business advertising an answering service is marked down",
  advertisesService.score < strong.score,
);

const quiet = scoreCandidate(baseCandidate({ reviewCount: 2 }));
check(
  "Two reviews scores below 120 reviews — barely any calls to miss",
  quiet.score < strong.score,
  `${quiet.score} vs ${strong.score}`,
);

const huge = scoreCandidate(baseCandidate({ reviewCount: 1500 }));
check(
  "1,500 reviews also scores below 120 — big enough to have reception",
  huge.score < strong.score,
  `${huge.score} vs ${strong.score}`,
);

const chainByName = scoreCandidate(baseCandidate({ name: "Jim's Plumbing Maitland" }));
check("A franchise name is marked down hard", chainByName.score < strong.score);

const chainByRepeat = scoreCandidate(baseCandidate(), { nameOccurrences: 8 });
check(
  "The same name in 8 suburbs is treated as a chain",
  chainByRepeat.score < strong.score,
  `${chainByRepeat.score} vs ${strong.score}`,
);

const tier3 = scoreCandidate(baseCandidate({ vertical: SALON }));
check("A Tier 3 salon scores below a Tier 1 plumber, all else equal", tier3.score < strong.score);

const custom: VerticalDefinition = customVertical("tree lopper");
check(
  "A free-typed vertical still scores, just lower",
  scoreCandidate(baseCandidate({ vertical: custom })).score < strong.score,
);

check("Scores never exceed 100", scoreCandidate(baseCandidate()).score <= 100);
check(
  "Scores never go below 0",
  scoreCandidate(baseCandidate({ reviewCount: 0, vertical: custom, name: "Jim's Mowing" }), {
    nameOccurrences: 9,
  }).score >= 0,
);

// --- Opening hours ---------------------------------------------------------
console.log("\nOpening hours");

equal("No hours published gives the empty summary", summariseHours(undefined), EMPTY_HOURS);

check(
  "An opening with no close is read as 24/7",
  summariseHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }).is24x7,
);

const nineToFive = summariseHours({
  periods: [1, 2, 3, 4, 5].map((day) => ({
    open: { day, hour: 9, minute: 0 },
    close: { day, hour: 17, minute: 0 },
  })),
});
equal("A 9-5 weekday business closes at 17:00", nineToFive.closesWeekdayMinutes, 17 * 60);
check("…and is closed at the weekend", !nineToFive.openSaturday && !nineToFive.openSunday);

const earlyFriday = summariseHours({
  periods: [
    { open: { day: 1, hour: 9 }, close: { day: 1, hour: 18 } },
    { open: { day: 5, hour: 9 }, close: { day: 5, hour: 15 } },
  ],
});
equal(
  "The EARLIEST weekday close is what counts — that's when calls start being missed",
  earlyFriday.closesWeekdayMinutes,
  15 * 60,
);

const lateNight = summariseHours({
  periods: [{ open: { day: 5, hour: 18 }, close: { day: 6, hour: 2 } }],
});
equal(
  "Trading past midnight is read as late, not as an early close",
  lateNight.closesWeekdayMinutes,
  24 * 60,
);

check(
  "Saturday trading is detected",
  summariseHours({ periods: [{ open: { day: 6, hour: 9 }, close: { day: 6, hour: 13 } }] })
    .openSaturday,
);

// --- Query planning --------------------------------------------------------
console.log("\nQuery planning");

const plan = planQueries([PLUMBER, SALON], ["Parramatta NSW", "Newcastle NSW"]);
equal("Two verticals x two locations makes four searches", plan.length, 4);
equal("The first search is the first vertical in the first suburb", plan[0].query, "plumber in Parramatta NSW");
check(
  "The second search changes suburb, so an early stop still has spread",
  plan[1].location !== plan[0].location,
);
equal("The state is carried through for the timezone", plan[0].state, "NSW");

equal("Locations split on newlines", parseLocations("Parramatta NSW\nNewcastle NSW").length, 2);
equal("Locations split on commas too", parseLocations("Parramatta NSW, Newcastle NSW").length, 2);
equal("Blank lines are ignored", parseLocations("Parramatta NSW\n\n\n").length, 1);
equal("A state is found inside a location string", stateFromLocation("Newcastle NSW 2300"), "NSW");
equal("No state means undefined, not a guess", stateFromLocation("Newcastle"), undefined);

// --- Address parsing (this picks the timezone, so it matters) --------------
console.log("\nAddress parsing");

equal(
  "A standard AU address yields suburb and state",
  parseAuAddress("12 Smith St, Parramatta NSW 2150, Australia"),
  { suburb: "Parramatta", state: "NSW" },
);
equal(
  "A two-word suburb survives",
  parseAuAddress("5 Beach Rd, Coffs Harbour NSW 2450, Australia"),
  { suburb: "Coffs Harbour", state: "NSW" },
);
equal(
  "A Victorian address is not mistaken for NSW",
  parseAuAddress("1 Bourke St, Melbourne VIC 3000, Australia").state,
  "VIC",
);
equal("An unparseable address returns nothing rather than guessing", parseAuAddress("somewhere"), {});

// --- ABN name matching -----------------------------------------------------
console.log("\nABN name matching");

equal(
  "Company noise words are stripped",
  normaliseBusinessName("Dave's Plumbing Services Pty Ltd"),
  ["daves", "plumbing"],
);
// The sole-trader case the mobile-number rule depends on: an apostrophe in the
// trading name must not stop it matching the registered entity.
check(
  "An apostrophe doesn't break the match against the registered name",
  nameSimilarity("Dave's Plumbing", "DAVES PLUMBING PTY LTD") === 1,
  `got ${nameSimilarity("Dave's Plumbing", "DAVES PLUMBING PTY LTD")}`,
);
check(
  "A trading name matches its longer registered entity",
  nameSimilarity("Hunter Valley Plumbing", "HUNTER VALLEY PLUMBING PTY LTD") === 1,
);
check(
  "An unrelated business does not match",
  nameSimilarity("Hunter Valley Plumbing", "Sydney Dental Group") === 0,
);
check(
  "An ampersand is treated as 'and'",
  nameSimilarity("Smith & Sons", "Smith and Sons Pty Ltd") === 1,
);
equal(
  "The JSONP wrapper is peeled off before parsing",
  parseJsonp('callback({"Names":[{"Abn":"123","Name":"TEST"}]})').length,
  1,
);
equal("Plain JSON parses too", parseJsonp('{"Names":[]}').length, 0);

// --- Cost ------------------------------------------------------------------
console.log("\nCost");

equal("One Enterprise text search is $0.035 USD", unitCostUsd("text_search_enterprise"), 0.035);
equal("ABN Lookup is free", unitCostUsd("abn_lookup"), 0);

const estimate = estimateRunCost(100, 1.55);
check(
  "The high estimate is above the low one",
  estimate.highAud > estimate.lowAud,
  `${estimate.lowAud} / ${estimate.highAud}`,
);
check(
  "100 leads estimates under $2 AUD even in the bad case",
  estimate.highAud < 2,
  `estimated ${estimate.highAud}`,
);
check(
  "A bigger run costs more than a smaller one",
  estimateRunCost(200, 1.55).highAud > estimate.highAud,
);

const budget = maxCallsWithinBudget(25, 1.55);
check(
  "A $25 cap allows a few hundred searches, not unlimited",
  budget > 100 && budget < 1000,
  `allowed ${budget}`,
);
check("A tiny cap still allows at least one call", maxCallsWithinBudget(0.001, 1.55) >= 1);

// --- Report ----------------------------------------------------------------
console.log("\n" + "=".repeat(72));
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
