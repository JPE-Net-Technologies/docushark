/**
 * The ribbon's overflow (DSK-200): "…" shows while the tab's groups wrap below
 * the first row, and drops those rows down on a click or keyboard focus, never on
 * a pointer passing over it. It marks the folded groups, and flags "…" while a
 * folded control applies to the selection.
 * jsdom has no layout, so each element's box comes from its data-top and data-left.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useRibbonOverflow, wrapsPastFirstRow } from './useRibbonOverflow';

function Ribbon({
  secondRowTop = 40,
  tab = 'home',
  thirdGroup = false,
  activeButton = null,
}: {
  secondRowTop?: number;
  tab?: string;
  /** A second folded group, further along the same folded row. */
  thirdGroup?: boolean;
  /** Which button shows as active, as a toolbar button applying to the selection does. */
  activeButton?: 'Bold' | 'Align' | null;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const overflow = useRibbonOverflow(stripRef, toolbarRef, tab);
  return (
    <>
      <div ref={toolbarRef}>
        <div data-testid="strip" data-open={overflow.open || undefined}>
          <div ref={stripRef} {...overflow.stripProps}>
            <div>
              <div className="document-editor-toolbar-group" data-top="0">
                <button data-top="0" className={`document-editor-toolbar-btn${activeButton === 'Bold' ? ' active' : ''}`}>Bold</button>
              </div>
              <div className="document-editor-toolbar-group" data-top={secondRowTop} data-testid="align-group">
                <button data-top={secondRowTop} className={`document-editor-toolbar-btn${activeButton === 'Align' ? ' active' : ''}`}>Align</button>
              </div>
              {thirdGroup && (
                <div className="document-editor-toolbar-group" data-top={secondRowTop} data-left="100" data-testid="third-group">
                  <button data-top={secondRowTop} data-left="100">Aa</button>
                </div>
              )}
            </div>
          </div>
        </div>
        <button data-testid="more" data-shown={overflow.overflowing || undefined} {...overflow.moreProps}>
          …
        </button>
        <button>Find</button>
      </div>
      <button>Canvas</button>
    </>
  );
}

const more = () => screen.getByTestId('more');
const isOpen = () => screen.getByTestId('strip').hasAttribute('data-open');

/** Render inside an app root, as the ribbon is; menus and dialogs portal outside it. */
function renderRibbon(props: Parameters<typeof Ribbon>[0] = {}) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return render(<Ribbon {...props} />, { container: root });
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = Number((this as HTMLElement).dataset['top'] ?? 0);
    const left = Number((this as HTMLElement).dataset['left'] ?? 0);
    return { top, bottom: top + 32, height: 32, left, right: left + 32, width: 32, x: left, y: top, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useRibbonOverflow (DSK-200)', () => {
  it('shows "…" only while a group wraps below the first row', () => {
    renderRibbon({ secondRowTop: 0 });
    expect(more().hasAttribute('data-shown')).toBe(false);
    cleanup();
    renderRibbon({ secondRowTop: 40 });
    expect(more().hasAttribute('data-shown')).toBe(true);
  });

  it('measures only groups that are laid out (a hidden tab has no size)', () => {
    const strip = document.createElement('div');
    strip.innerHTML =
      '<div class="document-editor-toolbar-group" data-top="0"></div>' +
      '<div class="document-editor-toolbar-group" data-top="40"></div>';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = Number((this as HTMLElement).dataset['top'] ?? 0);
      const height = top === 40 ? 0 : 32;
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) };
    });
    expect(wrapsPastFirstRow(strip)).toBe(false);
  });

  it('a click pins the rows open, and a second click closes them', () => {
    renderRibbon();
    fireEvent.click(more());
    expect(isOpen()).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(more());
    expect(isOpen()).toBe(false);
  });

  it('opens on a click only: passing over "…" on the way to Find opens nothing', () => {
    vi.useFakeTimers();
    renderRibbon();
    for (const pointerType of ['mouse', 'pen', 'touch']) {
      fireEvent.pointerOver(more(), { pointerType });
      fireEvent.pointerEnter(more(), { pointerType });
      act(() => vi.advanceTimersByTime(2000));
      expect(isOpen()).toBe(false);
      fireEvent.pointerOut(more(), { pointerType, relatedTarget: screen.getByText('Find') });
    }
    fireEvent.click(more());
    expect(isOpen()).toBe(true);
  });

  it('marks the groups that folded, and the one each folded row starts with', () => {
    renderRibbon({ thirdGroup: true });
    const first = screen.getByText('Bold').parentElement!;
    expect(first.hasAttribute('data-folded')).toBe(false);
    expect(screen.getByTestId('align-group').hasAttribute('data-folded')).toBe(true);
    expect(screen.getByTestId('align-group').hasAttribute('data-row-start')).toBe(true);
    expect(screen.getByTestId('third-group').hasAttribute('data-folded')).toBe(true);
    expect(screen.getByTestId('third-group').hasAttribute('data-row-start')).toBe(false);
  });

  it('flags "…" while a folded control applies to the selection, following it without a resize', () => {
    const view = renderRibbon();
    expect(more().hasAttribute('data-active-hidden')).toBe(false);
    view.rerender(<Ribbon activeButton="Align" />);
    expect(more().hasAttribute('data-active-hidden')).toBe(true);
    // An active control still in sight needs no flag.
    view.rerender(<Ribbon activeButton="Bold" />);
    expect(more().hasAttribute('data-active-hidden')).toBe(false);
  });

  it('never flags "…" while nothing has folded', () => {
    renderRibbon({ secondRowTop: 0, activeButton: 'Align' });
    expect(more().hasAttribute('data-active-hidden')).toBe(false);
  });

  it('closes on Escape, moving focus off a control about to be clipped', () => {
    renderRibbon();
    fireEvent.click(more());
    act(() => screen.getByText('Align').focus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(more());
  });

  it('closes on a press elsewhere in the app, but not in the ribbon or a portalled menu', () => {
    renderRibbon();
    fireEvent.click(more());

    fireEvent.pointerDown(screen.getByText('Find'));
    expect(isOpen()).toBe(true);

    const menu = document.createElement('div');
    document.body.appendChild(menu);
    fireEvent.pointerDown(menu);
    expect(isOpen()).toBe(true);

    fireEvent.pointerDown(screen.getByText('Canvas'));
    expect(isOpen()).toBe(false);
  });

  it('opens when keyboard focus reaches a hidden control, and closes when focus leaves the ribbon', () => {
    renderRibbon();
    fireEvent.focus(screen.getByText('Bold'));
    expect(isOpen()).toBe(false);

    act(() => screen.getByText('Align').focus());
    expect(isOpen()).toBe(true);

    act(() => screen.getByText('Find').focus());
    expect(isOpen()).toBe(true);
    act(() => screen.getByText('Canvas').focus());
    expect(isOpen()).toBe(false);
  });

  it('closes when the tab changes', () => {
    const { rerender } = renderRibbon();
    fireEvent.click(more());
    rerender(<Ribbon tab="insert" />);
    expect(isOpen()).toBe(false);
  });
});
