/**
 * The top bar's Share menu (DSK-257): sharing with people, then the files you
 * can send; what can't run now stays listed, greyed, with the reason.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { registerShareActions, SHARE_BLOCK_REASONS } from '../../services/shareActions';
import { useConnectionStore } from '../../store/connectionStore';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useUserStore } from '../../store/userStore';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { useAccessPanelStore } from '../access/accessPanelStore';
import { ShareMenu } from './ShareMenu';

const trigger = () => screen.getByRole('button', { name: /Share/ });
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' });
const item = (name: RegExp) => screen.getByRole('menuitem', { name });

function openDocument(record: Partial<DocumentRecord>, role: string | null): void {
  useDocumentRegistry.setState({
    activeDocumentId: 'doc-1',
    entries: { 'doc-1': { record: { id: 'doc-1', name: 'Report', ...record } as DocumentRecord, isLoading: false } },
  });
  usePersistenceStore.setState({ currentDocumentId: 'doc-1' });
  useConnectionStore.setState({ token: role ? 'token' : null, tokenExpiresAt: null });
  useUserStore.setState({ currentUser: role ? ({ id: 'me', role } as never) : null });
}

beforeAll(registerShareActions);
beforeEach(() => useAccessPanelStore.setState({ isOpen: false, documentId: null, focus: null }));
afterEach(cleanup);

describe('the Share menu', () => {
  it('lists sharing with people, then the files to send', () => {
    openDocument({ type: 'remote', permission: 'owner' }, 'member');
    render(<ShareMenu />);
    open();
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Share with people…',
      'Publish a link…',
      'Export to PDF…',
      'Download a copy',
    ]);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('opens the access panel at publishing for a link', () => {
    openDocument({ type: 'remote', permission: 'owner' }, 'member');
    render(<ShareMenu />);
    open();
    fireEvent.click(item(/Publish a link/));
    expect(useAccessPanelStore.getState()).toMatchObject({ isOpen: true, documentId: 'doc-1', focus: 'publish' });
  });

  it('greys out sharing with people on this device only, and says why', () => {
    openDocument({ type: 'local' }, 'member');
    render(<ShareMenu />);
    open();
    expect(item(/Share with people/).getAttribute('aria-disabled')).toBe('true');
    expect(item(/Publish a link/).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('note').textContent).toBe(SHARE_BLOCK_REASONS.local);
    expect(item(/Export to PDF/).getAttribute('aria-disabled')).toBeNull();
  });

  it('opens the PDF export', () => {
    openDocument({ type: 'local' }, null);
    const opened = vi.fn();
    window.addEventListener('docushark:open-pdf-export', opened);
    render(<ShareMenu />);
    open();
    fireEvent.click(item(/Export to PDF/));
    window.removeEventListener('docushark:open-pdf-export', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
