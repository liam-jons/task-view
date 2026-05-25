/**
 * render-viewer.test.tsx — ID-20.24 script-injection contract for the
 * SSR viewer (pure; no Bun.build).
 *
 * renderViewer optionally inlines a client-bundle <script>; when omitted
 * the page is read-only SSR (fully usable without JS). Verifies the
 * script lands at the end of <body> and that </script> sequences are
 * neutralised so a bundle string can never break out of the element.
 */
import { describe, expect, test } from "bun:test";
import { renderViewer } from "./render-viewer";
import type { KnownDetected } from "./render-viewer";

const BACKLOG_DETECTED: KnownDetected = {
  kind: "backlog",
  data: {
    document_name: "Product Backlog",
    document_purpose: "fixture",
    related_documents: [],
    items: [
      {
        id: "ID-30",
        description: "An item",
        type: "feature",
        status: "ready",
        priority: "high",
        rank: 3,
        track: "platform",
        effort_estimate: "M",
      },
    ],
  },
} as unknown as KnownDetected;

describe("renderViewer — client-script injection (ID-20.24)", () => {
  test("no clientScript → no <script> emitted (read-only SSR)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-record-kind="backlog-index"');
    expect(html).not.toContain("<script");
  });

  test("clientScript present → inline module <script> at end of body", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      clientScript: "console.log('hydrate');",
    });
    expect(html).toContain('<script type="module">console.log');
    const scriptIdx = html.indexOf("<script");
    const bodyCloseIdx = html.indexOf("</body>");
    const markupIdx = html.indexOf('data-record-kind="backlog-index"');
    // Script sits after the markup but before </body>.
    expect(scriptIdx).toBeGreaterThan(markupIdx);
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  test("</script> inside the bundle is neutralised (no breakout)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      clientScript: 'const x = "</script>";',
    });
    // The literal closing tag from the bundle is escaped; the only real
    // </script> is the one wrapHtml emits.
    expect(html).toContain("<\\/script>");
    expect(html.match(/<\/script>/g)?.length).toBe(1);
  });

  test("empty clientScript string → treated as absent (no script tag)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      clientScript: "",
    });
    expect(html).not.toContain("<script");
  });
});
