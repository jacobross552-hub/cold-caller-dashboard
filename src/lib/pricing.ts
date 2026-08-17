/**
 * The price table.
 *
 * SOURCE OF TRUTH: `pricing-engine-notes.md` section 4, which matches
 * `knowledge-base-objections.md` and the PRICING section of
 * `system-prompt-v8.txt`. All three were checked against each other.
 *
 * Nothing here is invented. If Bob changes his pricing, it changes in those
 * files first and then here — never the other way round.
 *
 * X = the discounted weekly loss figure the agent works out live on the call
 * (step 5 of the call flow: missed calls per week x job value, then cut to
 * roughly a third and rounded DOWN).
 */

export interface PriceBand {
  /** Inclusive lower bound of the weekly figure, in dollars. */
  minWeekly: number;
  /** Exclusive upper bound, or null for the top band. */
  maxWeekly: number | null;
  label: string;
  setupFee: number;
  monthlyRetainer: number;
}

export const PRICE_TABLE: PriceBand[] = [
  { minWeekly: 0, maxWeekly: 250, label: "Under $250/wk", setupFee: 1200, monthlyRetainer: 500 },
  { minWeekly: 250, maxWeekly: 600, label: "$250–$600/wk", setupFee: 2200, monthlyRetainer: 800 },
  { minWeekly: 600, maxWeekly: 1200, label: "$600–$1,200/wk", setupFee: 3800, monthlyRetainer: 1300 },
  { minWeekly: 1200, maxWeekly: 2500, label: "$1,200–$2,500/wk", setupFee: 5500, monthlyRetainer: 2200 },
  { minWeekly: 2500, maxWeekly: 5000, label: "$2,500–$5,000/wk", setupFee: 7500, monthlyRetainer: 4000 },
  { minWeekly: 5000, maxWeekly: 10000, label: "$5,000–$10,000/wk", setupFee: 9000, monthlyRetainer: 6000 },
  { minWeekly: 10000, maxWeekly: null, label: "Over $10,000/wk", setupFee: 10000, monthlyRetainer: 8000 },
];

/** The band a given discounted weekly figure falls into. */
export function bandForWeeklyFigure(weekly: number | null | undefined): PriceBand | null {
  if (weekly === null || weekly === undefined || !Number.isFinite(weekly)) return null;
  return (
    PRICE_TABLE.find(
      (band) =>
        weekly >= band.minWeekly && (band.maxWeekly === null || weekly < band.maxWeekly),
    ) ?? null
  );
}

export function formatMoney(amount: number): string {
  return "$" + amount.toLocaleString("en-AU");
}

/**
 * Compare what the agent actually quoted on the call against what the price
 * table says it should have quoted for that weekly figure.
 *
 * system-prompt-v8.txt makes this a hard rule: "Always quote from this table.
 * Never invent a number outside it." An off-table quote is worth knowing about
 * before you walk into the demo, so the brief flags it.
 */
export interface QuoteCheck {
  status: "no-quote" | "no-figure" | "matches" | "off-table";
  expected?: PriceBand;
  message: string;
}

export function checkQuoteAgainstTable(
  weeklyFigure: number | null | undefined,
  quotedSetup: number | null | undefined,
  quotedRetainer: number | null | undefined,
): QuoteCheck {
  const quotedAnything =
    (quotedSetup !== null && quotedSetup !== undefined) ||
    (quotedRetainer !== null && quotedRetainer !== undefined);

  if (!quotedAnything) {
    return { status: "no-quote", message: "No price was quoted on this call." };
  }

  const band = bandForWeeklyFigure(weeklyFigure);
  if (!band) {
    return {
      status: "no-figure",
      message:
        "A price was quoted but no weekly figure was captured, so it can't be checked against the table.",
    };
  }

  const setupOk = quotedSetup === null || quotedSetup === undefined || quotedSetup === band.setupFee;
  const retainerOk =
    quotedRetainer === null || quotedRetainer === undefined || quotedRetainer === band.monthlyRetainer;

  if (setupOk && retainerOk) {
    return {
      status: "matches",
      expected: band,
      message: `Matches the ${band.label} band (${formatMoney(band.setupFee)} setup, ${formatMoney(band.monthlyRetainer)}/mo).`,
    };
  }

  return {
    status: "off-table",
    expected: band,
    message:
      `Quoted ${quotedSetup !== null && quotedSetup !== undefined ? formatMoney(quotedSetup) : "?"} setup / ` +
      `${quotedRetainer !== null && quotedRetainer !== undefined ? formatMoney(quotedRetainer) : "?"} a month, ` +
      `but the ${band.label} band is ${formatMoney(band.setupFee)} setup / ${formatMoney(band.monthlyRetainer)} a month. ` +
      `The agent quoted off-table — worth listening to the recording before the demo.`,
  };
}
