import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard (JP-426): docs-site/public/openapi.yaml is a committed copy of
 * relay/docs/api/openapi.yaml, rendered by vitepress-openapi on the REST API
 * Reference page. If this fails, the spec changed without updating the copy —
 * run `cp relay/docs/api/openapi.yaml docs-site/public/openapi.yaml`.
 */
describe('docs-site OpenAPI spec copy', () => {
  it('matches relay/docs/api/openapi.yaml exactly', () => {
    const source = readFileSync(join(process.cwd(), 'relay/docs/api/openapi.yaml'), 'utf8');
    const copy = readFileSync(join(process.cwd(), 'docs-site/public/openapi.yaml'), 'utf8');
    expect(copy).toBe(source);
  });
});
