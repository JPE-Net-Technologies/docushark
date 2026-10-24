/**
 * MobileSheet's bottom placement (DSK-196): an action sheet that a swipe down
 * on its header dismisses, and that a tap's jitter doesn't.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MobileSheet } from './MobileSheet';

function renderSheet(onClose = vi.fn(), onBack?: () => void) {
  render(
    <MobileSheet placement="bottom" title="Specs" subtitle="Collection" onClose={onClose} onBack={onBack}>
      <button type="button">Rename…</button>
    </MobileSheet>,
  );
  const header = document.querySelector('.mobile-sheet-header--bottom') as HTMLElement;
  return { onClose, header };
}

function drag(target: HTMLElement, fromY: number, toY: number) {
  fireEvent.pointerDown(target, { pointerId: 1, clientY: fromY, button: 0, pointerType: 'touch' });
  fireEvent.pointerMove(target, { pointerId: 1, clientY: toY, pointerType: 'touch' });
  fireEvent.pointerUp(target, { pointerId: 1, clientY: toY, pointerType: 'touch' });
}

describe('MobileSheet — bottom placement (DSK-196)', () => {
  beforeEach(() => cleanup());

  it('is a labelled modal dialog that takes focus', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'Specs' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByText('Collection')).toBeTruthy();
  });

  it('dismisses on a swipe down the header', () => {
    const { onClose, header } = renderSheet();
    drag(header, 100, 220);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back from a short drag instead of dismissing', () => {
    const { onClose, header } = renderSheet();
    drag(header, 100, 108);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Specs' }).style.transform).toBe('');
  });

  it('ignores an upward drag', () => {
    const { onClose, header } = renderSheet();
    drag(header, 300, 120);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the header’s buttons their own taps', () => {
    const onBack = vi.fn();
    const { onClose } = renderSheet(vi.fn(), onBack);
    const back = screen.getByRole('button', { name: 'Back' });
    drag(back, 100, 220);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the scrim and Escape', () => {
    const { onClose } = renderSheet();
    fireEvent.click(document.querySelector('.mobile-sheet-scrim') as Element);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
