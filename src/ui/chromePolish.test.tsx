/**
 * Small things that were wrong in the chrome: each is cheap to get wrong again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ touch: false }));

vi.mock('../platform/device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/device')>();
  return { ...actual, device: { ...actual.device, isTouch: () => h.touch } };
});

import { CommandPalette } from './CommandPalette';
import { Whiteboard } from './Whiteboard';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { getAllCommands } from '../engine/CommandRegistry';
import { DOCS_URL } from '../platform/opener';

beforeEach(() => {
  h.touch = false;
});

afterEach(cleanup);

describe('text on a primary fill', () => {
  /** Every stylesheet under src/. */
  function stylesheets(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return stylesheets(path);
      return name.endsWith('.css') ? [path] : [];
    });
  }

  it('uses the colour made for it: white is unreadable on the dark theme\'s gold', () => {
    const offenders: string[] = [];
    for (const path of stylesheets('src')) {
      const css = readFileSync(path, 'utf8');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const onPrimary = /background(-color)?:\s*var\(--color-primary(,[^)]*)?\)/.test(body!);
        const white = /(^|[;\s])color:\s*(#fff(fff)?|white)\b/.test(body!);
        if (onPrimary && white) offenders.push(`${path}: ${selector!.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the command palette', () => {
  beforeEach(() => {
    // jsdom doesn't lay out, and the palette scrolls its selection into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('closes on a hardware keyboard\'s Escape with focus outside it, as on a touch screen', () => {
    h.touch = true;
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes once for an Escape inside it', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/search commands/i), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone while closed', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={false} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('adding a shape from the palette', () => {
  const addCommands = () => getAllCommands().filter((command) => command.id.startsWith('add.'));

  function canvasRegion(shown: boolean) {
    const region = document.createElement('div');
    region.dataset['focusRegion'] = 'canvas';
    region.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList;
    document.body.appendChild(region);
    return region;
  }

  it('is on offer with the canvas on screen', () => {
    const region = canvasRegion(true);
    expect(addCommands().length).toBeGreaterThan(0);
    for (const command of addCommands()) expect(command.canExecute?.(), command.id).toBe(true);
    region.remove();
  });

  it('is not, with no canvas to see the shape on', () => {
    const region = canvasRegion(false);
    for (const command of addCommands()) expect(command.canExecute?.(), command.id).toBe(false);
    region.remove();
  });
});

describe('the empty whiteboard', () => {
  beforeEach(() => {
    act(() => useWhiteboardStore.setState({ isVisible: true }));
  });

  afterEach(() => {
    act(() => useWhiteboardStore.setState({ isVisible: false }));
  });

  it('says to click or double-click with a pointer', () => {
    render(<Whiteboard />);
    expect(screen.getByText(/double-click to add a note/)).toBeTruthy();
  });

  it('says to tap on a touch screen', () => {
    h.touch = true;
    render(<Whiteboard />);
    expect(screen.getByText(/to add a note/).textContent).toBe('Tap + to add a note');
  });
});

describe('the documentation', () => {
  it('lives at its own address', () => {
    expect(DOCS_URL).toBe('https://docs.docushark.app/');
  });
});
