import { describe, it, expect, vi, afterEach } from 'vitest';
import { getCategoryLoader } from './index';

/** Build a Response-like stub for the mocked fetch. */
function resp(body: string, init: { ok?: boolean; status?: number; contentType?: string } = {}) {
  const { ok = true, status = 200, contentType = 'application/json' } = init;
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  } as unknown as Response;
}

describe('cloud icon manifest loader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the manifest under the app base href and prefixes asset paths', async () => {
    const fetchMock = vi.fn(async () =>
      resp(JSON.stringify([{ id: 'builtin:aws-x', name: 'X', file: 'x.svg' }]))
    );
    vi.stubGlobal('fetch', fetchMock);

    const loader = getCategoryLoader('cloud-aws');
    expect(loader).toBeDefined();
    const icons = await loader!.load();

    // BASE_URL is '/' in test → fetch hits /icons/aws-manifest.json.
    expect(fetchMock).toHaveBeenCalledWith('/icons/aws-manifest.json');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toMatchObject({
      id: 'builtin:aws-x',
      name: 'X',
      category: 'cloud-aws',
      assetPath: '/icons/aws/x.svg',
      multiColor: true,
    });
  });

  it('throws a precise error when the manifest fetch returns HTML (404 / SW fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp('<!DOCTYPE html><html><body>not found</body></html>', { contentType: 'text/html' }))
    );

    const loader = getCategoryLoader('cloud-azure');
    await expect(loader!.load()).rejects.toThrow(/returned HTML, not JSON/);
  });

  it('detects an HTML body even when the content-type lies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp('  <!DOCTYPE html><html></html>', { contentType: 'application/json' }))
    );

    const loader = getCategoryLoader('cloud-gcp');
    await expect(loader!.load()).rejects.toThrow(/returned HTML, not JSON/);
  });

  it('throws on a non-ok manifest response with the status code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp('', { ok: false, status: 404 })));

    const loader = getCategoryLoader('cloud-aws');
    await expect(loader!.load()).rejects.toThrow(/Failed to load icon manifest \(404\)/);
  });
});
