/**
 * Tests for ReferenceManagerDialog (JP-89 slice 5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReferenceManagerDialog } from './ReferenceManagerDialog';
import { useReferenceStore } from '../store/referenceStore';
import { useNotificationStore } from '../store/notificationStore';

beforeEach(() => useReferenceStore.getState().clear());
afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

describe('ReferenceManagerDialog', () => {
  it('imports pasted CSL-JSON into the library and lists it', async () => {
    render(<ReferenceManagerDialog onClose={noop} />);

    fireEvent.change(screen.getByLabelText('Import BibTeX or CSL-JSON'), {
      target: { value: '[{"id":"smith2020","type":"article-journal","title":"On Things","author":[{"family":"Smith"}]}]' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(useReferenceStore.getState().itemOrder).toContain('smith2020'));
    expect(screen.getByText(/Smith/)).toBeTruthy();
  });

  it('removes a reference', async () => {
    useReferenceStore.getState().addReference({ id: 'doe2019', type: 'book', title: 'A Book', author: [{ family: 'Doe' }] });
    render(<ReferenceManagerDialog onClose={noop} />);

    expect(screen.getByText(/Doe/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove doe2019' }));

    await waitFor(() => expect(useReferenceStore.getState().itemOrder).not.toContain('doe2019'));
  });

  it('changes the active citation style', () => {
    render(<ReferenceManagerDialog onClose={noop} />);
    fireEvent.change(screen.getByLabelText('Citation style'), { target: { value: 'mla' } });
    expect(useReferenceStore.getState().activeStyle).toBe('mla');
  });

  it('resolves a DOI via the network and imports it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ DOI: '10.1000/xyz', type: 'article-journal', title: 'Resolved', author: [{ family: 'Net' }] }),
      })),
    );
    render(<ReferenceManagerDialog onClose={noop} />);

    fireEvent.change(screen.getByLabelText('Add by DOI'), { target: { value: '10.1000/xyz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(useReferenceStore.getState().itemOrder).toContain('10.1000/xyz'));
    expect(screen.getByText(/Resolved/)).toBeTruthy();
  });

  it('surfaces an error toast for an invalid DOI (no network call)', async () => {
    const errorSpy = vi.spyOn(useNotificationStore.getState(), 'error');
    render(<ReferenceManagerDialog onClose={noop} />);

    fireEvent.change(screen.getByLabelText('Add by DOI'), { target: { value: 'not-a-doi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(useReferenceStore.getState().itemOrder).toHaveLength(0);
  });
});
