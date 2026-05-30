/**
 * record-view/backlog-references.ts — pure dangling-reference scan for
 * backlog deletion (backlog-ui-delete).
 *
 * The ledger schemas (backlog-schema.ts / roadmap-schema.ts) carry NO
 * referential-integrity constraint: `BacklogItem.dependencies[]` and
 * `RoadmapTheme.linked_backlog[]` are plain `z.array(z.string())`. So
 * deleting a backlog item can leave other items + roadmap themes
 * pointing at a now-missing id. This scan finds those references so the
 * delete-confirmation UX can warn the user before the orphaning happens.
 *
 * No React. No DOM. No I/O. Referentially transparent.
 */
import type { BacklogItem } from "@task-view/schemas/backlog";
import type { Roadmap, RoadmapTheme } from "@task-view/schemas/roadmap";

export interface BacklogReferences {
  /** Other backlog items whose `dependencies[]` include the target id. */
  dependents: BacklogItem[];
  /** Roadmap themes whose `linked_backlog[]` include the target id. */
  themes: RoadmapTheme[];
  /** True when any dependent or theme references the id. */
  hasReferences: boolean;
}

export interface BacklogReferenceSources {
  items: readonly BacklogItem[];
  /** The sibling roadmap, when one is threaded in. Optional / nullable. */
  roadmap?: Roadmap | null;
}

/**
 * Scan for references to a backlog id that deletion would orphan.
 *
 * The target id is never reported as its own dependent (a self-edge in
 * `dependencies[]` is dropped — deleting the record removes that edge too).
 * Declaration order is preserved for both lists.
 */
export function findBacklogReferences(
  id: string,
  sources: BacklogReferenceSources,
): BacklogReferences {
  const dependents = sources.items.filter(
    (entry) => entry.id !== id && entry.dependencies.includes(id),
  );

  const themes = (sources.roadmap?.themes ?? []).filter((theme) =>
    theme.linked_backlog.includes(id),
  );

  return {
    dependents,
    themes,
    hasReferences: dependents.length > 0 || themes.length > 0,
  };
}

/**
 * Build the human-readable confirmation prompt the delete-confirm dialog
 * shows before issuing the DELETE (backlog-ui-delete). Pure + tested so the
 * client DOM layer only has to drop the string into a `textContent` — no
 * message-construction logic in the untested DOM shell.
 *
 * The result is a plain string (no HTML markup) safe to assign to
 * `textContent`. When `refs.hasReferences` is true it names the orphaned
 * dependent item ids and/or roadmap theme ids so the user sees exactly what
 * the deletion would break (the schema does NOT enforce referential
 * integrity — deletion silently orphans these edges).
 */
export function buildDeleteConfirmMessage(
  id: string,
  refs: BacklogReferences,
): string {
  const lead = `Delete backlog item ${id}? This cannot be undone.`;
  if (!refs.hasReferences) return lead;

  const warnings: string[] = [];
  if (refs.dependents.length > 0) {
    const ids = refs.dependents.map((d) => d.id).join(", ");
    warnings.push(
      `${refs.dependents.length} other backlog ${
        refs.dependents.length === 1 ? "item depends" : "items depend"
      } on it (${ids})`,
    );
  }
  if (refs.themes.length > 0) {
    const ids = refs.themes.map((t) => t.id).join(", ");
    warnings.push(
      `${refs.themes.length} roadmap ${
        refs.themes.length === 1 ? "theme links" : "themes link"
      } to it (${ids})`,
    );
  }

  return `${lead} Warning: deleting it will orphan ${warnings.join(
    " and ",
  )}.`;
}
