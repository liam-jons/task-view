/**
 * record-view/backlog-references.ts — pure dangling-reference scan for
 * backlog deletion (backlog-ui-delete).
 *
 * The ledger schemas (backlog-schema.ts / initiatives-schema.ts) carry NO
 * referential-integrity constraint: `BacklogItem.dependencies[]` and
 * `Project.linked_backlog[]` are plain `z.array(z.string())`. So deleting a
 * backlog item can leave other items + initiatives projects pointing at a
 * now-missing id. This scan finds those references so the
 * delete-confirmation UX can warn the user before the orphaning happens.
 *
 * ID-148.10 (repurposed roadmap arm, INV-6 "links are project-only"): the
 * reference scan now walks the WHOLE initiatives tree (a project may live
 * at any depth under `initiatives[]`/`sub-initiatives[]`) rather than a
 * single flat `themes[]` array.
 *
 * No React. No DOM. No I/O. Referentially transparent.
 */
import type { BacklogItem } from "@task-view/schemas/backlog";
import type {
  InitiativesDocument,
  Initiative,
  SubInitiative,
  Project,
} from "@task-view/schemas/initiatives";

export interface BacklogReferences {
  /** Other backlog items whose `dependencies[]` include the target id. */
  dependents: BacklogItem[];
  /** Initiatives projects (any depth) whose `linked_backlog[]` include the
   * target id. */
  projects: Project[];
  /** True when any dependent or project references the id. */
  hasReferences: boolean;
}

export interface BacklogReferenceSources {
  items: readonly BacklogItem[];
  /** The sibling initiatives document, when one is threaded in. Optional /
   * nullable. */
  initiatives?: InitiativesDocument | null;
}

/** Flatten every project in the tree (depth-first) — INV-13. */
function allProjects(
  nodes: readonly (Initiative | SubInitiative)[],
): Project[] {
  const out: Project[] = [];
  for (const node of nodes) {
    out.push(...node.projects);
    out.push(...allProjects(node["sub-initiatives"]));
  }
  return out;
}

/**
 * Scan for references to a backlog id that deletion would orphan.
 *
 * The target id is never reported as its own dependent (a self-edge in
 * `dependencies[]` is dropped — deleting the record removes that edge too).
 * Declaration order is preserved for both lists (projects: depth-first tree
 * order).
 */
export function findBacklogReferences(
  id: string,
  sources: BacklogReferenceSources,
): BacklogReferences {
  const dependents = sources.items.filter(
    (entry) => entry.id !== id && entry.dependencies.includes(id),
  );

  const projects = allProjects(sources.initiatives?.initiatives ?? []).filter(
    (project) => project.linked_backlog.includes(id),
  );

  return {
    dependents,
    projects,
    hasReferences: dependents.length > 0 || projects.length > 0,
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
 * dependent item ids and/or project slugs so the user sees exactly what the
 * deletion would break (the schema does NOT enforce referential integrity —
 * deletion silently orphans these edges).
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
  if (refs.projects.length > 0) {
    const ids = refs.projects.map((p) => p.id).join(", ");
    warnings.push(
      `${refs.projects.length} ${
        refs.projects.length === 1 ? "project links" : "projects link"
      } to it (${ids})`,
    );
  }

  return `${lead} Warning: deleting it will orphan ${warnings.join(
    " and ",
  )}.`;
}
