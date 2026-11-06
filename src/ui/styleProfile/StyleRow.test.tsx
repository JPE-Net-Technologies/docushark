/**
 * The style row (DSK-216): a selection's profile as one row of the properties
 * panel, with the gallery opening under it. Real panel, stores and gallery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ touch: false }));

vi.mock('../confirm/confirmStore', () => ({ confirmDialog: async () => true }));

vi.mock('../../platform/device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/device')>();
  return { ...actual, device: { ...actual.device, isTouch: () => h.touch } };
});

import '../../shapes/Rectangle';
import '../../shapes/Group';
import { PropertyPanel } from '../PropertyPanel';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { usePageStore } from '../../store/pageStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { getProfileUpdates, useStyleProfileStore, type StyleProfile } from '../../store/styleProfileStore';
import type { RectangleShape, Shape } from '../../shapes/Shape';

const BLUE = 'Default Blue';
const GREEN = 'Fresh Green';
const ORANGE = 'Warm Orange';

const profile = (name: string): StyleProfile =>
  useStyleProfileStore.getState().profiles.find((candidate) => candidate.name === name)!;

function rect(id: string, look?: string): void {
  const shape: RectangleShape = {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#123456',
    stroke: '#654321',
    strokeWidth: 3,
    cornerRadius: 1,
  };
  useDocumentStore.getState().addShape(shape);
  if (look) useDocumentStore.getState().updateShape(id, getProfileUpdates(profile(look), shape) as Partial<Shape>);
}

const getProfileUpdatesFor = (name: string, id: string) =>
  getProfileUpdates(profile(name), useDocumentStore.getState().shapes[id]!) as Partial<Shape>;
const select = (...ids: string[]) => act(() => useSessionStore.getState().select(ids));
const trigger = () => screen.getByRole('button', { name: /^Style profile:/ });
const rowName = () => document.querySelector('.style-row-name')?.textContent;
const gallery = () => screen.queryByRole('dialog', { name: 'Style profiles' });
const card = (name: string) => within(gallery()!).getByRole('button', { name: new RegExp(`^${name}`) });
const search = () => within(gallery()!).getByPlaceholderText('Search profiles...');
const fill = (id: string) => useDocumentStore.getState().shapes[id]!.fill;
const previewing = () => Object.keys(useSessionStore.getState().stylePreviewOverrides);
const pressEscape = (target: Element = document.activeElement ?? document.body) =>
  fireEvent.keyDown(target, { key: 'Escape' });

function openGallery() {
  fireEvent.click(trigger());
  expect(gallery()).not.toBeNull();
}

function openCardMenu(name: string) {
  fireEvent.click(within(gallery()!).getByRole('button', { name: `More options for ${name}` }));
  return document.querySelector('.style-profile-context-menu') as HTMLElement;
}

beforeEach(() => {
  h.touch = false;
  useDocumentStore.getState().clear();
  act(() => useSessionStore.getState().clearSelection());
  useSettingsStore.setState({ hideDefaultStyleProfiles: false });
});

afterEach(cleanup);

describe('the row names what is selected', () => {
  it('names the profile a shape matches', () => {
    rect('a', GREEN);
    select('a');
    render(<PropertyPanel />);
    expect(rowName()).toBe(GREEN);
  });

  it('says Custom for a shape that matches none', () => {
    rect('a');
    select('a');
    render(<PropertyPanel />);
    expect(rowName()).toBe('Custom');
  });

  it('names a profile every selected shape matches', () => {
    rect('a', GREEN);
    rect('b', GREEN);
    select('a', 'b');
    render(<PropertyPanel />);
    expect(rowName()).toBe(GREEN);
  });

  it('says Mixed when the selected shapes differ', () => {
    rect('a', GREEN);
    rect('b', ORANGE);
    select('a', 'b');
    render(<PropertyPanel />);
    expect(rowName()).toBe('Mixed');
  });

  it('follows the shape as it changes', () => {
    rect('a', GREEN);
    select('a');
    render(<PropertyPanel />);
    act(() => useDocumentStore.getState().updateShape('a', { fill: '#000001' }));
    expect(rowName()).toBe('Custom');
  });

  it('does not name a profile the settings hide', () => {
    rect('a', GREEN);
    select('a');
    useSettingsStore.setState({ hideDefaultStyleProfiles: true });
    render(<PropertyPanel />);
    expect(rowName()).toBe('Custom');
  });
});

describe('the panel', () => {
  it('keeps the gallery out of the way while a shape is selected', () => {
    rect('a');
    select('a');
    render(<PropertyPanel />);
    expect(document.querySelector('.style-profile-panel')).toBeNull();
    expect(document.querySelector('.property-quick-bar')).not.toBeNull();
  });

  it('still offers the gallery with nothing selected', () => {
    render(<PropertyPanel />);
    expect(document.querySelector('.style-profile-panel')).not.toBeNull();
    expect(screen.getByText('Style Profiles')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Style profile:/ })).toBeNull();
  });

  it('says in its header what is selected', () => {
    rect('a');
    rect('b');
    select('a');
    const { rerender } = render(<PropertyPanel />);
    const title = () => document.querySelector('.property-panel-header-title')?.textContent;
    expect(title()).toBe('Rectangle');
    select('a', 'b');
    rerender(<PropertyPanel />);
    expect(title()).toBe('2 shapes');
  });

  it('counts a group\'s children in its header', () => {
    rect('a');
    rect('b');
    useDocumentStore.getState().groupShapes(['a', 'b'], 'g');
    select('g');
    render(<PropertyPanel />);
    expect(document.querySelector('.property-panel-header-title')?.textContent).toBe('Group (2)');
  });
});

describe('the gallery', () => {
  beforeEach(() => {
    rect('a', BLUE);
    select('a');
    render(<PropertyPanel />);
  });

  it('opens from the row, with search ready and the current profile marked', () => {
    expect(gallery()).toBeNull();
    openGallery();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(search());
    expect(card(BLUE).getAttribute('aria-current')).toBe('true');
    expect(card(GREEN).getAttribute('aria-current')).toBeNull();
  });

  it('takes the keyboard from what it covers', () => {
    expect(document.querySelector('.style-row')?.hasAttribute('data-open')).toBe(false);
    openGallery();
    // StyleRow.css hides every sibling after an open row but the gallery.
    expect(document.querySelector('.style-row')?.hasAttribute('data-open')).toBe(true);
  });

  it('does not repeat the row with a title of its own', () => {
    openGallery();
    expect(within(gallery()!).queryByText('Style Profiles')).toBeNull();
  });

  it('applies a profile, closes, gives focus back, and the row names it', () => {
    openGallery();
    fireEvent.click(card(GREEN));
    expect(fill('a')).toBe(profile(GREEN).properties.fill);
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(rowName()).toBe(GREEN);
  });

  it('closes after applying from a card\'s menu too', () => {
    openGallery();
    const menu = openCardMenu(GREEN);
    fireEvent.click(within(menu).getByRole('button', { name: 'Apply Style' }));
    expect(fill('a')).toBe(profile(GREEN).properties.fill);
    expect(gallery()).toBeNull();
  });

  it('previews on hover without touching the document, and clears on closing', () => {
    openGallery();
    const before = fill('a');
    fireEvent.mouseEnter(card(ORANGE).parentElement!);
    expect(previewing()).toEqual(['a']);
    expect(fill('a')).toBe(before);
    pressEscape();
    expect(previewing()).toEqual([]);
  });

  it('closes on Escape, gives focus back, and leaves the fly-out alone', () => {
    const flyout = vi.fn();
    window.addEventListener('keydown', flyout);
    openGallery();
    pressEscape(document.body);
    window.removeEventListener('keydown', flyout);
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(flyout).not.toHaveBeenCalled();
  });

  it('lets one Escape close only a card\'s menu, without reaching the fly-out', async () => {
    const flyout = vi.fn();
    window.addEventListener('keydown', flyout);
    openGallery();
    openCardMenu(GREEN);
    // The menu starts listening a tick after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    pressEscape(document.body);
    window.removeEventListener('keydown', flyout);
    expect(document.querySelector('.style-profile-context-menu')).toBeNull();
    expect(gallery()).not.toBeNull();
    expect(flyout).not.toHaveBeenCalled();
  });

  it('keeps the Studio open from a card\'s menu, and one Escape closes only it', () => {
    openGallery();
    const menu = openCardMenu(GREEN);
    fireEvent.click(within(menu).getByRole('button', { name: 'Open in Studio' }));
    const studio = within(gallery()!).getByRole('dialog');
    fireEvent.pointerDown(studio);
    expect(gallery()).not.toBeNull();
    pressEscape(document.body);
    expect(within(gallery()!).queryByRole('dialog')).toBeNull();
    expect(gallery()).not.toBeNull();
  });

  it('clears a search on Escape first, and closes on the next', () => {
    openGallery();
    fireEvent.change(search(), { target: { value: 'green' } });
    pressEscape(search());
    expect((search() as HTMLInputElement).value).toBe('');
    expect(gallery()).not.toBeNull();
    pressEscape(search());
    expect(gallery()).toBeNull();
  });

  it('closes on a press outside, without taking focus', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    openGallery();
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('stays open on a press in a dialog it raised, such as a confirmation', () => {
    const confirm = document.createElement('div');
    confirm.setAttribute('role', 'alertdialog');
    document.body.appendChild(confirm);
    openGallery();
    fireEvent.pointerDown(confirm);
    expect(gallery()).not.toBeNull();
    confirm.remove();
  });

  it('closes on pressing the row again', () => {
    openGallery();
    fireEvent.pointerDown(trigger());
    fireEvent.click(trigger());
    expect(gallery()).toBeNull();
  });

  it('closes when the selection changes', () => {
    rect('b');
    openGallery();
    select('b');
    expect(gallery()).toBeNull();
  });

  it('applies the first match on Enter', () => {
    openGallery();
    fireEvent.change(search(), { target: { value: 'orange' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(fill('a')).toBe(profile(ORANGE).properties.fill);
    expect(gallery()).toBeNull();
  });

  it('walks the cards with the arrow keys, from the search field and back', () => {
    openGallery();
    const cards = () => Array.from(gallery()!.querySelectorAll<HTMLElement>('.style-profile-grid-apply'));
    // Two columns.
    cards().forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: Math.floor(index / 2) * 100 } as DOMRect);
    });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards()[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards()[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards()[3]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cards()[2]);
    // Down from the column the short last row doesn't reach: to its last card.
    expect(cards().length % 2).toBe(1);
    cards()[cards().length - 2]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards()[cards().length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    const last = cards()[cards().length - 1];
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(cards()[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(search());
  });

  it('remembers the view you chose between openings', () => {
    openGallery();
    fireEvent.click(within(gallery()!).getByTitle('List view'));
    pressEscape();
    openGallery();
    expect(gallery()!.querySelector('.style-profile-container.list')).not.toBeNull();
    fireEvent.click(within(gallery()!).getByTitle('Grid view'));
  });
});

describe('the gallery on a touch screen', () => {
  it('does not focus search, which would raise the keyboard over the cards', () => {
    h.touch = true;
    rect('a', BLUE);
    select('a');
    render(<PropertyPanel />);
    openGallery();
    expect(document.activeElement).not.toBe(search());
  });
});

describe('a selection linked to its profile (DSK-224)', () => {
  beforeEach(() => {
    const page = usePageStore.getState().createPage('Page');
    usePageStore.getState().setActivePage(page);
    useHistoryStore.getState().setActivePage(page);
  });

  const shape = (id: string) => useDocumentStore.getState().shapes[id]!;
  const change = (id: string, updates: Partial<Shape>) =>
    act(() => useDocumentStore.getState().updateShape(id, updates));
  const resetAll = () => screen.queryByRole('button', { name: /^Reset all to/ });
  const changes = () => document.querySelector('.style-row-changes')?.textContent ?? null;

  /** A selected rectangle with a profile applied, as you would apply one. */
  function applied(name: string, id = 'a') {
    rect(id);
    select(id);
    render(<PropertyPanel />);
    openGallery();
    fireEvent.click(card(name));
  }

  it('links a shape when a profile is applied', () => {
    applied(GREEN);
    expect(shape('a').styleProfileId).toBe(profile(GREEN).id);
    expect(rowName()).toBe(GREEN);
    expect(changes()).toBeNull();
  });

  it('links nothing while only previewing', () => {
    rect('a');
    select('a');
    render(<PropertyPanel />);
    openGallery();
    fireEvent.mouseEnter(card(GREEN).parentElement!);
    pressEscape();
    expect(shape('a').styleProfileId).toBeUndefined();
  });

  it('links every shape selected', () => {
    rect('a');
    rect('b');
    select('a', 'b');
    render(<PropertyPanel />);
    openGallery();
    fireEvent.click(card(GREEN));
    expect(shape('a').styleProfileId).toBe(profile(GREEN).id);
    expect(shape('b').styleProfileId).toBe(profile(GREEN).id);
  });

  it('keeps the name when a property changes, and says how many have', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    expect(rowName()).toBe(GREEN);
    expect(changes()).toBe('1 change');
    change('a', { strokeWidth: 99 });
    expect(changes()).toBe('2 changes');
    expect(document.querySelector('.style-row-reset-count')?.textContent).toBe('2');
  });

  it('says so to a screen reader as well', () => {
    applied(GREEN);
    expect(trigger().getAttribute('aria-label')).toBe(`Style profile: ${GREEN}`);
    change('a', { fill: '#000001' });
    expect(trigger().getAttribute('aria-label')).toBe(`Style profile: ${GREEN}, 1 change`);
  });

  it('stops counting a property changed back by hand', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    change('a', { fill: profile(GREEN).properties.fill! });
    expect(changes()).toBeNull();
    expect(resetAll()).toBeNull();
  });

  it('offers a reset only while there is something to reset', () => {
    applied(GREEN);
    expect(resetAll()).toBeNull();
    change('a', { fill: '#000001' });
    expect(resetAll()).not.toBeNull();
  });

  it('puts everything back with one press, and one undo restores the changes', () => {
    // Already linked: history drops a second step in the same moment as a first.
    rect('a', GREEN);
    change('a', { styleProfileId: profile(GREEN).id } as Partial<Shape>);
    select('a');
    render(<PropertyPanel />);
    change('a', { fill: '#000001' });
    change('a', { strokeWidth: 99 });
    fireEvent.click(resetAll()!);
    expect(fill('a')).toBe(profile(GREEN).properties.fill);
    expect(shape('a').strokeWidth).toBe(profile(GREEN).properties.strokeWidth);
    expect(changes()).toBeNull();
    act(() => useHistoryStore.getState().undo());
    expect(fill('a')).toBe('#000001');
    expect(shape('a').strokeWidth).toBe(99);
    expect(changes()).toBe('2 changes');
  });

  it('resets every shape selected, and counts each property once', () => {
    rect('a');
    rect('b');
    select('a', 'b');
    render(<PropertyPanel />);
    openGallery();
    fireEvent.click(card(GREEN));
    change('a', { fill: '#000001' });
    change('b', { fill: '#000002' });
    change('b', { strokeWidth: 99 });
    expect(changes()).toBe('2 changes');
    fireEvent.click(resetAll()!);
    expect(fill('a')).toBe(profile(GREEN).properties.fill);
    expect(fill('b')).toBe(profile(GREEN).properties.fill);
    expect(shape('b').strokeWidth).toBe(profile(GREEN).properties.strokeWidth);
  });

  it('links a shape it reset, including one that only looked like the profile', () => {
    rect('a', GREEN);
    rect('b');
    select('a', 'b');
    render(<PropertyPanel />);
    change('b', getProfileUpdatesFor(GREEN, 'b'));
    change('b', { styleProfileId: profile(GREEN).id, fill: '#000001' } as Partial<Shape>);
    expect(rowName()).toBe(GREEN);
    fireEvent.click(resetAll()!);
    expect(shape('a').styleProfileId).toBe(profile(GREEN).id);
  });

  it('stays on the row after a reset from the keyboard', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    resetAll()!.focus();
    fireEvent.click(resetAll()!, { detail: 0 });
    expect(document.activeElement).toBe(trigger());
  });

  it('leaves focus alone after a reset with the pointer', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    resetAll()!.focus();
    fireEvent.click(resetAll()!, { detail: 1 });
    expect(document.activeElement).toBe(document.body);
  });

  it('applying the profile it already has clears the changes too', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    openGallery();
    fireEvent.click(card(GREEN));
    expect(fill('a')).toBe(profile(GREEN).properties.fill);
    expect(changes()).toBeNull();
  });

  it('moving to another profile moves the link', () => {
    applied(GREEN);
    change('a', { fill: '#000001' });
    openGallery();
    fireEvent.click(card(ORANGE));
    expect(shape('a').styleProfileId).toBe(profile(ORANGE).id);
    expect(rowName()).toBe(ORANGE);
    expect(changes()).toBeNull();
  });

  it('undoing the apply takes the link back with the look', () => {
    applied(GREEN);
    act(() => useHistoryStore.getState().undo());
    expect(shape('a').styleProfileId).toBeUndefined();
    expect(fill('a')).toBe('#123456');
    expect(rowName()).toBe('Custom');
  });

  it('marks the card it is linked to, even when it looks like another', () => {
    applied(GREEN);
    change('a', getProfileUpdatesFor(ORANGE, 'a'));
    expect(rowName()).toBe(GREEN);
    openGallery();
    expect(card(GREEN).closest('.current')).not.toBeNull();
    expect(card(ORANGE).closest('.current')).toBeNull();
  });

  it('still names a hidden profile once it has been applied', () => {
    applied(GREEN);
    act(() => useSettingsStore.setState({ hideDefaultStyleProfiles: true }));
    expect(rowName()).toBe(GREEN);
  });

  it('falls back to what a shape looks like when its profile is deleted', () => {
    useStyleProfileStore.getState().addProfile('Mine', { ...profile(GREEN).properties, fill: '#0a0a0a' });
    const mine = profile('Mine');
    applied('Mine');
    expect(rowName()).toBe('Mine');
    act(() => useStyleProfileStore.getState().deleteProfile(mine.id));
    expect(rowName()).toBe('Custom');
    expect(changes()).toBeNull();
  });

  describe('saving into a profile', () => {
    afterEach(() => {
      for (const candidate of useStyleProfileStore.getState().profiles) {
        if (!candidate.id.startsWith('default-')) useStyleProfileStore.getState().deleteProfile(candidate.id);
      }
    });

    it('links what is saved as a new profile', () => {
      applied(GREEN);
      change('a', { fill: '#0a0a0a' });
      openGallery();
      fireEvent.click(within(gallery()!).getByTitle('Save current style as a new profile'));
      fireEvent.change(within(gallery()!).getByPlaceholderText('Profile name...'), { target: { value: 'Saved' } });
      fireEvent.keyDown(within(gallery()!).getByPlaceholderText('Profile name...'), { key: 'Enter' });
      expect(shape('a').styleProfileId).toBe(profile('Saved').id);
      expect(rowName()).toBe('Saved');
      expect(changes()).toBeNull();
    });

    it('links what a profile is updated from, and leaves other linked shapes as they are', () => {
      useStyleProfileStore.getState().addProfile('Mine', { ...profile(GREEN).properties, fill: '#0a0a0a' });
      rect('other');
      act(() =>
        useDocumentStore.getState().updateShape('other', {
          ...getProfileUpdatesFor('Mine', 'other'),
          styleProfileId: profile('Mine').id,
        } as Partial<Shape>),
      );
      applied(GREEN);
      change('a', { fill: '#0b0b0b' });
      openGallery();
      fireEvent.click(within(gallery()!).getByRole('button', { name: 'Update Mine with the current style' }));
      expect(shape('a').styleProfileId).toBe(profile('Mine').id);
      expect(profile('Mine').properties.fill).toBe('#0b0b0b');
      expect(shape('other').fill).toBe('#0a0a0a');
      expect(shape('other').styleProfileId).toBe(profile('Mine').id);
    });

    it('links what a profile is reset from', async () => {
      useStyleProfileStore.getState().addProfile('Mine', { ...profile(GREEN).properties, fill: '#0a0a0a' });
      rect('a');
      select('a');
      render(<PropertyPanel />);
      openGallery();
      const menu = openCardMenu('Mine');
      await act(async () => {
        fireEvent.click(within(menu).getByRole('button', { name: 'Reset to Shape' }));
      });
      expect(profile('Mine').properties.fill).toBe('#123456');
      expect(shape('a').styleProfileId).toBe(profile('Mine').id);
    });

    it('adds no undo step for a shape already linked', () => {
      useStyleProfileStore.getState().addProfile('Mine', { ...profile(GREEN).properties, fill: '#123456' });
      applied('Mine');
      const realPush = useHistoryStore.getState().push;
      const push = vi.fn();
      useHistoryStore.setState({ push });
      openGallery();
      fireEvent.click(within(gallery()!).getByRole('button', { name: 'Update Mine with the current style' }));
      expect(push).not.toHaveBeenCalled();
      useHistoryStore.setState({ push: realPush });
    });

    it('leaves a shape unlinked when saving did not make it match', () => {
      rect('a', GREEN);
      rect('b');
      select('a', 'b');
      render(<PropertyPanel />);
      openGallery();
      fireEvent.click(within(gallery()!).getByTitle('Save current style as a new profile'));
      fireEvent.change(within(gallery()!).getByPlaceholderText('Profile name...'), { target: { value: 'FromA' } });
      fireEvent.keyDown(within(gallery()!).getByPlaceholderText('Profile name...'), { key: 'Enter' });
      expect(shape('a').styleProfileId).toBe(profile('FromA').id);
      expect(shape('b').styleProfileId).toBeUndefined();
    });
  });
});
