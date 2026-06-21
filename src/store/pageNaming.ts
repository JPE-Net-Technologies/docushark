/**
 * Default page-name generation, shared by the canvas page store
 * ({@link ./pageStore}) and the prose page store ({@link ./richTextPagesStore}).
 *
 * The two strips were previously both seeded with `Page N`, which made prose and
 * canvas pages indistinguishable and — because the number was derived from the
 * page count — produced duplicate names after a middle delete. We instead name
 * the first page with a bare type base (`Canvas` / `Prose`) and increment
 * subsequent pages monotonically (`Canvas p.2`, `Prose p.3`, …).
 *
 * A twin of {@link nextDefaultPageName} lives relay-side in
 * `relay/src/mcp/tools.rs` so MCP-created pages follow the same scheme; keep the
 * two in sync.
 */

/** Type base for canvas (diagram) pages. */
export const CANVAS_PAGE_BASE = 'Canvas';
/** Type base for prose (rich-text) pages. */
export const PROSE_PAGE_BASE = 'Prose';

/**
 * Returns the next default page name for a given type `base`.
 *
 * - The first page (no existing base-pattern names) gets the bare `base`.
 * - Subsequent pages get `${base} p.${n}`, where `n` is **monotonic max+1**:
 *   the highest existing suffix plus one (the bare `base` counts as `p.1`). The
 *   number is never reused, so a deleted label can't resurface — gaps are
 *   expected and fine.
 *
 * Parses with `startsWith`/`Number` (no regex needed — bases are constants).
 */
export function nextDefaultPageName(base: string, existingNames: Iterable<string>): string {
  const prefix = `${base} p.`;
  let max = 0;
  let sawBase = false;
  for (const name of existingNames) {
    if (name === base) {
      sawBase = true;
      max = Math.max(max, 1);
      continue;
    }
    if (name.startsWith(prefix)) {
      const n = Number(name.slice(prefix.length));
      if (Number.isInteger(n) && n > 0) max = Math.max(max, n);
    }
  }
  if (max === 0 && !sawBase) return base; // first page → bare base
  return `${base} p.${max + 1}`;
}
