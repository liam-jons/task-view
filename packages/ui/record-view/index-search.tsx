/**
 * record-view/index-search.tsx — shared keyword-search box for the index
 * pages (task-list / roadmap / backlog). PRODUCT inv 23 (URL-reflected,
 * bookmarkable state) extended from filters to free-text search.
 *
 * A self-contained GET `<form>` so it works WITHOUT JS (degraded: a no-JS
 * submit drops sibling filter params); the SPA `wireIndexSearch` enhances it
 * to preserve every other URL param and navigate on change. The `<input>`
 * carries `data-search-control` so the client can find it regardless of which
 * surface rendered it.
 */
import React from "react";

export const IndexSearchBox: React.FC<{ q: string | null }> = ({ q }) => (
  <form className="record-view-index-search" data-index-search method="get">
    <label className="record-view-index-search-label">
      <span className="sr-only">Search</span>
      <input
        type="search"
        name="q"
        data-search-control
        defaultValue={q ?? ""}
        placeholder="Search…"
        aria-label="Search records"
      />
    </label>
    <noscript>
      <button type="submit">Search</button>
    </noscript>
  </form>
);
