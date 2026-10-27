/**
 * The integration picker (DSK-194): a combobox over a provider's resources.
 *
 * Up and Down move through the results while focus stays in the search box,
 * and Enter picks, as in the command palette; before this they did nothing.
 * Rows carry where the resource lives and what kind it is, dates read one way,
 * and the foot says how far an add has got.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { ExternalResource, IntegrationProvider } from '../../api/webClient';
import type { AddMirrorPageOpts } from '../../services/mirrorPageService';

const search = vi.hoisted(() => vi.fn());
vi.mock('../../api/webClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/webClient')>()),
  webClient: { searchIntegrationResources: search },
}));
const add = vi.hoisted(() => vi.fn());
vi.mock('../../services/mirrorPageService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mirrorPageService')>()),
  addMirrorPage: add,
}));
const openAccount = vi.hoisted(() => vi.fn());
vi.mock('../../services/integrationActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/integrationActions')>()),
  openAccountIntegrations: openAccount,
}));

import { MirrorResourcePicker, modifiedLabel } from './MirrorResourcePicker';

const NOTION: IntegrationProvider = { id: 'notion', label: 'Notion', searchable: true };

const RESOURCES: ExternalResource[] = [
  { externalId: 'a', title: 'AgentX (AgX)', parentTitle: 'Projects', typeLabel: 'Page' },
  { externalId: 'b', title: 'AgX (AgentX)', parentTitle: 'Archive', typeLabel: 'Database row' },
  { externalId: 'c', title: 'Plain' },
];

const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue({ resources: RESOURCES });
  add.mockResolvedValue({ pageId: 'p', warnings: [], childRefs: [] });
});

afterEach(cleanup);

/** Open the picker and wait for its first (empty-query) search to land. */
async function open(): Promise<HTMLElement> {
  render(<MirrorResourcePicker provider={NOTION} onClose={onClose} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return screen.getByRole('combobox');
}

describe('MirrorResourcePicker (DSK-194)', () => {
  it('moves through the results with the arrow keys and picks with Enter', async () => {
    const box = await open();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // stays on the last
    expect(box.getAttribute('aria-activedescendant')).toBe(options[2]!.id);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    expect(options[0]!.getAttribute('aria-selected')).toBe('false');
    // Focus never left the search box.
    expect(document.activeElement).toBe(box);

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(add).toHaveBeenCalledWith('notion', 'b', {}, expect.objectContaining({ onStage: expect.any(Function) }));
  });

  it('says where each resource lives and what kind it is, when it knows', async () => {
    await open();
    const [first, second, third] = screen.getAllByRole('option');
    expect(first!.textContent).toContain('Page');
    expect(first!.textContent).toContain('in Projects');
    expect(second!.textContent).toContain('Database row');
    expect(second!.textContent).toContain('in Archive');
    expect(third!.querySelector('.mirror-picker-row-context')).toBeNull();
  });

  it('labels every date the same relative way', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(modifiedLabel('2026-10-27T11:59:30Z', now)).toBe('just now');
    expect(modifiedLabel('2026-10-25T12:00:00Z', now)).toBe('2d ago');
    expect(modifiedLabel('2026-09-01T12:00:00Z', now)).toBe('1mo ago');
    expect(modifiedLabel('2025-06-01T12:00:00Z', now)).toBe('1y ago');
  });

  it('says how far an add has got', async () => {
    let stage: AddMirrorPageOpts['onStage'];
    add.mockImplementation((_provider: string, _id: string, _deps: unknown, opts: AddMirrorPageOpts) => {
      stage = opts.onStage;
      stage?.('fetching');
      return new Promise(() => {});
    });
    await open();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('option')[0]!);
    });
    expect(screen.getByRole('status').textContent).toBe('Fetching “AgentX (AgX)” and its images from Notion…');
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Fetching…');

    act(() => stage?.('adding'));
    expect(screen.getByRole('status').textContent).toBe('Adding “AgentX (AgX)” to the document…');
  });

  it('offers to choose more pages when none are shared', async () => {
    search.mockResolvedValue({ resources: [] });
    await open();
    expect(screen.getByText('No Notion pages are shared with DocuShark yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Choose pages in Notion/ }));
    expect(openAccount).toHaveBeenCalledWith('notion');
  });
});
