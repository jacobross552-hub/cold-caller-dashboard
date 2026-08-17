/**
 * Turning Google's opening-hours blob into the two facts we actually score on:
 * when do they shut on a weekday, and are they open at the weekend.
 *
 * Pure, so it is covered by the scoring tests.
 *
 * Google's shape (`regularOpeningHours`):
 *   periods: [{ open: {day,hour,minute}, close: {day,hour,minute} }, ...]
 *   day: 0 = Sunday … 6 = Saturday
 *
 * A 24/7 business is expressed as ONE period that opens Sunday 00:00 and has
 * no `close` at all. That is the case worth getting right — it means they
 * already have round-the-clock phone cover and are the weakest prospect on the
 * list, so misreading it as "shuts at midnight" would rank them far too high.
 */

export interface PlacePeriodPoint {
  day?: number;
  hour?: number;
  minute?: number;
}

export interface PlacePeriod {
  open?: PlacePeriodPoint;
  close?: PlacePeriodPoint;
}

export interface PlaceOpeningHours {
  periods?: PlacePeriod[];
  weekdayDescriptions?: string[];
}

export interface HoursSummary {
  /** False when Google published nothing usable. */
  hasHours: boolean;
  is24x7: boolean;
  /**
   * Earliest weekday (Mon-Fri) closing time, in minutes past midnight.
   * Earliest rather than latest: the first evening they stop answering is when
   * calls start being missed.
   */
  closesWeekdayMinutes: number | null;
  openSaturday: boolean;
  openSunday: boolean;
}

export const EMPTY_HOURS: HoursSummary = {
  hasHours: false,
  is24x7: false,
  closesWeekdayMinutes: null,
  openSaturday: false,
  openSunday: false,
};

export function summariseHours(hours: PlaceOpeningHours | undefined): HoursSummary {
  const periods = hours?.periods;
  if (!periods || periods.length === 0) return { ...EMPTY_HOURS };

  // The 24/7 marker: an opening with no matching close.
  const alwaysOpen = periods.some((period) => period.open && !period.close);
  if (alwaysOpen) {
    return {
      hasHours: true,
      is24x7: true,
      closesWeekdayMinutes: null,
      openSaturday: true,
      openSunday: true,
    };
  }

  let earliestWeekdayClose: number | null = null;
  let openSaturday = false;
  let openSunday = false;

  for (const period of periods) {
    const openDay = period.open?.day;
    if (openDay === undefined) continue;

    if (openDay === 6) openSaturday = true;
    if (openDay === 0) openSunday = true;

    // Monday-Friday only for the closing-time signal.
    if (openDay >= 1 && openDay <= 5 && period.close) {
      const hour = period.close.hour ?? 0;
      const minute = period.close.minute ?? 0;
      // A close on the following day (e.g. open Fri, close Sat 02:00) means
      // they trade past midnight — treat as late rather than as an early close.
      const crossesMidnight = period.close.day !== undefined && period.close.day !== openDay;
      const minutes = crossesMidnight ? 24 * 60 : hour * 60 + minute;

      if (earliestWeekdayClose === null || minutes < earliestWeekdayClose) {
        earliestWeekdayClose = minutes;
      }
    }
  }

  return {
    hasHours: true,
    is24x7: false,
    closesWeekdayMinutes: earliestWeekdayClose,
    openSaturday,
    openSunday,
  };
}
