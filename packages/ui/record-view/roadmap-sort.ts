/**
 * record-view/roadmap-sort.ts — pure sort for the Roadmap theme index page
 * (docs/notes/ledger-sorting.md). Mirrors backlog-sort.ts: pure, deterministic,
 * stable, no React/DOM/I/O.
 *
 * `sort.field === null` (or an unrecognised field) keeps the ledger's natural
 * (JSON array) order. Sortable columns: id (numeric), title (alphabetic),
 * time_horizon (now→next→later ordinal), status (pending→in_progress→done
 * ordinal), linked_tasks (count).
 */
import type { SortState } from "./url-state";

type SortableTheme = {
  id: string;
  title: string;
  time_horizon: string;
  status: string;
  linked_tasks: readonly unknown[];
};

const TIME_HORIZON_ORDINALS: Readonly<Record<string, number>> = {
  now: 0,
  next: 1,
  later: 2,
};

const THEME_STATUS_ORDINALS: Readonly<Record<string, number>> = {
  pending: 0,
  in_progress: 1,
  done: 2,
};

const THEME_SORT_FIELDS = new Set<string>([
  "id",
  "title",
  "time_horizon",
  "status",
  "linked_tasks",
]);

function numericIdCompare(a: string, b: string): number {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function byString(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function themeFieldCompare(
  field: string,
  a: SortableTheme,
  b: SortableTheme,
): number {
  switch (field) {
    case "id":
      return numericIdCompare(a.id, b.id);
    case "title":
      return byString(a.title, b.title);
    case "time_horizon":
      return (
        (TIME_HORIZON_ORDINALS[a.time_horizon] ?? 99) -
        (TIME_HORIZON_ORDINALS[b.time_horizon] ?? 99)
      );
    case "status":
      return (
        (THEME_STATUS_ORDINALS[a.status] ?? 99) -
        (THEME_STATUS_ORDINALS[b.status] ?? 99)
      );
    case "linked_tasks":
      return a.linked_tasks.length - b.linked_tasks.length;
    default:
      return 0;
  }
}

export function sortThemesForIndex<T extends SortableTheme>(
  themes: readonly T[],
  sort: SortState,
): T[] {
  if (sort.field === null || !THEME_SORT_FIELDS.has(sort.field)) {
    return [...themes];
  }
  const field = sort.field;
  const decorated = themes.map((theme, idx) => ({ theme, idx }));
  decorated.sort((a, b) => {
    const c = themeFieldCompare(field, a.theme, b.theme);
    if (c !== 0) return sort.dir === "desc" ? -c : c;
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.theme);
}
