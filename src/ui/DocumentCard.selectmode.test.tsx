/**
 * Select-mode click behaviour (JP-480).
 *
 * Once a selection exists, the document browser is being used to pick
 * documents, not to open one — so a plain click extends the selection. It used
 * to open, which navigated away from the surface and discarded the selection
 * the user had just built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentCard } from './DocumentCard';
import type { LocalDocument } from '../types/DocumentRegistry';

const record: LocalDocument = {
  type: 'local',
  id: 'l1',
  name: 'My Doc',
  pageCount: 1,
  createdAt: 0,
  modifiedAt: 0,
};

function setup(overrides: Partial<React.ComponentProps<typeof DocumentCard>> = {}) {
  const onOpen = vi.fn();
  const onSelectToggle = vi.fn();
  const utils = render(
    <DocumentCard
      record={record}
      isActive={false}
      isSelected={false}
      onOpen={onOpen}
      onSelectToggle={onSelectToggle}
      {...overrides}
    />,
  );
  return { onOpen, onSelectToggle, ...utils };
}

/** The card body — clicking it is the gesture under test. */
const card = (container: HTMLElement) =>
  container.querySelector('.document-card') as HTMLElement;

describe('DocumentCard — select mode', () => {
  beforeEach(cleanup);

  it('opens on a plain click when nothing is selected', () => {
    const { onOpen, onSelectToggle, container } = setup({ showSelectionCheckbox: false });
    fireEvent.click(card(container));
    expect(onOpen).toHaveBeenCalledWith('l1');
    expect(onSelectToggle).not.toHaveBeenCalled();
  });

  it('selects instead of opening once a selection exists', () => {
    const { onOpen, onSelectToggle, container } = setup({ showSelectionCheckbox: true });
    fireEvent.click(card(container));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectToggle).toHaveBeenCalledWith('l1', { shift: false, meta: true });
  });

  it('deselects an already-selected card on a plain click', () => {
    const { onOpen, onSelectToggle, container } = setup({
      showSelectionCheckbox: true,
      isSelected: true,
    });
    fireEvent.click(card(container));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectToggle).toHaveBeenCalledOnce();
  });

  it('marks the card so the cursor can stop promising "open"', () => {
    const { container } = setup({ showSelectionCheckbox: true });
    expect(card(container).classList.contains('document-card--select-mode')).toBe(true);
  });

  it('does not mark the card outside select mode', () => {
    const { container } = setup({ showSelectionCheckbox: false });
    expect(card(container).classList.contains('document-card--select-mode')).toBe(false);
  });

  it('still range-selects on shift-click in select mode', () => {
    const { onOpen, onSelectToggle, container } = setup({ showSelectionCheckbox: true });
    fireEvent.click(card(container), { shiftKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectToggle).toHaveBeenCalledWith('l1', { shift: true, meta: false });
  });

  it('still modifier-selects when nothing is selected yet', () => {
    // This is how a selection gets started in the first place — it must keep
    // working, since select mode is defined by there already being one.
    const { onOpen, onSelectToggle, container } = setup({ showSelectionCheckbox: false });
    fireEvent.click(card(container), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectToggle).toHaveBeenCalledWith('l1', { shift: false, meta: true });
  });

  it('opens normally in select mode when selection is unavailable', () => {
    // No onSelectToggle means the host surface has no selection model, so the
    // flag alone must not be able to swallow the click.
    const onOpen = vi.fn();
    const { container } = render(
      <DocumentCard
        record={record}
        isActive={false}
        isSelected={false}
        showSelectionCheckbox
        onOpen={onOpen}
      />,
    );
    fireEvent.click(card(container));
    expect(onOpen).toHaveBeenCalledWith('l1');
  });

  it('the checkbox still toggles without opening', () => {
    const { onOpen, onSelectToggle } = setup({ showSelectionCheckbox: true });
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelectToggle).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('DocumentCard — restored badge (JP-481)', () => {
  beforeEach(cleanup);

  it('shows a Restored badge when the document carries provenance', () => {
    const restoredFrom = Date.UTC(2026, 6, 29, 15, 4, 11);
    const { container } = render(
      <DocumentCard
        record={{ ...record, restoredFrom }}
        isActive={false}
        isSelected={false}
        onOpen={() => {}}
      />,
    );
    const badge = container.querySelector('.document-card__restored');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Restored');
    // The date the title used to carry is now in the tooltip, not the name.
    expect(badge?.getAttribute('title')).toMatch(/Restored from a version saved/);
  });

  it('shows no badge on an ordinary document', () => {
    const { container } = render(
      <DocumentCard record={record} isActive={false} isSelected={false} onOpen={() => {}} />,
    );
    expect(container.querySelector('.document-card__restored')).toBeNull();
  });

  it('leaves the name untouched — the badge is the whole signal', () => {
    const { container } = render(
      <DocumentCard
        record={{ ...record, restoredFrom: Date.UTC(2026, 6, 29) }}
        isActive={false}
        isSelected={false}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('.document-card__name')?.textContent).toBe('My Doc');
  });
});
