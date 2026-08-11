import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToolbarDropdown } from './ToolbarDropdown';

afterEach(cleanup);

/**
 * The dropdown suppresses mousedown so clicking a toolbar control does not
 * collapse the editor's selection — a colour swatch has to apply to the text
 * the user had highlighted.
 *
 * Suppressing the default also suppresses *focus*, which is fine for buttons
 * and fatal for text fields: reported live as "custom hex color can't be
 * edited, only in prose tools". The caret never left the document, so the
 * typing went into the page instead of the field.
 */
describe('ToolbarDropdown focus handling', () => {
  const openDropdown = (children: React.ReactNode) =>
    render(
      <ToolbarDropdown trigger="T" isOpen onToggle={() => {}} onClose={() => {}}>
        {children}
      </ToolbarDropdown>
    );

  it('lets a text field inside it take focus', () => {
    openDropdown(<input aria-label="Hex color" />);
    const evt = fireEvent.mouseDown(screen.getByLabelText('Hex color'));
    // fireEvent returns false when a listener called preventDefault.
    expect(evt).toBe(true);
  });

  it('still preserves the editor selection when a button is clicked', () => {
    openDropdown(<button aria-label="Swatch" />);
    const evt = fireEvent.mouseDown(screen.getByLabelText('Swatch'));
    expect(evt).toBe(false);
  });

  it('lets a textarea and a select take focus too', () => {
    openDropdown(
      <>
        <textarea aria-label="Notes" />
        <select aria-label="Choice">
          <option>a</option>
        </select>
      </>
    );
    expect(fireEvent.mouseDown(screen.getByLabelText('Notes'))).toBe(true);
    expect(fireEvent.mouseDown(screen.getByLabelText('Choice'))).toBe(true);
  });

  it('preserves the selection for non-interactive chrome', () => {
    openDropdown(<div data-testid="label">Palette</div>);
    expect(fireEvent.mouseDown(screen.getByTestId('label'))).toBe(false);
  });
});

describe('ToolbarDropdown rendering', () => {
  it('renders nothing but the trigger while closed', () => {
    render(
      <ToolbarDropdown trigger="T" isOpen={false} onToggle={() => {}} onClose={() => {}}>
        <input aria-label="Hex color" />
      </ToolbarDropdown>
    );
    expect(screen.queryByLabelText('Hex color')).toBeNull();
  });

  it('toggles from the trigger', () => {
    const onToggle = vi.fn();
    render(
      <ToolbarDropdown trigger="T" isOpen={false} onToggle={onToggle} onClose={() => {}}>
        <span />
      </ToolbarDropdown>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
