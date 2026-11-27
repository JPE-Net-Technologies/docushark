import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard (DSK-254): the Build section's App Token Format page
 * (docs-site/developer/token-format.md) is a copy of the relay's own reference,
 * relay/docs/api/token-format.md, which the relay's auth code cites as its
 * source of truth. The copy differs only in its front matter and in linking
 * `revocation.md` to the Build section's Token Revocation page.
 *
 * Before this guard the two had drifted apart: the copy described quotas and
 * the storage response differently from the relay. If this fails, the relay's
 * reference changed: copy it over again (front matter kept, link rewritten).
 */
describe('token format docs copy', () => {
  const root = process.cwd();
  const source = readFileSync(join(root, 'relay/docs/api/token-format.md'), 'utf8');
  const copy = readFileSync(join(root, 'docs-site/developer/token-format.md'), 'utf8');

  it('keeps its front matter', () => {
    expect(copy).toMatch(/^---\ntitle: App Token Format\n/);
  });

  it('matches the relay reference apart from the revocation link', () => {
    const body = copy.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    const expected = source.replaceAll('`revocation.md`', '[Token Revocation](./revocation)');
    expect(body).toBe(expected);
  });
});
