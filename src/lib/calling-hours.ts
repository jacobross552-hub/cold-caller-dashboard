/**
 * Calling-hours guard.
 *
 * Permitted calling hours, worked out in the LEAD's local time:
 *   Mon-Fri  9:00am - 8:00pm
 *   Sat      9:00am - 5:00pm
 *   Sun      no calling
 *   Public holidays: no calling
 *
 * Saturday's 5pm close is the figure in plan.md step 9, handover-do-it-
 * yourself.md block E3, and the Telemarketing and Research Calls Industry
 * Standard 2017 s8. Change it in one place only: SATURDAY_CLOSE below.
 *
 * DO NOT WIDEN THESE HOURS ON B2B GROUNDS. The reasoning that looks correct
 * and is wrong: "we only call businesses, the Do Not Call Register is for
 * personal numbers, so the calling-hours rule doesn't bind us." Checked
 * against the regulator's own guidance (donotcall.gov.au): the Standard
 * applies to anyone making telemarketing or research calls to Australian
 * numbers, "even those not on the register", and a caller exempt from the Do
 * Not Call Register Act "must still meet the requirements contained in the
 * industry standards". The B2B exemption only removes "you may not call this
 * number at all" — permitted hours are a separate protection that binds
 * regardless. Two different instruments; the exemption to one is not an
 * exemption to the other.
 *
 * plan.md step 9 is explicit that this must be enforced in the dialling
 * layer, not in the agent's prompt: "Prompts can be talked around; a
 * scheduler can't." Every dispatch goes through this file.
 *
 * TIMEZONES. Each lead is timed in its own state's zone (see timezones.ts),
 * falling back to Australia/Sydney when we don't know the state. This matters:
 * Sydney 9am is 6am in Perth, and Sydney 8pm is only 5pm there.
 *
 * KNOWN GAP, stated rather than hidden: the public-holiday table is NSW-only.
 * A Victorian lead is correctly timed in Melbourne time but is checked against
 * NSW holidays, so it would be blocked on a NSW-only holiday and allowed on a
 * Victorian-only one (Melbourne Cup Day, for example). That is acceptable for
 * a NSW-focused list; it needs per-state holiday tables before dialling other
 * states at volume.
 */

import { config } from "./env";
import { holidayName, holidayTableExpiringSoon, COVERED_THROUGH } from "./holidays";
import { DEFAULT_TIME_ZONE, timeZoneForState } from "./timezones";

/** Saturday's close, in minutes past midnight. 17:00 = 5pm. */
const SATURDAY_CLOSE = 17 * 60;
/** Weekday close, in minutes past midnight. 20:00 = 8pm. */
const WEEKDAY_CLOSE = 20 * 60;
/** Every permitted day opens at 9am. */
const OPEN = 9 * 60;

/** Minutes past midnight that calling opens/closes, by weekday. */
const WINDOWS: Record<number, { open: number; close: number } | null> = {
  0: null, // Sunday — no calling at all
  1: { open: OPEN, close: WEEKDAY_CLOSE }, // Monday
  2: { open: OPEN, close: WEEKDAY_CLOSE },
  3: { open: OPEN, close: WEEKDAY_CLOSE },
  4: { open: OPEN, close: WEEKDAY_CLOSE },
  5: { open: OPEN, close: WEEKDAY_CLOSE }, // Friday
  6: { open: OPEN, close: SATURDAY_CLOSE }, // Saturday
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface ZoneClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
  isoDate: string; // YYYY-MM-DD
  timeZone: string;
}

const SHORT_WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Read the wall clock in a given timezone for a given instant. */
export function zoneClock(at: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): ZoneClock {
  const parts = partsFormatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // Intl renders midnight as hour 24 in some environments; normalise to 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = SHORT_WEEKDAYS[get("weekday")] ?? 0;

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeZone,
  };
}


/**
 * Convert a local wall-clock time in a zone into the matching UTC instant.
 *
 * Done by guessing, measuring the resulting offset, and correcting — which
 * settles even across a daylight-saving boundary.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(target);

  for (let i = 0; i < 3; i++) {
    const clock = zoneClock(guess, timeZone);
    const rendered = Date.UTC(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
      0,
    );
    const drift = target - rendered;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }

  return guess;
}

export interface WindowCheck {
  /** True when a call may legally be dispatched right now. */
  allowed: boolean;
  /** Plain-English reason, always populated. */
  reason: string;
  /** When calling next becomes permitted (undefined if allowed right now). */
  nextOpen?: Date;
  /** When the current window shuts (undefined if not currently open). */
  closesAt?: Date;
  /** Set when the guard is bypassed via ALLOW_OUTSIDE_CALLING_HOURS. */
  overridden?: boolean;
  clock: ZoneClock;
}

function windowForDate(clock: ZoneClock) {
  if (holidayName(clock.isoDate)) return null;
  return WINDOWS[clock.weekday] ?? null;
}

