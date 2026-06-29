import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { FlyoutPanel } from './FlyoutPanel';
import { useSessionStore } from '../../store/sessionStore';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';

// Mirrors AUTO_COLLAPSE_DELAY_MS in FlyoutPanel.tsx.
const AUTO_COLLAPSE_DELAY_MS = 500;

function renderPanel(props: { showRail?: boolean } = {}) {
  return render(
    <FlyoutPanel
      panelId="properties"
      label="Properties"
      icon={<span>P</span>}
      expandOnSelection
      side="right"
      {...props}
    >
      <div data-testid="panel-body-content">body</div>
    </FlyoutPanel>
  );
}

beforeEach(() => {
  localStorage.clear();
  useUIPreferencesStore.getState().reset();
  useSessionStore.getState().clearSelection();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FlyoutPanel — Relaxed railless overlay (JP-410)', () => {
  it('railless overlay (showRail=false) hides the pin button', () => {
    // Relaxed Properties is a selection-driven overlay with no docked target, so
    // pinning was meaningless there — it only made Properties stick visible or
    // dismissed the panel. The pin control is hidden in that mode.
    useSessionStore.getState().select(['s1']);
    const { container } = renderPanel({ showRail: false });
    // expandOnSelection opened it on mount, so the body is present...
    expect(container.querySelector('.flyout-panel-body')).not.toBeNull();
    // ...but the pin button is not.
    expect(screen.queryByRole('button', { name: /pin properties open/i })).toBeNull();
  });

  it('rail fly-out (showRail=true) still shows the pin button', () => {
    useSessionStore.getState().select(['s1']);
    renderPanel({ showRail: true });
    expect(screen.queryByRole('button', { name: /pin properties open/i })).not.toBeNull();
  });

  it('railless overlay does not auto-collapse on mouse-leave (selection owns visibility)', () => {
    // The focus/hover auto-collapse must not fight the selection-driven overlay,
    // or editing one property (focus/pointer leaving the body) closes the panel
    // before the next edit. The mouse-leave path shares the same showRail guard
    // as the focus-out path.
    useSessionStore.getState().select(['s1']);
    const { container } = renderPanel({ showRail: false });
    const body = container.querySelector('.flyout-panel-body')!;
    vi.useFakeTimers();
    fireEvent.mouseLeave(body, { buttons: 0 });
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS + 100);
    });
    expect(container.querySelector('.flyout-panel-body')).not.toBeNull();
  });

  it('rail fly-out still auto-collapses on mouse-leave (Designer/Technician unchanged)', () => {
    useSessionStore.getState().select(['s1']);
    const { container } = renderPanel({ showRail: true });
    const body = container.querySelector('.flyout-panel-body')!;
    vi.useFakeTimers();
    fireEvent.mouseLeave(body, { buttons: 0 });
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS + 100);
    });
    expect(container.querySelector('.flyout-panel-body')).toBeNull();
  });
});

describe('FlyoutPanel — focus-out behavior (JP-410)', () => {
  it('railless overlay does not auto-collapse when focus leaves (edit then blur stays open)', () => {
    useSessionStore.getState().select(['s1']);
    const { container } = renderPanel({ showRail: false });
    const body = container.querySelector('.flyout-panel-body')!;
    vi.useFakeTimers();
    fireEvent.blur(body, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS + 100);
    });
    expect(container.querySelector('.flyout-panel-body')).not.toBeNull();
  });

  it('rail fly-out collapses when focus leaves entirely (Designer/Technician unchanged)', () => {
    useSessionStore.getState().select(['s1']);
    const { container } = renderPanel({ showRail: true });
    const body = container.querySelector('.flyout-panel-body')!;
    vi.useFakeTimers();
    fireEvent.blur(body, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS + 100);
    });
    expect(container.querySelector('.flyout-panel-body')).toBeNull();
  });
});
