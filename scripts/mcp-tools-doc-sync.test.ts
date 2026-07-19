import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard (JP-449): every MCP tool the relay advertises via `tools/list`
 * (the `name: "docushark_…"` entries in relay/src/mcp/tools.rs) must be
 * documented on the Build section's MCP Tool Reference page
 * (docs-site/developer/mcp-tools.md).
 *
 * This is the code-pinned complement to the OpenAPI spec-sync guard: it catches
 * a tool added to the relay without a matching docs row — the exact drift the
 * 2026-07 developer-docs audit found (nine undocumented tools). Pinning to the
 * code (not relay/docs/) keeps it independent of where the relay's own markdown
 * reference lives.
 *
 * If this fails, add the missing tool(s) to docs-site/developer/mcp-tools.md
 * (resync from relay/docs/mcp/README.md, the authoritative tool reference).
 */
describe('MCP tool docs coverage', () => {
  const root = process.cwd();
  const toolsRs = readFileSync(join(root, 'relay/src/mcp/tools.rs'), 'utf8');
  const doc = readFileSync(join(root, 'docs-site/developer/mcp-tools.md'), 'utf8');

  // Tool names come from the `tools/list` builder: `name: "docushark_<x>"`.
  const names = [...toolsRs.matchAll(/name:\s*"docushark_([a-z_]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(names)].sort();

  it('extracts a plausible tool set from the relay source', () => {
    // Guards against a declaration-style refactor silently matching nothing
    // (which would make the per-tool checks below vacuously pass).
    expect(unique.length).toBeGreaterThan(30);
  });

  it.each(unique)('documents docushark_%s on the MCP Tool Reference page', (tool) => {
    expect(doc.includes('`' + tool + '`')).toBe(true);
  });
});