/** Wall clock for `daysAhead` days from the given clock, at midday. */
function clockPlusDays(clock: ZoneClock, daysAhead: number): ZoneClock {
  const base = wallClockToUtc(clock.year, clock.month, clock.day, 12, 0, clock.timeZone);
  const shifted = new Date(base.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  return zoneClock(shifted, clock.timeZone);
}

/**
 * Find the next moment calling is permitted. Looks up to 30 days ahead,
 * which comfortably clears the longest run of consecutive holidays.
 */
export function nextOpenWindow(
  from: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): Date | undefined {
  const clock = zoneClock(from, timeZone);
  const minutesNow = clock.hour * 60 + clock.minute;

  for (let dayOffset = 0; dayOffset <= 30; dayOffset++) {
    const dayClock = dayOffset === 0 ? clock : clockPlusDays(clock, dayOffset);
    const window = windowForDate(dayClock);
    if (!window) continue;

    // Today, but the window has already closed — try tomorrow.
    if (dayOffset === 0 && minutesNow >= window.close) continue;

    const startMinutes =
      dayOffset === 0 ? Math.max(window.open, minutesNow) : window.open;

    return wallClockToUtc(
      dayClock.year,
      dayClock.month,
      dayClock.day,
      Math.floor(startMinutes / 60),
      startMinutes % 60,
      timeZone,
    );
  }

  return undefined;
}

/** The full check. This is the single source of truth for "may I dial?". */
export function checkCallingWindow(
  at: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): WindowCheck {
  const clock = zoneClock(at, timeZone);
  const minutesNow = clock.hour * 60 + clock.minute;
  const holiday = holidayName(clock.isoDate);
  const window = WINDOWS[clock.weekday] ?? null;

  const allowedNormally =
    !holiday && window !== null && minutesNow >= window.open && minutesNow < window.close;

  if (allowedNormally && window) {
    return {
      allowed: true,
      reason: `Inside calling hours (${WEEKDAY_NAMES[clock.weekday]}, closes ${formatMinutes(window.close)} ${zoneLabel(timeZone)}).`,
      closesAt: wallClockToUtc(
        clock.year,
        clock.month,
        clock.day,
        Math.floor(window.close / 60),
        window.close % 60,
        timeZone,
      ),
      clock,
    };
  }

  const nextOpen = nextOpenWindow(at, timeZone);

  let reason: string;
  if (holiday) {
    reason = `${holiday} is a NSW public holiday — no calling today.`;
  } else if (!window) {
    reason = "Sunday — no calling permitted.";
  } else if (minutesNow < window.open) {
    reason = `Too early. ${WEEKDAY_NAMES[clock.weekday]} calling opens at ${formatMinutes(window.open)} ${zoneLabel(timeZone)}.`;
  } else {
    reason = `Too late. ${WEEKDAY_NAMES[clock.weekday]} calling closed at ${formatMinutes(window.close)} ${zoneLabel(timeZone)}.`;
  }

  // The override exists so you can test against your own mobile out of hours.
  // It is reported loudly so it can never be on by accident without showing.
  if (config.allowOutsideCallingHours) {
    return {
      allowed: true,
      overridden: true,
      reason: `CALLING-HOURS GUARD BYPASSED (ALLOW_OUTSIDE_CALLING_HOURS=true). Normally: ${reason}`,
      clock,
    };
  }

  return { allowed: false, reason, nextOpen, clock };
}

/** Convenience: check the window in the timezone implied by a lead's state. */
export function checkCallingWindowForState(
  state: string | null | undefined,
  at: Date = new Date(),
): WindowCheck {
  return checkCallingWindow(at, timeZoneForState(state));
}

/** True if the public-holiday table is about to run out of dates. */
export function holidayDataStale(at: Date = new Date()): boolean {
  return holidayTableExpiringSoon(zoneClock(at).isoDate);
}

/**
 * Midnight in the given zone for the day containing `at`. Used for the daily
 * call cap, which resets on the Australian calendar day, not UTC's.
 */
export function dayStart(at: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): Date {
  const clock = zoneClock(at, timeZone);
  return wallClockToUtc(clock.year, clock.month, clock.day, 0, 0, timeZone);
}

/** Backwards-compatible alias. */
export const sydneyDayStart = (at: Date = new Date()) => dayStart(at, DEFAULT_TIME_ZONE);

export { COVERED_THROUGH, WEEKDAY_NAMES, SATURDAY_CLOSE, WEEKDAY_CLOSE, OPEN };

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display}${suffix}` : `${display}:${String(m).padStart(2, "0")}${suffix}`;
}

/** "Sydney time" / "Perth time" for use in reasons shown to the user. */
function zoneLabel(timeZone: string): string {
  const city = timeZone.split("/")[1]?.replace(/_/g, " ");
  return city ? `${city} time` : "local time";
}

/** Format an instant in a given zone, for display in the UI. */
export function formatInZone(at: Date | number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = typeof at === "number" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** Backwards-compatible alias used throughout the UI. */
export const formatSydney = (at: Date | number) => formatInZone(at, DEFAULT_TIME_ZONE);

export { DEFAULT_TIME_ZONE };
