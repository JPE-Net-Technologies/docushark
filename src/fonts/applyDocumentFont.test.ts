/**
 * Prose reads the document font from CSS (DSK-246): `--doc-font` follows the
 * open document, and code keeps the code font.
 */
import { expect, it } from 'vitest';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import { CODE_FONT, DEFAULT_DOCUMENT_FONT, SOURCE_SERIF } from './catalogue';
import './applyDocumentFont';

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

it('publishes the document font, and follows a change and a document switch', () => {
  useDocumentSettingsStore.getState().load({}, 'a');
  expect(cssVar('--doc-font')).toBe(DEFAULT_DOCUMENT_FONT.css);
  expect(cssVar('--doc-font-mono')).toBe(CODE_FONT.css);

  useDocumentSettingsStore.getState().set('font', SOURCE_SERIF.css);
  expect(cssVar('--doc-font')).toBe(SOURCE_SERIF.css);

  useDocumentSettingsStore.getState().load({}, 'b');
  expect(cssVar('--doc-font')).toBe(DEFAULT_DOCUMENT_FONT.css);
});
