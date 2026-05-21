/**
 * InlineMarkdown — task-view inline-markdown rendering primitives.
 *
 * For ID-20.6 (fork prep) this file retains only the pure helpers that
 * have surviving inherited tests (`trimUrlTail`, exercised by
 * `InlineMarkdown.test.ts`). The full upstream Plannotator inline-markdown
 * React component was heavily coupled to annotation surfaces (CodeFilePicker,
 * CodePathValidationContext, ImageThumbnail, useValidatedCodePaths) that
 * the §1.2 strip ledger removed. The full inline-markdown component is
 * re-authored against task-view's read-mode rendering surface in ID-20.9
 * (PRODUCT inv 10 — CommonMark + GFM rendering floor).
 *
 * Helper API kept for the inherited test surface:
 *
 *   - `trimUrlTail(url: string): string`
 *
 * Helper API kept for downstream callers (parser-driven URL emission in
 * ID-20.9 will re-introduce a richer renderer):
 *
 *   - none yet (full surface re-introduced in 20.9).
 */

// Trim trailing sentence punctuation from a bare URL, but keep closing
// brackets when they balance an opener inside the URL (Wikipedia-style
// https://…/Function_(mathematics) should keep its closing paren).
export function trimUrlTail(url: string): string {
  const balanced = (u: string, close: string, open: string): boolean => {
    let opens = 0, closes = 0;
    for (const c of u) {
      if (c === open) opens++;
      else if (c === close) closes++;
    }
    return opens >= closes;
  };
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!/[.,;:!?)\]}>"']/.test(last)) break;
    if (last === ')' && balanced(url, ')', '(')) break;
    if (last === ']' && balanced(url, ']', '[')) break;
    if (last === '}' && balanced(url, '}', '{')) break;
    url = url.slice(0, -1);
  }
  return url;
}
