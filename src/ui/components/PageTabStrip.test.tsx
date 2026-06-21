import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PageTabStrip, type PageTabStripItem } from './PageTabStrip';

const ITEMS: PageTabStripItem[] = [
  { id: 'a', label: 'Canvas' },
  { id: 'b', label: 'Canvas p.2' },
  { id: 'c', label: 'Canvas p.3' },
];

function renderStrip(onSelect = vi.fn()) {
  const utils = render(
    <PageTabStrip
      className="inline-page-tabs"
      ariaLabel="Canvas pages"
      items={ITEMS}
      activeId="a"
      onSelect={onSelect}
      renderTab={(item) => (
        <button key={item.id} data-page-id={item.id} className="inline-tab">
          {item.label}
        </button>
      )}
    />
  );
  return { ...utils, onSelect };
}

/**
 * jsdom doesn't lay out, so force the scroll element to report overflow by
 * stubbing scrollWidth/clientWidth on HTMLElement.
 */
function forceOverflow(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return this.classList.contains('page-tab-strip-scroll') ? scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('page-tab-strip-scroll') ? clientWidth : 0;
    },
  });
}

describe('PageTabStrip', () => {
  beforeEach(() => {
    // ResizeObserver isn't in jsdom; a no-op stub lets the effect attach.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error - reset the stubbed accessors
    delete HTMLElement.prototype.scrollWidth;
    // @ts-expect-error - reset the stubbed accessors
    delete HTMLElement.prototype.clientWidth;
  });

  it('renders all tabs', () => {
    renderStrip();
    expect(screen.getByText('Canvas')).toBeTruthy();
    expect(screen.getByText('Canvas p.3')).toBeTruthy();
  });

  it('shows no overflow affordance when everything fits', () => {
    forceOverflow(100, 400);
    renderStrip();
    expect(screen.queryByLabelText('All pages')).toBeNull();
  });

  it('reveals the ⋯ overflow button when tabs overflow', () => {
    forceOverflow(800, 200);
    renderStrip();
    expect(screen.getByLabelText('All pages')).toBeTruthy();
  });

  it('opens the page menu on hover and jumps on click', () => {
    forceOverflow(800, 200);
    const { onSelect } = renderStrip();
    const overflow = screen.getByLabelText('All pages').parentElement as HTMLElement;

    fireEvent.mouseEnter(overflow);
    // Every page is listed in the menu.
    const menuItems = screen.getAllByRole('menuitemradio');
    expect(menuItems).toHaveLength(3);

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Canvas p\.2/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});
