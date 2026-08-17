/**
 * NSW public holidays.
 *
 * SOURCE: nsw.gov.au/about-nsw/public-holidays (retrieved 17 Aug 2026).
 * These dates are copied from the official list — they are NOT calculated,
 * because Easter and the various "Additional Day" substitutions can't be
 * derived reliably.
 *
 * Calls must not go out on a public holiday (see plan.md step 9). The dates
 * below cover 2026 and 2027; `COVERED_THROUGH` is what the dashboard checks
 * so it can warn you before the list runs out rather than silently treating
 * an unlisted holiday as a normal working day.
 */

export const NSW_PUBLIC_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-26": "Australia Day",
  "2026-04-03": "Good Friday",
  "2026-04-04": "Easter Saturday",
  "2026-04-05": "Easter Sunday",
  "2026-04-06": "Easter Monday",
  "2026-04-25": "Anzac Day",
  "2026-04-27": "Additional Day (Anzac Day)",
  "2026-06-08": "King's Birthday",
  "2026-08-03": "Bank Holiday",
  "2026-10-05": "Labour Day",
  "2026-12-25": "Christmas Day",
  "2026-12-26": "Boxing Day",
  "2026-12-28": "Additional Day (Boxing Day)",

  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-26": "Australia Day",
  "2027-03-26": "Good Friday",
  "2027-03-27": "Easter Saturday",
  "2027-03-28": "Easter Sunday",
  "2027-03-29": "Easter Monday",
  "2027-04-25": "Anzac Day",
  "2027-04-26": "Additional Day (Anzac Day)",
  "2027-06-14": "King's Birthday",
  "2027-08-02": "Bank Holiday",
  "2027-10-04": "Labour Day",
  "2027-12-25": "Christmas Day",
  "2027-12-26": "Boxing Day",
  "2027-12-27": "Additional Day (Christmas Day)",
  "2027-12-28": "Additional Day (Boxing Day)",
};

/** Last date the table above covers. Update when you add another year. */
export const COVERED_THROUGH = "2027-12-31";

export function holidayName(isoDate: string): string | undefined {
  return NSW_PUBLIC_HOLIDAYS[isoDate];
}

export function isPublicHoliday(isoDate: string): boolean {
  return isoDate in NSW_PUBLIC_HOLIDAYS;
}

/** True once we're within 60 days of the holiday table running out. */
export function holidayTableExpiringSoon(nowIso: string): boolean {
  const days =
    (Date.parse(COVERED_THROUGH) - Date.parse(nowIso)) / (1000 * 60 * 60 * 24);
  return days < 60;
}
