import { render } from '@testing-library/react';
import { CapacityRing, toArcs, type CapacitySegment } from './CapacityRing';

const GB = 1024 * 1024 * 1024;

const seg = (key: string, bytes: number): CapacitySegment => ({ key, label: key, bytes });

/** Total arc length, i.e. where the ring's outer edge lands. */
const total = (arcs: { length: number }[]) => arcs.reduce((s, a) => s + a.length, 0);

describe('toArcs', () => {
  it('maps each share to its percentage of the quota', () => {
    const arcs = toArcs([seg('docs', 2 * GB), seg('files', 3 * GB)], 10 * GB);
    expect(arcs.map((a) => a.length)).toEqual([20, 30]);
  });

  it('leaves a zero share undrawn', () => {
    const arcs = toArcs([seg('docs', GB), seg('config', 0)], 10 * GB);
    expect(arcs.find((a) => a.key === 'config')!.length).toBe(0);
  });

  it('floors a tiny-but-nonzero share so it stays visible', () => {
    // 285 bytes against 20 GB is ~0.0000013% — invisible without the floor.
    const arcs = toArcs([seg('docs', 4 * GB), seg('config', 285)], 20 * GB);
    expect(arcs.find((a) => a.key === 'config')!.length).toBeGreaterThan(1);
  });

  it('pays for the floor out of the largest arc, so the edge stays honest', () => {
    const arcs = toArcs([seg('docs', 4 * GB), seg('config', 285)], 20 * GB);
    // True fill is 20% + a rounding crumb; the boosted config arc must not
    // push the ring past it.
    expect(total(arcs)).toBeCloseTo(20, 4);
  });

  it('keeps the borrowed length off the largest arc even when it is not first', () => {
    const arcs = toArcs([seg('config', 285), seg('docs', 4 * GB)], 20 * GB);
    expect(total(arcs)).toBeCloseTo(20, 4);
    expect(arcs.find((a) => a.key === 'config')!.length).toBeGreaterThan(1);
  });

  it('never draws past a full circle', () => {
    const arcs = toArcs([seg('docs', 30 * GB)], 10 * GB);
    expect(arcs[0]!.length).toBe(100);
  });

  it('keeps every share visible when they are all tiny', () => {
    // Nothing large enough to borrow from — the floor wins over the edge here,
    // which is the right trade at a near-empty workspace.
    const arcs = toArcs([seg('docs', 100), seg('files', 100), seg('config', 100)], 20 * GB);
    expect(arcs.every((a) => a.length >= 1)).toBe(true);
  });
});

describe('CapacityRing rendering', () => {
  const q = 20 * GB;

  it('draws one continuous arc when no share breakdown is supplied', () => {
    // The signed-out path (device storage) and any relay that predates the
    // share fields land here — it must still report the fill, not fall back to
    // a bare track that reads as "no data".
    const { container } = render(<CapacityRing used={5 * GB} quota={q} />);
    const arcs = container.querySelectorAll('.dh-ring-arc');
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.classList.contains('dh-ring-arc--all')).toBe(true);
    expect(arcs[0]!.getAttribute('stroke-dasharray')).toBe('25 100');
  });

  it('draws one arc per share when the breakdown is supplied', () => {
    const { container } = render(
      <CapacityRing
        used={5 * GB}
        quota={q}
        segments={[seg('docs', 3 * GB), seg('files', 2 * GB), seg('config', 0)]}
      />,
    );
    // config is zero, so it contributes no arc.
    expect(container.querySelectorAll('.dh-ring-arc')).toHaveLength(2);
    expect(container.querySelector('.dh-ring-centre')?.textContent).toBe('25%');
  });

  it('collapses to a single danger arc at cap, so "full" reads unambiguously', () => {
    const { container } = render(
      <CapacityRing
        used={q}
        quota={q}
        over
        segments={[seg('docs', 3 * GB), seg('files', 17 * GB)]}
      />,
    );
    expect(container.querySelectorAll('.dh-ring-arc')).toHaveLength(1);
    expect(container.querySelector('.dh-ring')?.classList.contains('dh-ring--over')).toBe(true);
  });

  it('draws no fill and says so when there is no quota to divide by', () => {
    const { container } = render(<CapacityRing used={5 * GB} quota={null} />);
    expect(container.querySelectorAll('.dh-ring-arc')).toHaveLength(0);
    expect(container.querySelector('.dh-ring-centre')?.textContent).toBe('—');
    expect(container.querySelector('.dh-ring')?.getAttribute('aria-label')).toMatch(
      /no allowance/i,
    );
  });

  it('reports a pending read rather than an empty one', () => {
    const { container } = render(<CapacityRing used={null} quota={null} pending />);
    expect(container.querySelector('.dh-ring-centre')?.textContent).toBe('···');
    expect(container.querySelector('.dh-ring')?.getAttribute('aria-label')).toMatch(
      /calculated/i,
    );
  });

  it('labels the fill for screen readers', () => {
    const { container } = render(<CapacityRing used={q / 4} quota={q} />);
    expect(container.querySelector('.dh-ring')?.getAttribute('aria-label')).toBe(
      'Storage 25 percent full',
    );
  });
});
