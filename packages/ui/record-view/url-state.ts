/**
 * record-view/url-state.ts — URL query-string state for filterable
 * indexes (PRODUCT inv 23 — Backlog: "Filter state is reflected in the
 * URL query string so a filtered view is bookmarkable / shareable as a
 * local file URL.").
 *
 * Pure helpers; no DOM dependencies. Consumers (Backlog index view,
 * SPA router) call these to round-trip filter state in and out of URL
 * query strings.
 *
 * {20.29} also adds `decodeLedgerParam` here — the read side of the
 * cross-ledger `/?ledger=<slug>&record=<id>` scheme (SPEC §5 slice 2).
 */
import type { LedgerSlug } from "./anchors";

/**
 * Valid cross-ledger nav slugs ({20.29}, SPEC §2). Mirrors the server-side
 * `LEDGER_SLUGS` (packages/server/cross-ledger.ts); kept in the UI layer
 * because `packages/ui` must not depend on `packages/server`.
 */
const LEDGER_SLUG_SET = new Set<LedgerSlug>([
  "task-list",
  "roadmap",
  "backlog",
]);

/**
 * Decode the cross-ledger `?ledger=<slug>` param ({20.29}, SPEC §5 slice 2).
 *
 * Returns the slug only when it is one of the three recognised nav slugs;
 * an absent, empty, or unrecognised `ledger` param returns null — the
 * caller then treats the request as targeting the LAUNCHED ledger, keeping
 * bare `/?record=<id>` fully back-compatible.
 */
export function decodeLedgerParam(
  qs: URLSearchParams | string,
): LedgerSlug | null {
  const params = typeof qs === "string" ? new URLSearchParams(qs) : qs;
  const raw = params.get("ledger");
  if (raw === null || raw === "") return null;
  return LEDGER_SLUG_SET.has(raw as LedgerSlug) ? (raw as LedgerSlug) : null;
}

/**
 * Backlog index filter state. `null` (or `"all"` in the URL) means the
 * filter is not applied — items are shown irrespective of that field.
 */
export interface BacklogFilterState {
  track: string | null;
  status: string | null;
  priority: string | null;
  /**
   * Free-text keyword search over the item's id + description (+ title). `null`
   * / absent = no search. Optional so existing `{track,status,priority}`
   * literals stay valid; `decodeBacklogFilters` always populates it.
   */
  q?: string | null;
}

/**
 * Keyword-search matcher shared by all index surfaces. An empty/absent query
 * matches everything; otherwise the (case-insensitive) needle must appear in at
 * least one of the supplied fields. Null/undefined fields are skipped.
 */
export function matchesQuery(
  q: string | null | undefined,
  fields: readonly (string | null | undefined)[],
): boolean {
  if (q == null || q === "") return true;
  const needle = q.toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/**
 * Decode a free-text `q` search param. Unlike the filter selects, `q` has NO
 * `all` sentinel (a user may legitimately search for the string "all"); only an
 * absent or empty value means "no search".
 */
function decodeQ(params: URLSearchParams): string | null {
  const v = params.get("q");
  return v === null || v === "" ? null : v;
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
    q: decodeQ(params),
  };
}

/**
 * Encode a Backlog filter state back to a URL query string (without the
 * leading `?`). Fields with `null` value are OMITTED from the query
 * string (rather than being emitted as `key=all`) so the URL stays
 * minimal — the absence of a key is the canonical "no filter" form.
 *
 * Deterministic key ordering: `track`, `status`, `priority`, then `q`. This
 * matters because the URL is the canonical share form per inv 23, and
 * two URLs with the same effective filters should be string-equal.
 */
export function encodeBacklogFilters(state: BacklogFilterState): string {
  const params = new URLSearchParams();
  if (state.track !== null) params.set("track", state.track);
  if (state.status !== null) params.set("status", state.status);
  if (state.priority !== null) params.set("priority", state.priority);
  if (state.q != null && state.q !== "") params.set("q", state.q);
  return params.toString();
}

/**
 * Apply a filter state to a list of items. An item passes when every
 * non-null filter field matches its corresponding item field. `null`
 * filters are no-ops (every item passes that filter).
 */
export function applyBacklogFilters<
  T extends {
    id: string;
    track: string;
    status: string;
    priority: string;
    description?: string;
    title?: string;
  },
>(items: readonly T[], filters: BacklogFilterState): T[] {
  return items.filter((item) => {
    if (filters.track !== null && item.track !== filters.track) return false;
    if (filters.status !== null && item.status !== filters.status) {
      return false;
    }
    if (filters.priority !== null && item.priority !== filters.priority) {
      return false;
    }
    if (!matchesQuery(filters.q, [item.id, item.description, item.title])) {
      return false;
    }
    return true;
  });
}

/**
 * Task-list index filter state. `q` is the free-text keyword search over a
 * task's id + title. (Sorting and a done/cancelled exclude toggle extend this
 * shape in follow-on work — see docs/specs/qol-improvements/PLAN.md.)
 */
