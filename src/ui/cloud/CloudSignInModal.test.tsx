// CloudSignInModal dismissal semantics (JP-420): a backdrop click must not
// cancel a pending device-code sign-in, while every EXPLICIT close path
// (Escape, the X button) keeps working. The blocked click is acknowledged with
// a card pulse + focus move instead of silence.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CloudSignInModal } from './CloudSignInModal';
import type { CloudConnectPanelProps } from './CloudConnectPanel';

// Stub the panel: a "Make busy" button drives onBusyChange like the real
// panel's device-code phases do, plus a stand-in for the awaiting Cancel
// button (the focus target of a blocked backdrop click).
vi.mock('./CloudConnectPanel', () => ({
  CloudConnectPanel: ({ onBusyChange }: CloudConnectPanelProps) => (
    <div>
      <button type="button" onClick={() => onBusyChange?.(true)}>
        Make busy
      </button>
      <div className="cloud-connect__device">
        <button type="button" className="cloud-connect__btn cloud-connect__btn--secondary">
          Cancel
        </button>
      </div>
    </div>
  ),
}));

afterEach(cleanup);

function renderModal() {
  const onClose = vi.fn();
  render(<CloudSignInModal onClose={onClose} />);
  const overlay = document.querySelector<HTMLElement>('.cloud-signin-overlay')!;
  return { onClose, overlay };
}

describe('CloudSignInModal', () => {
  it('backdrop mousedown dismisses when idle', () => {
    const { onClose, overlay } = renderModal();
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a mousedown that lands inside the card never dismisses', () => {
    const { onClose } = renderModal();
    fireEvent.mouseDown(screen.getByText('Make busy'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('backdrop mousedown is blocked while the panel reports busy — pulses and focuses Cancel', () => {
    const { onClose, overlay } = renderModal();
    fireEvent.click(screen.getByText('Make busy'));

    fireEvent.mouseDown(overlay);

    expect(onClose).not.toHaveBeenCalled();
    const card = document.querySelector('.cloud-signin-modal')!;
    expect(card.className).toContain('cloud-signin-modal--pulse');
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
  });

  it('the pulse class clears on animation end so it can re-trigger', () => {
    const { overlay } = renderModal();
    fireEvent.click(screen.getByText('Make busy'));
    fireEvent.mouseDown(overlay);

    const card = document.querySelector('.cloud-signin-modal')!;
    fireEvent.animationEnd(card);
    expect(card.className).not.toContain('cloud-signin-modal--pulse');
  });

  it('Escape closes even while busy (explicit intent)', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText('Make busy'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the X button closes even while busy (explicit intent)', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText('Make busy'));
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
