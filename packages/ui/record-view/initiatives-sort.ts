/**
 * record-view/initiatives-sort.ts — pure sort for the Initiatives index
 * page (ID-148.10, repurposed from roadmap-sort.ts). Mirrors
 * backlog-sort.ts: pure, deterministic, stable, no React/DOM/I/O.
 *
 * `sort.field === null` (or an unrecognised field) keeps the ledger's
 * natural (JSON array) order. Sortable columns: id (numeric), title
 * (alphabetic), status (INITIATIVE_STATUSES ordinal: proposed → planned →
 * active → completed → cancelled), project_count (recursive count across
 * the WHOLE sub-tree — INV-13, a top-level initiative's index row summarises
 * its nested projects too, not just its direct ones).
 */
import type { SortState } from "./url-state";

type SortableProjectHolder = {
  projects: readonly unknown[];
  "sub-initiatives": readonly SortableProjectHolder[];
};

type SortableInitiative = SortableProjectHolder & {
  id: string;
  title: string;
  status: string;
};

const INITIATIVE_STATUS_ORDINALS: Readonly<Record<string, number>> = {
  proposed: 0,
  planned: 1,
  active: 2,
  completed: 3,
  cancelled: 4,
};

const INITIATIVE_SORT_FIELDS = new Set<string>([
  "id",
  "title",
  "status",
  "project_count",
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

/** Recursive project count across the whole sub-tree (INV-13). */
export function totalProjectCount(node: SortableProjectHolder): number {
  let count = node.projects.length;
  for (const sub of node["sub-initiatives"]) {
    count += totalProjectCount(sub);
  }
  return count;
}

function initiativeFieldCompare(
  field: string,
  a: SortableInitiative,
  b: SortableInitiative,
): number {
  switch (field) {
    case "id":
      return numericIdCompare(a.id, b.id);
    case "title":
      return byString(a.title, b.title);
    case "status":
      return (
        (INITIATIVE_STATUS_ORDINALS[a.status] ?? 99) -
        (INITIATIVE_STATUS_ORDINALS[b.status] ?? 99)
      );
    case "project_count":
      return totalProjectCount(a) - totalProjectCount(b);
    default:
      return 0;
  }
}

export function sortInitiativesForIndex<T extends SortableInitiative>(
  initiatives: readonly T[],
  sort: SortState,
): T[] {
  if (sort.field === null || !INITIATIVE_SORT_FIELDS.has(sort.field)) {
    return [...initiatives];
  }
  const field = sort.field;
  const decorated = initiatives.map((initiative, idx) => ({ initiative, idx }));
  decorated.sort((a, b) => {
    const c = initiativeFieldCompare(field, a.initiative, b.initiative);
    if (c !== 0) return sort.dir === "desc" ? -c : c;
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.initiative);
}
