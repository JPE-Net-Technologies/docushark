/**
 * The ribbon's overflow (DSK-200): "…" shows while the tab's groups wrap below
 * the first row, and drops those rows down on a rest, a click or keyboard focus.
 * jsdom has no layout, so each element's box comes from its data-top.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, useRibbonOverflow, wrapsPastFirstRow } from './useRibbonOverflow';

function Ribbon({ secondRowTop = 40, tab = 'home' }: { secondRowTop?: number; tab?: string }) {
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
                <button data-top="0">Bold</button>
              </div>
              <div className="document-editor-toolbar-group" data-top={secondRowTop}>
                <button data-top={secondRowTop}>Align</button>
              </div>
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
    return { top, bottom: top + 32, height: 32, left: 0, right: 32, width: 32, x: 0, y: top, toJSON: () => ({}) };
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

  it('opens after the pointer rests on "…", and closes after it leaves the rows', () => {
    vi.useFakeTimers();
    renderRibbon();
    fireEvent.pointerOver(more(), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(HOVER_OPEN_MS - 1));
    expect(isOpen()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen()).toBe(true);

    // Into the rows: they stay open past the grace period.
    fireEvent.pointerOut(more(), { pointerType: 'mouse', relatedTarget: screen.getByText('Align') });
    fireEvent.pointerOver(screen.getByText('Align'), { pointerType: 'mouse', relatedTarget: more() });
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_MS * 2));
    expect(isOpen()).toBe(true);

    // Away from them: closed once the grace period ends.
    fireEvent.pointerOut(screen.getByText('Align'), { pointerType: 'mouse', relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_MS - 1));
    expect(isOpen()).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen()).toBe(false);
  });

  it('a click while hover-open pins it, so leaving no longer closes it', () => {
    vi.useFakeTimers();
    renderRibbon();
    fireEvent.pointerOver(more(), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(HOVER_OPEN_MS));
    fireEvent.click(more());
    fireEvent.pointerOut(more(), { pointerType: 'mouse', relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_MS * 2));
    expect(isOpen()).toBe(true);
  });

  it('ignores touch hover: a tap is a click', () => {
    vi.useFakeTimers();
    renderRibbon();
    fireEvent.pointerOver(more(), { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(HOVER_OPEN_MS * 2));
    expect(isOpen()).toBe(false);
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