/** Statuses hidden by the task-list "hide done/cancelled" toggle. */
const TASK_LIST_DONE_STATUSES = new Set<string>(["done", "cancelled"]);

export interface TaskListFilterState {
  q: string | null;
  /**
   * Hide tasks whose status is `done` or `cancelled` (reduces the active
   * working set + cognitive load). Optional (absent = false) so `{ q }`
   * literals stay valid; `decodeTaskListFilters` always populates it.
   */
  excludeDone?: boolean;
}

export function decodeTaskListFilters(
  qs: URLSearchParams | string,
): TaskListFilterState {
  const params = typeof qs === "string" ? new URLSearchParams(qs) : qs;
  return { q: decodeQ(params), excludeDone: params.get("excludeDone") === "1" };
}

export function encodeTaskListFilters(state: TaskListFilterState): string {
  const params = new URLSearchParams();
  if (state.q != null && state.q !== "") params.set("q", state.q);
  if (state.excludeDone) params.set("excludeDone", "1");
  return params.toString();
}

export function applyTaskListFilters<
  T extends { id: string; title: string; status?: string },
>(tasks: readonly T[], filters: TaskListFilterState): T[] {
  return tasks.filter((t) => {
    if (!matchesQuery(filters.q, [t.id, t.title])) return false;
    if (
      filters.excludeDone &&
      t.status !== undefined &&
      TASK_LIST_DONE_STATUSES.has(t.status)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Compute the next query string for a keyword-search navigation: set (or, when
 * blank, clear) the `q` param while PRESERVING every other param already on the
 * URL (filters, `?ledger=`, future sort keys). Pure — the SPA assigns the
 * result to `window.location.search`. Kept here (not in the client) so it is
 * unit-testable without a DOM.
 */
export function nextSearchForQuery(currentSearch: string, q: string): string {
  const params = new URLSearchParams(currentSearch);
  const v = q.trim();
  if (v === "") params.delete("q");
  else params.set("q", v);
  return params.toString();
}

/**
 * Next query string for a boolean toggle (e.g. the task-list "hide
 * done/cancelled" checkbox): set `<key>=1` when on, delete it when off, while
 * PRESERVING every other param. Pure — the SPA assigns the result to
 * `window.location.search`.
 */
export function nextSearchForFlag(
  currentSearch: string,
  key: string,
  on: boolean,
): string {
  const params = new URLSearchParams(currentSearch);
  if (on) params.set(key, "1");
  else params.delete(key);
  return params.toString();
}

/**
 * Column sort state for the read-only index views. `field === null` keeps the
 * ledger's natural (array) order — the default. Backlog is excluded from
 * user sort (its order is the persisted `rank`; see docs/notes/ledger-sorting.md).
 */
export interface SortState {
  field: string | null;
  dir: "asc" | "desc";
}

export function decodeSort(qs: URLSearchParams | string): SortState {
  const params = typeof qs === "string" ? new URLSearchParams(qs) : qs;
  const field = params.get("sortField");
  const dir = params.get("sortDir") === "desc" ? "desc" : "asc";
  return { field: field === null || field === "" ? null : field, dir };
}

export function encodeSort(state: SortState): string {
  const params = new URLSearchParams();
  if (state.field !== null && state.field !== "") {
    params.set("sortField", state.field);
    params.set("sortDir", state.dir);
  }
  return params.toString();
}

/**
 * Next query string for a column-header click — a 3-state toggle that PRESERVES
 * every other param: an inactive field → ascending; the active field
 * ascending → descending; the active field descending → cleared (natural
 * order). The SPA assigns the result to `window.location.search`.
 */
export function nextSortForField(currentSearch: string, field: string): string {
  const params = new URLSearchParams(currentSearch);
  const curField = params.get("sortField");
  const curDir = params.get("sortDir") === "desc" ? "desc" : "asc";
  if (curField === field) {
    if (curDir === "asc") {
      params.set("sortDir", "desc");
    } else {
      params.delete("sortField");
      params.delete("sortDir");
    }
  } else {
    params.set("sortField", field);
    params.set("sortDir", "asc");
  }
  return params.toString();
}

/** Roadmap index filter state. `q` searches a theme's id + title. */
export interface RoadmapFilterState {
  q: string | null;
}

export function decodeRoadmapFilters(
  qs: URLSearchParams | string,
): RoadmapFilterState {
  const params = typeof qs === "string" ? new URLSearchParams(qs) : qs;
  return { q: decodeQ(params) };
}

export function encodeRoadmapFilters(state: RoadmapFilterState): string {
  const params = new URLSearchParams();
  if (state.q != null && state.q !== "") params.set("q", state.q);
  return params.toString();
}

export function applyRoadmapFilters<T extends { id: string; title: string }>(
  themes: readonly T[],
  filters: RoadmapFilterState,
): T[] {
  return themes.filter((t) => matchesQuery(filters.q, [t.id, t.title]));
}
