import { describe, it, expect, vi } from 'vitest';

// Mock the icon catalog so the stencil path doesn't fetch real manifests in
// jsdom. cloud-aws yields a single Lambda icon; everything else is empty.
vi.mock('../../../store/iconLibraryStore', () => ({
  useIconLibraryStore: {
    getState: () => ({
      loadCategory: async () => {},
      getIconsByCategory: (cat: string) =>
        cat === 'cloud-aws'
          ? [{ id: 'builtin:aws-aws-lambda', name: 'AWS Lambda', type: 'builtin', category: 'cloud-aws' }]
          : [],
    }),
  },
}));

const { drawioAdapter } = await import('./drawioAdapter');

const scene = `<mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="2" parent="1" vertex="1" value="My Lambda"
    style="sketch=0;shape=mxgraph.aws4.lambda;fillColor=#ED7100;">
    <mxGeometry x="100" y="100" width="48" height="48" as="geometry"/>
  </mxCell>
  <mxCell id="3" parent="1" vertex="1" value="Mystery"
    style="shape=mxgraph.aws4.totally_made_up_service;">
    <mxGeometry x="200" y="100" width="48" height="48" as="geometry"/>
  </mxCell>
</root></mxGraphModel>`;

describe('drawioAdapter — stencil → icon resolution', () => {
  it('maps a matched stencil to an icon-in-container (no box chrome)', async () => {
    const { shapes } = await drawioAdapter.import(scene);
    const lambda = shapes.find((s) => (s as { label?: string }).label === 'My Lambda') as {
      iconId?: string;
      iconDisplayMode?: string;
      fill: string | null;
    };
    expect(lambda.iconId).toBe('builtin:aws-aws-lambda');
    expect(lambda.iconDisplayMode).toBe('icon-only');
    expect(lambda.fill).toBeNull();
  });

  it('falls back to a labelled box + warning when no icon matches', async () => {
    const { shapes, warnings } = await drawioAdapter.import(scene);
    const mystery = shapes.find((s) => (s as { label?: string }).label === 'Mystery') as {
      iconId?: string;
      type: string;
    };
    expect(mystery.type).toBe('rectangle');
    expect(mystery.iconId).toBeUndefined();
    expect(warnings?.find((w) => w.kind === 'stencil')?.count).toBe(1);
  });
});
