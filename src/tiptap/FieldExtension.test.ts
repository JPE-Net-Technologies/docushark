/**
 * Tests for the FieldRef node (Phase 3 — Document Fields). Headless `new Editor`
 * in jsdom (same pattern as CitationExtension / Gallery tests). Covers
 * serialization, the `setFieldRef` command, the live value projection, and the
 * unset-field placeholder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { FieldRef, resolveFieldValue } from './FieldExtension';
import { useFieldStore } from '../store/fieldStore';

const extensions = [StarterKit.configure({ history: false }), FieldRef];

function makeEditor(content: string): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

beforeEach(() => {
  useFieldStore.getState().clear();
});

describe('FieldRef serialization', () => {
  it('round-trips a field reference (data-field + data-name) from HTML', () => {
    const { editor, element } = makeEditor('<p><span data-field data-name="Company"></span></p>');
    const html = editor.getHTML();
    expect(html).toContain('data-field');
    expect(html).toContain('data-name="Company"');
    editor.destroy();
    element.remove();
  });

  it('parses an MCP-style span with no cached label', () => {
    // The future adapter emits `{{name}}` → <span data-field data-name> with no
    // data-label; the node must still parse and carry the name.
    const { editor, element } = makeEditor('<p><span data-field data-name="Term"></span></p>');
    const json = editor.getJSON();
    const node = json.content?.[0]?.content?.[0];
    expect(node?.type).toBe('fieldRef');
    expect(node?.attrs?.['name']).toBe('Term');
    editor.destroy();
    element.remove();
  });
});

describe('setFieldRef command', () => {
  it('inserts a fieldRef node by name', () => {
    const { editor, element } = makeEditor('<p></p>');
    editor.commands.setFieldRef('Version');
    expect(editor.getHTML()).toContain('data-name="Version"');
    editor.destroy();
    element.remove();
  });
});

describe('value projection', () => {
  it('renders the field value when set', () => {
    useFieldStore.getState().setField('Company', 'Acme');
    const { editor, element } = makeEditor('<p></p>');
    editor.commands.setFieldRef('Company');
    const node = element.querySelector('.field-ref');
    expect(node?.textContent).toBe('Acme');
    editor.destroy();
    element.remove();
  });

  it('shows a {name} placeholder when the field is unset', () => {
    const { editor, element } = makeEditor('<p></p>');
    editor.commands.setFieldRef('Unknown');
    const node = element.querySelector('.field-ref');
    expect(node?.textContent).toBe('{Unknown}');
    expect(node?.classList.contains('field-ref-unset')).toBe(true);
    editor.destroy();
    element.remove();
  });

  it('repaints live when the field value changes', () => {
    useFieldStore.getState().setField('Status', 'Draft');
    const { editor, element } = makeEditor('<p></p>');
    editor.commands.setFieldRef('Status');
    expect(element.querySelector('.field-ref')?.textContent).toBe('Draft');

    useFieldStore.getState().setField('Status', 'Final');
    expect(element.querySelector('.field-ref')?.textContent).toBe('Final');
    editor.destroy();
    element.remove();
  });
});

describe('resolveFieldValue', () => {
  it('resolves a user field value', () => {
    useFieldStore.getState().setField('A', '1');
    expect(resolveFieldValue('A')).toBe('1');
  });

  it('resolves a computed field live (today is non-empty)', () => {
    expect(resolveFieldValue('today')).toBeTruthy();
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveFieldValue('nope')).toBeUndefined();
  });
});
