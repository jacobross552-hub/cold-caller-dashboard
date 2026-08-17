/**
 * Turning "plumbers and electricians in Parramatta and Newcastle" into the
 * actual list of Google text searches, in the order they should run.
 *
 * Pure and testable.
 *
 * ORDER MATTERS more than it looks. A run stops the moment it has enough
 * leads, so whatever is at the front of this list is what gets bought. Running
 * every vertical in one suburb before moving on would spend a 40-lead run
 * entirely on Parramatta plumbers. So the list is walked diagonally instead —
 * consecutive queries change both the trade and the suburb, and a run that
 * stops early still stops with a spread.
 */

import type { VerticalDefinition } from "./icp";

const AU_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

export interface PlannedQuery {
  query: string;
  verticalId: string;
  location: string;
  /** Used for the lead's timezone when the address can't be parsed. */
  state?: string;
}

/** Pull the state out of "Parramatta NSW" or "Newcastle, NSW 2300". */
export function stateFromLocation(location: string): string | undefined {
  const upper = location.toUpperCase();
  return AU_STATES.find((state) => new RegExp(`\\b${state}\\b`).test(upper));
}

/**
 * Build the query list.
 *
 * Diagonal traversal: combinations are sorted by (verticalIndex +
 * locationIndex), so the order goes (v0,l0), (v0,l1), (v1,l0), (v0,l2),
 * (v1,l1), (v2,l0)… — every early query differs from the last one in both
 * dimensions.
 */
export function planQueries(
  verticals: VerticalDefinition[],
  locations: string[],
): PlannedQuery[] {
  const combos: Array<PlannedQuery & { rank: number; tiebreak: number }> = [];

  verticals.forEach((vertical, verticalIndex) => {
    locations.forEach((location, locationIndex) => {
      const clean = location.trim();
      if (!clean) return;

      combos.push({
        query: `${vertical.searchTerm} in ${clean}`,
        verticalId: vertical.id,
        location: clean,
        state: stateFromLocation(clean),
        rank: verticalIndex + locationIndex,
        tiebreak: verticalIndex,
      });
    });
  });

  combos.sort((a, b) => a.rank - b.rank || a.tiebreak - b.tiebreak);

  return combos.map(({ query, verticalId, location, state }) => ({
    query,
    verticalId,
    location,
    state,
  }));
}

/**
 * Split a free-typed location box into individual places.
 *
 * Accepts commas or newlines. "Parramatta NSW, Newcastle NSW" and the same two
 * on separate lines both give two locations.
 */
export function parseLocations(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
