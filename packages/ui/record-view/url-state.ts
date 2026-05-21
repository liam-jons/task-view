/**
 * record-view/url-state.ts — URL query-string state for filterable
 * indexes (PRODUCT inv 23 — Backlog: "Filter state is reflected in the
 * URL query string so a filtered view is bookmarkable / shareable as a
 * local file URL.").
 *
 * Pure helpers; no DOM dependencies. Consumers (Backlog index view,
 * SPA router) call these to round-trip filter state in and out of URL
 * query strings.
 */

/**
 * Backlog index filter state. `null` (or `"all"` in the URL) means the
 * filter is not applied — items are shown irrespective of that field.
 */
export interface BacklogFilterState {
  track: string | null;
  status: string | null;
  priority: string | null;
}

/** Sentinel string for "all" in the URL query string. */
export const FILTER_ALL = "all";

/**
 * Decode a Backlog filter state from a `URLSearchParams` (or a
 * `?track=&status=&priority=`-shaped string). Missing fields and the
 * literal `all` sentinel both map to `null` (= no filter).
 */
export function decodeBacklogFilters(
  qs: URLSearchParams | string,
): BacklogFilterState {
  const params = typeof qs === "string" ? new URLSearchParams(qs) : qs;
  const decode = (key: string): string | null => {
    const v = params.get(key);
    if (v === null || v === "" || v === FILTER_ALL) return null;
    return v;
  };
  return {
    track: decode("track"),
    status: decode("status"),
    priority: decode("priority"),
  };
}

/**
 * Encode a Backlog filter state back to a URL query string (without the
 * leading `?`). Fields with `null` value are OMITTED from the query
 * string (rather than being emitted as `key=all`) so the URL stays
 * minimal — the absence of a key is the canonical "no filter" form.
 *
 * Deterministic key ordering: `track`, `status`, `priority`. This
 * matters because the URL is the canonical share form per inv 23, and
 * two URLs with the same effective filters should be string-equal.
 */
export function encodeBacklogFilters(state: BacklogFilterState): string {
  const params = new URLSearchParams();
  if (state.track !== null) params.set("track", state.track);
  if (state.status !== null) params.set("status", state.status);
  if (state.priority !== null) params.set("priority", state.priority);
  return params.toString();
}

/**
 * Apply a filter state to a list of items. An item passes when every
 * non-null filter field matches its corresponding item field. `null`
 * filters are no-ops (every item passes that filter).
 */
export function applyBacklogFilters<
  T extends { track: string; status: string; priority: string },
>(items: readonly T[], filters: BacklogFilterState): T[] {
  return items.filter((item) => {
    if (filters.track !== null && item.track !== filters.track) return false;
    if (filters.status !== null && item.status !== filters.status) {
      return false;
    }
    if (filters.priority !== null && item.priority !== filters.priority) {
      return false;
    }
    return true;
  });
}
