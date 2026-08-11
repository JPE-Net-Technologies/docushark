import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PropertySection } from './PropertySection';

afterEach(cleanup);

/**
 * JP-483. A collapsed section used to keep 16px of dead height. The cause is
 * subtle enough to be reintroduced by anyone tidying the CSS: the section
 * collapses via `grid-template-rows: 1fr → 0fr`, and a grid item's *padding*
 * is part of its min-content contribution, so it floors the flexible track.
 * `min-height: 0` zeroes only the content contribution, not the padding.
 *
 * jsdom performs no layout, so the height itself is not observable here.
 * These pin the two things that produce it instead: the wrapper element that
 * keeps the animating grid item padding-free, and the absence of padding on
 * that item in the stylesheet.
 */
describe('PropertySection collapse geometry', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/ui/PropertySection.css'), 'utf8');

  /** The declaration block for a top-level selector, without nested at-rules. */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `selector ${selector} not found`).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
  }

  it('renders children inside a padded wrapper, not the collapsing grid item', () => {
    const { container } = render(
      <PropertySection id="test-geometry" title="Geometry">
        <span>child control</span>
      </PropertySection>
    );

    const inner = container.querySelector('.property-section-content-inner');
    const body = container.querySelector('.property-section-body');
    expect(inner).not.toBeNull();
    expect(body).not.toBeNull();

    // The grid item must be the parent of the padded body, and the children
    // must sit inside the body — that nesting is what allows the 0fr row to
    // actually reach zero.
    expect(body!.parentElement).toBe(inner);
    expect(body!.contains(screen.getByText('child control'))).toBe(true);
  });

  it('keeps the collapsing grid item free of padding', () => {
    expect(ruleBody('.property-section-content-inner')).not.toMatch(/(^|[\s;])padding/);
  });

  it('puts the section padding on the wrapper instead', () => {
    expect(ruleBody('.property-section-body')).toMatch(/(^|[\s;])padding:/);
  });

  it('leaves the container unclipped so the sticky header keeps working', () => {
    // An overflow-clipping ancestor between a `position: sticky` header and its
    // scroll container disables sticky. The card rounds its corners on the
    // header/content instead of clipping the container.
    expect(ruleBody('.property-section-container')).not.toMatch(/overflow/);
  });
});
