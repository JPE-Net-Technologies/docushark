/**
 * Tools in the top bar, in every layout (DSK-222). On a phone the button is the
 * same, the same actions open in a sheet, and the documentation joins them, since
 * a phone has no Help button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ phone: false, openDocs: vi.fn(() => Promise.resolve()) }));

vi.mock('./layout/useMobileAdaptation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./layout/useMobileAdaptation')>()),
  useMobileAdaptation: () => ({ isMobile: h.phone, mobileActive: h.phone, accepted: h.phone, forceDesktop: false }),
}));
vi.mock('../platform/opener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/opener')>();
  return { ...actual, opener: { ...actual.opener, openDocs: h.openDocs } };
});

import { UnifiedToolbar } from './UnifiedToolbar';
import { getToolsActions, commandShortcut } from '../engine/CommandRegistry';

const tools = () => screen.getByRole('button', { name: 'Tools' });
const tile = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}`) });
const sheet = () => screen.queryByRole('dialog', { name: 'Tools' });

/** Every window event `name` fired during the test. */
function listen(name: string) {
  const spy = vi.fn();
  window.addEventListener(name, spy);
  cleanups.push(() => window.removeEventListener(name, spy));
  return spy;
}

let cleanups: Array<() => void>;

beforeEach(() => {
  cleanups = [];
  h.phone = false;
  h.openDocs.mockClear();
});

afterEach(() => {
  cleanup();
  for (const undo of cleanups) undo();
});

describe('on a desktop', () => {
  it('opens the Tools panel beside a Help button', () => {
    render(<UnifiedToolbar />);
    expect(screen.getByRole('button', { name: 'Open documentation' })).toBeTruthy();
    fireEvent.click(tools());
    // A popover hanging from the button, not a sheet.
    expect(document.querySelector('.mobile-sheet')).toBeNull();
    expect(tile('Export to PDF')).toBeTruthy();
  });

  it('runs a tool and closes the panel', () => {
    const exported = listen('docushark:open-pdf-export');
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    fireEvent.click(tile('Export to PDF')!);
    expect(exported).toHaveBeenCalledTimes(1);
    expect(tile('Export to PDF')).toBeNull();
  });

  it('leaves the documentation to the Help button, and shows shortcuts', () => {
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    const panel = document.querySelector('.tools-panel') as HTMLElement;
    expect(within(panel).queryByRole('button', { name: /^Open documentation/ })).toBeNull();
    const whiteboard = commandShortcut('view.toggleWhiteboard')!;
    expect(within(panel).getByRole('button', { name: /^Whiteboard/ }).textContent).toContain(whiteboard);
  });
});

describe('on a phone', () => {
  beforeEach(() => {
    h.phone = true;
  });

  it('has a Tools button, and no Help or "More actions" button', () => {
    render(<UnifiedToolbar />);
    expect(tools()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open documentation' })).toBeNull();
  });

  it('opens a sheet with every desktop tool, plus the documentation and the palette', () => {
    render(<UnifiedToolbar />);
    expect(sheet()).toBeNull();
    fireEvent.click(tools());
    // Rising from the bottom edge, as the phone's other menus do.
    expect(sheet()!.classList.contains('mobile-sheet--bottom')).toBe(true);
    for (const action of getToolsActions()) expect(tile(action.label), action.label).toBeTruthy();
    expect(tile('Open documentation')).toBeTruthy();
    expect(tile('Command palette')).toBeTruthy();
  });

  it('shows no shortcuts, with no keyboard to press them on', () => {
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    const whiteboard = commandShortcut('view.toggleWhiteboard')!;
    expect(tile('Whiteboard')!.textContent).not.toContain(whiteboard);
    expect(tile('Command palette')!.textContent).not.toContain(commandShortcut('view.commandPalette')!);
  });

  it('runs a tool and closes the sheet', () => {
    const exported = listen('docushark:open-pdf-export');
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    fireEvent.click(tile('Export to PDF')!);
    expect(exported).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it('opens the documentation and closes the sheet', () => {
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    fireEvent.click(tile('Open documentation')!);
    expect(h.openDocs).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it('opens the palette and closes the sheet', () => {
    const palette = listen('docushark:toggle-command-palette');
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    fireEvent.click(tile('Command palette')!);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it('closes from its close button', () => {
    render(<UnifiedToolbar />);
    fireEvent.click(tools());
    fireEvent.click(within(sheet()!).getByRole('button', { name: 'Close' }));
    expect(sheet()).toBeNull();
    expect(tools().getAttribute('aria-expanded')).toBe('false');
  });
});
