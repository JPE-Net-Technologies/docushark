/**
 * Bar first (DSK-225): with the selection bar on, a selection shows the bar, More
 * opens the panel, and it follows the selection until dismissed. With the bar off,
 * every selection opens the panel, as it always did. The real fly-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { FlyoutPanel } from '../layout/FlyoutPanel';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePropertiesOnSelection } from './usePropertiesOnSelection';

function Panel({ showRail }: { showRail: boolean }) {
  const { followsSelection, onDismiss } = usePropertiesOnSelection();
  return (
    <FlyoutPanel
      panelId="properties"
      label="Properties"
      icon={<span />}
      expandOnSelection={followsSelection}
      onDismiss={onDismiss}
      side="right"
      showRail={showRail}
    >
      <div>The panel</div>
    </FlyoutPanel>
  );
}

const panel = () => screen.queryByText('The panel');
const close = () => screen.queryByRole('button', { name: 'Close Properties' });
const select = (...ids: string[]) => act(() => useSessionStore.getState().select(ids));
const deselect = () => act(() => useSessionStore.getState().clearSelection());
const more = () => act(() => useSessionStore.getState().setPropertiesRequested(true));
const requested = () => useSessionStore.getState().propertiesRequested;
const settle = () => act(() => vi.advanceTimersByTime(1000));

beforeEach(() => {
  vi.useFakeTimers();
  act(() => {
    useSessionStore.getState().clearSelection();
    useSessionStore.setState({ propertiesRequested: false });
  });
  useSettingsStore.setState({ showSelectionBar: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each([
  ['the railless overlay', false],
  ['the rail', true],
])('bar first, with %s', (_name, showRail) => {
  it('does not open for a selection', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    expect(panel()).toBeNull();
  });

  it('opens when More asks', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    expect(panel()).not.toBeNull();
  });

  it('stays open from one selection to the next', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    select('b');
    settle();
    expect(panel()).not.toBeNull();
    expect(requested()).toBe(true);
  });

  it('comes back for the next selection after the selection ends', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    deselect();
    settle();
    expect(panel()).toBeNull();
    expect(requested()).toBe(true);
    select('b');
    expect(panel()).not.toBeNull();
  });

  it('closes from its button, and stays closed', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    fireEvent.click(close()!);
    expect(panel()).toBeNull();
    expect(requested()).toBe(false);
    select('b');
    expect(panel()).toBeNull();
  });

  it('closes on Escape, and stays closed', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(requested()).toBe(false);
  });

  it('counts Escape as closing it even if it clears the selection too', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    act(() => {
      useSessionStore.getState().clearSelection();
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(requested()).toBe(false);
  });

  it('closes when More is pressed again', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    act(() => useSessionStore.getState().setPropertiesRequested(false));
    expect(panel()).toBeNull();
  });

  it('survives a press elsewhere while something is selected', () => {
    render(<Panel showRail={showRail} />);
    select('a');
    more();
    fireEvent.pointerDown(document.body);
    expect(panel()).not.toBeNull();
    expect(requested()).toBe(true);
  });
});

describe('the rail, with the bar on', () => {
  it('still opens by hand, and closing it asks for nothing', () => {
    render(<Panel showRail />);
    select('a');
    fireEvent.click(screen.getByRole('button', { name: 'Open Properties' }));
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(panel()).toBeNull();
    expect(requested()).toBe(false);
  });

  it('counts wandering off a panel More opened as closing it', () => {
    render(<Panel showRail />);
    select('a');
    more();
    const body = screen.getByRole('region', { name: 'Properties' });
    fireEvent.mouseLeave(body, { buttons: 0 });
    settle();
    expect(panel()).toBeNull();
    expect(requested()).toBe(false);
  });
});

describe('with the bar off', () => {
  beforeEach(() => useSettingsStore.setState({ showSelectionBar: false }));

  it('opens for every selection, as it always did', () => {
    render(<Panel showRail={false} />);
    select('a');
    expect(panel()).not.toBeNull();
    deselect();
    settle();
    expect(panel()).toBeNull();
    select('b');
    expect(panel()).not.toBeNull();
  });

  it('has no close button, and nothing to dismiss', () => {
    render(<Panel showRail={false} />);
    select('a');
    expect(close()).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(requested()).toBe(false);
  });
});
