/**
 * The document title on the toolbar and the phone chip, for a document that
 * isn't named yet (DSK-209).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { usePersistenceStore, UNTITLED_DOCUMENT_NAME } from '../store/persistenceStore';
import { useDocumentNamingStore } from '../services/documentNaming';
import { DocumentInfo } from './UnifiedToolbar';
import { MobileDocumentInfo } from './mobile/MobileDocumentInfo';

const rename = vi.fn((name: string) => usePersistenceStore.setState({ currentDocumentName: name }));

beforeEach(() => {
  rename.mockClear();
  usePersistenceStore.setState({ currentDocumentName: UNTITLED_DOCUMENT_NAME, currentDocumentId: 'doc-1', renameDocument: rename });
  useDocumentNamingStore.setState({ suggestion: 'Quarterly Report' });
});

afterEach(cleanup);

describe('toolbar title (DSK-209)', () => {
  it('says the document is unnamed, and opens with the suggestion', () => {
    render(<DocumentInfo />);
    const button = screen.getByTitle('Name this document');
    expect(button.classList.contains('is-untitled')).toBe(true);
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Quarterly Report');
  });

  it('keeps the old name when left without editing, and takes the suggestion on Enter', () => {
    render(<DocumentInfo />);
    fireEvent.click(screen.getByTitle('Name this document'));
    fireEvent.blur(screen.getByRole('textbox'));
    expect(rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Name this document'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('Quarterly Report');
  });

  it('opens when the name prompt asks it to', () => {
    render(<DocumentInfo />);
    act(() => useDocumentNamingStore.getState().requestTitleEdit());
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Quarterly Report');
  });

  it('shows a named document plainly', () => {
    usePersistenceStore.setState({ currentDocumentName: 'Board minutes' });
    render(<DocumentInfo />);
    const button = screen.getByTitle('Click to rename');
    expect(button.classList.contains('is-untitled')).toBe(false);
    fireEvent.click(button);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Board minutes');
  });
});

describe('phone title chip (DSK-209)', () => {
  it('opens with the suggestion; closing without editing keeps the old name; Enter takes it', () => {
    render(<MobileDocumentInfo />);
    const chip = screen.getByTitle('Name this document');
    expect(chip.classList.contains('is-untitled')).toBe(true);

    fireEvent.click(chip);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Quarterly Report');
    fireEvent.pointerDown(document.body);
    expect(rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Name this document'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('Quarterly Report');
  });

  it('opens when the name prompt asks it to', () => {
    render(<MobileDocumentInfo />);
    act(() => useDocumentNamingStore.getState().requestTitleEdit());
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Quarterly Report');
  });
});
