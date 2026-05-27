/**
 * record-view/read-only-context.tsx — render-time read-only flag for the
 * cross-ledger nav surface ({20.29}, SPEC §3/§5 slice 6).
 *
 * When task-view serves a SIBLING ledger (a cross-ledger nav target), the
 * page is READ-ONLY: inv 43's contract is a single editable ledger per
 * launch, and the patch / create / delete / transaction endpoints all bind
 * `ctx.ledgerPath` with no sibling-write path. So sibling pages must surface
 * NO edit affordances.
 *
 * Rather than thread a `readOnly` prop through every view, frontmatter row,
 * and the FieldPencil, the flag rides a React context. `FieldPencil` (and
 * the Backlog index inline rank editor) read it and render nothing when
 * read-only, so NO `data-edit-*` hook reaches the served HTML — the
 * progressive-enhancement dispatcher then has nothing to attach to.
 *
 * Default is `false` (editable) so the launched-ledger path is unchanged
 * when no provider is mounted.
 */
import React from "react";

const ReadOnlyContext = React.createContext<boolean>(false);

/**
 * Provider mounted by `renderViewer` ONLY when rendering a sibling ledger
 * (read-only nav target). Wraps the whole record body so every descendant
 * edit affordance is suppressed.
 */
export const ReadOnlyProvider: React.FC<{
  readOnly: boolean;
  children: React.ReactNode;
}> = ({ readOnly, children }) => {
  return (
    <ReadOnlyContext.Provider value={readOnly}>
      {children}
    </ReadOnlyContext.Provider>
  );
};

/** True when the current render is a read-only sibling page. */
export function useReadOnly(): boolean {
  return React.useContext(ReadOnlyContext);
}
