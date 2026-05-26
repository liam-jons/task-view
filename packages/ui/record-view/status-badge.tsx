/**
 * record-view/status-badge.tsx — themed status / priority badges (OQ-4,
 * record-view-styling SPEC §6.6 SV-23/24).
 *
 * The per-record views + index tables render status / priority values
 * through these tiny components so the value reads as a themed pill with a
 * semantic colour cue (driven by the `data-status` / `data-priority` hook +
 * attribute selectors in record-view.css). The value TEXT still carries the
 * meaning, so colour is never the only signal (SV-44).
 *
 * `data-status` / `data-priority` carry the RAW canonical value (lower-snake
 * for status, e.g. `in_progress`) which the attribute selectors in
 * record-view.css match for the colour cue.
 *
 * IMPORTANT — the badge TEXT is the RAW value (NOT humanised). For editable
 * status rows the frontmatter card wraps the value in
 * `.record-view-field-value`, and the edit dispatcher pre-selects the enum
 * `<select>` by reading that span's `textContent` and matching it against an
 * `<option value="…">` (apps/server/web/index.tsx:readDisplayedValue +
 * buildEditForm). Humanising the text (`in_progress` → `in progress`) would
 * break that exact-match pre-select. So we keep the raw token as the visible
 * text; the data hook + CSS supply the visual polish.
 */
import React from "react";

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  return (
    <span className="record-view-status-badge" data-status={status}>
      {status}
    </span>
  );
};

export const PriorityBadge: React.FC<{ priority: string }> = ({ priority }) => {
  return (
    <span className="record-view-priority-badge" data-priority={priority}>
      {priority}
    </span>
  );
};
