/**
 * The canvas colour input closing its picker. The real input and picker.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CompactColorInput } from './CompactColorInput';

const swatch = () => screen.getByRole('button', { name: /picker/i });
const picker = () => document.querySelector('.compact-color-palette-portal');

function open() {
  render(<CompactColorInput label="Fill" value="#123456" onChange={() => {}} swatchOnly />);
  fireEvent.click(swatch());
  expect(picker()).not.toBeNull();
}

afterEach(cleanup);

describe('the picker closes', () => {
  it('on Escape, and gives focus back to its swatch', () => {
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(swatch());
  });

  it('on Escape alone: a panel around it stays open', () => {
    const panel = vi.fn();
    window.addEventListener('keydown', panel);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    window.removeEventListener('keydown', panel);
    expect(panel).not.toHaveBeenCalled();
  });

  it('for nothing else on the keyboard', () => {
    open();
    fireEvent.keyDown(document, { key: 'a' });
    expect(picker()).not.toBeNull();
  });

  it('takes no notice of Escape once closed', () => {
    const panel = vi.fn();
    render(<CompactColorInput label="Fill" value="#123456" onChange={() => {}} swatchOnly />);
    window.addEventListener('keydown', panel);
    fireEvent.keyDown(document, { key: 'Escape' });
    window.removeEventListener('keydown', panel);
    expect(panel).toHaveBeenCalledTimes(1);
  });

  it('on a press outside', () => {
    open();
    fireEvent.mouseDown(document.body);
    expect(picker()).toBeNull();
  });
});
