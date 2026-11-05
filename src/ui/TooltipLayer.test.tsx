/**
 * Toolbar tooltips (DSK-217): when they show, what they say, and what puts them
 * away. The layer listens at the document, so the controls are plain buttons
 * carrying tip()'s attributes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { REST_MS, TooltipLayer, WARM_MS, tip } from './TooltipLayer';

function renderBar() {
  return render(
    <>
      <TooltipLayer />
      <button {...tip('Bold', 'Ctrl+B')}>B</button>
      <button {...tip('Italic', 'Ctrl+I')}>I</button>
      <button {...tip('Field', undefined, 'A value defined once and shown wherever you insert it.')}>F</button>
      <button {...tip('Colour')} aria-expanded="true">C</button>
      <button>Plain</button>
    </>,
  );
}

const tooltip = () => screen.queryByRole('tooltip');
const hover = (label: string, pointerType = 'mouse') => fireEvent.pointerOver(screen.getByText(label), { pointerType });
const leave = (label: string, to: Element | null = document.body) =>
  fireEvent.pointerOut(screen.getByText(label), { pointerType: 'mouse', relatedTarget: to });
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toolbar tooltips (DSK-217)', () => {
  it('shows the name and shortcut once the pointer rests on a control', () => {
    renderBar();
    hover('B');
    wait(REST_MS - 1);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()?.querySelector('.ds-tooltip__name')?.textContent).toBe('Bold');
    expect(tooltip()?.querySelector('kbd')?.textContent).toBe('Ctrl+B');
  });

  it('shows the next one at once while moving along the bar, and waits again after a pause', () => {
    renderBar();
    hover('B');
    wait(REST_MS);
    leave('B', screen.getByText('I'));
    hover('I');
    expect(tooltip()?.textContent).toContain('Italic');

    leave('I');
    wait(WARM_MS);
    hover('B');
    expect(tooltip()).toBeNull();
    wait(REST_MS);
    expect(tooltip()?.textContent).toContain('Bold');
  });

  it('says what a less familiar control does', () => {
    renderBar();
    hover('F');
    wait(REST_MS);
    expect(tooltip()?.querySelector('.ds-tooltip__description')?.textContent).toBe(
      'A value defined once and shown wherever you insert it.',
    );
  });

  it('leaving before the rest shows nothing, and a control without a tip shows nothing', () => {
    renderBar();
    hover('B');
    wait(REST_MS / 2);
    leave('B');
    wait(REST_MS);
    expect(tooltip()).toBeNull();
    hover('Plain');
    wait(REST_MS);
    expect(tooltip()).toBeNull();
  });

  it('never shows for touch', () => {
    renderBar();
    hover('B', 'touch');
    wait(REST_MS * 2);
    expect(tooltip()).toBeNull();
  });

  it('shows at once for keyboard focus, but not for the focus a click leaves', () => {
    renderBar();
    act(() => screen.getByText('I').focus());
    expect(tooltip()?.textContent).toContain('Italic');
    act(() => screen.getByText('Plain').focus());
    expect(tooltip()).toBeNull();

    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? false : matches.call(this, selector);
    });
    act(() => screen.getByText('B').focus());
    expect(tooltip()).toBeNull();
  });

  it('Escape, a press and scrolling put it away', () => {
    renderBar();
    hover('B');
    wait(REST_MS);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip()).toBeNull();

    hover('I');
    wait(REST_MS);
    fireEvent.pointerDown(screen.getByText('I'));
    expect(tooltip()).toBeNull();

    leave('I');
    wait(WARM_MS);
    hover('F');
    wait(REST_MS);
    fireEvent.scroll(window);
    expect(tooltip()).toBeNull();
  });

  it('keeps clear of a control whose menu is open', () => {
    renderBar();
    hover('C');
    wait(REST_MS);
    expect(tooltip()).toBeNull();
  });
});
