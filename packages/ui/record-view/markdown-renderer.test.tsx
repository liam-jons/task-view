/**
 * markdown-renderer.test.tsx — verifies the journal-block split helper
 * used by Subtask.details rendering (PRODUCT inv 8 last bullet).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DetailsBodyWithJournal,
  MarkdownBody,
  splitDetailsByJournal,
} from "./markdown-renderer";

describe("splitDetailsByJournal", () => {
  test("returns a single prose segment when no journal block is present", () => {
    const segs = splitDetailsByJournal("Some plain prose.");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("prose");
    expect(segs[0].text).toBe("Some plain prose.");
  });

  test("splits a single journal block from surrounding prose", () => {
    const input =
      "Pre-journal prose.\n\n<info added on 2026-05-21T15:00:00.000Z>\nShipped X.\n</info added on 2026-05-21T15:00:00.000Z>\n\nPost-journal prose.";
    const segs = splitDetailsByJournal(input);
    expect(segs).toHaveLength(3);
    expect(segs[0].kind).toBe("prose");
    expect(segs[0].text).toContain("Pre-journal");
    expect(segs[1].kind).toBe("journal");
    expect(segs[1].timestamp).toBe("2026-05-21T15:00:00.000Z");
    expect(segs[1].text).toContain("Shipped X");
    expect(segs[2].kind).toBe("prose");
    expect(segs[2].text).toContain("Post-journal");
  });

  test("handles multiple journal blocks in sequence", () => {
    const input =
      "<info added on 2026-05-21T15:00:00.000Z>\nFirst.\n</info added on 2026-05-21T15:00:00.000Z>\n<info added on 2026-05-21T16:00:00.000Z>\nSecond.\n</info added on 2026-05-21T16:00:00.000Z>";
    const segs = splitDetailsByJournal(input);
    const journals = segs.filter((s) => s.kind === "journal");
    expect(journals).toHaveLength(2);
    expect(journals[0].timestamp).toBe("2026-05-21T15:00:00.000Z");
    expect(journals[1].timestamp).toBe("2026-05-21T16:00:00.000Z");
  });

  test("preserves orphan open tag as prose when no matching close exists", () => {
    const input =
      "Pre.\n<info added on 2026-05-21T15:00:00.000Z>\nDangling open with no close.";
    const segs = splitDetailsByJournal(input);
    expect(segs.every((s) => s.kind === "prose")).toBe(true);
    // Combined prose should contain the whole input
    const combined = segs.map((s) => s.text).join("");
    expect(combined).toContain("Pre.");
    expect(combined).toContain("<info added on 2026-05-21T15:00:00.000Z>");
    expect(combined).toContain("Dangling open");
  });
});

describe("DetailsBodyWithJournal (PRODUCT inv 8 last bullet)", () => {
  test("renders prose + journal segments with distinct CSS hooks", () => {
    const input =
      "Pre-journal.\n\n<info added on 2026-05-21T15:00:00.000Z>\nJournal entry.\n</info added on 2026-05-21T15:00:00.000Z>";
    const html = renderToStaticMarkup(
      <DetailsBodyWithJournal details={input} />,
    );
    expect(html).toContain('data-segment="prose"');
    expect(html).toContain('data-segment="journal"');
    expect(html).toContain('data-journal-timestamp="2026-05-21T15:00:00.000Z"');
    expect(html).toContain("Pre-journal");
    expect(html).toContain("Journal entry");
    // The "Journal" label is visible per the inv 8 acceptance
    expect(html).toContain("Journal");
  });

  test("renders pure prose when no journal block is present", () => {
    const html = renderToStaticMarkup(
      <DetailsBodyWithJournal details={"Plain text only."} />,
    );
    expect(html).toContain("Plain text only");
    expect(html).toContain('data-segment="prose"');
    expect(html).not.toContain('data-segment="journal"');
  });
});

describe("MarkdownBody", () => {
  test("wraps markdown in a data-markdown-body container", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody markdown={"# Hello\n\nWorld."} />,
    );
    expect(html).toContain("data-markdown-body");
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  // ── S64 W1 carryforward (Finding-4): MarkdownBody CommonMark rewire ─────
  // Per task-executor brief: "Make sure pipe-formatted tables, code blocks,
  // inline emphasis all render correctly."

  test("renders headings via the BlockRenderer pipeline (no <pre> placeholder)", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody markdown={"# Top heading\n\n## Sub heading"} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Top heading");
    expect(html).toContain("<h2");
    expect(html).toContain("Sub heading");
    // The old `<pre>` placeholder MUST be gone.
    expect(html).not.toContain('<pre class="record-view-markdown-raw">');
  });

  test("renders inline emphasis — bold + italic + code spans", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody
        markdown={"This is **bold**, this is *italic*, this is `code`."}
      />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  test("renders pipe-formatted tables via TableBlock", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody
        markdown={
          "| col1 | col2 |\n| --- | --- |\n| val1 | val2 |\n| val3 | val4 |"
        }
      />,
    );
    // Table cells should appear inside table markup
    expect(html).toContain("<table");
    expect(html).toContain("col1");
    expect(html).toContain("val1");
    expect(html).toContain("val4");
  });

  test("renders fenced code blocks via CodeBlock", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody
        markdown={"```ts\nconst x = 42;\nconsole.log(x);\n```"}
      />,
    );
    // CodeBlock renders the body — content must survive
    expect(html).toContain("const x = 42");
    expect(html).toContain("console.log(x)");
  });

  test("renders unordered list items", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody markdown={"- alpha\n- beta\n- gamma"} />,
    );
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("gamma");
    expect(html).toContain('data-render-group="list"');
  });

  test("renders inline links as <a> elements", () => {
    const html = renderToStaticMarkup(
      <MarkdownBody markdown={"See [docs](https://example.com/x)."} />,
    );
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain("docs</a>");
  });
});
