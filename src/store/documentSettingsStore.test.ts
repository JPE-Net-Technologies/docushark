/**
 * The document settings store (DSK-246) holds every setting a document carries,
 * keys this build doesn't know included, and gives a save exactly that back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { settingsForSave, useDocumentSettingsStore } from './documentSettingsStore';
import { normalizeDocumentSettings } from '../types/DocumentSettings';

const store = () => useDocumentSettingsStore.getState();

beforeEach(() => {
  useDocumentSettingsStore.setState({ settings: {}, documentId: undefined });
});

describe('normalizeDocumentSettings', () => {
  it('keeps a plain object of JSON values, nested ones included', () => {
    const raw = { font: 'Inter, sans-serif', fromANewerBuild: { list: [1, true, null, 'x'] } };
    expect(normalizeDocumentSettings(raw)).toEqual(raw);
  });

  it('copies, so later changes to the input never reach the settings', () => {
    const raw = { nested: { value: 1 } };
    const settings = normalizeDocumentSettings(raw);
    raw.nested.value = 2;
    expect(settings).toEqual({ nested: { value: 1 } });
  });

  it('reads anything that is not a plain object as no settings', () => {
    // A Date is an object whose JSON is a string.
    for (const raw of [undefined, null, 'font', 3, ['font'], new Date(0)]) {
      expect(normalizeDocumentSettings(raw), String(raw)).toEqual({});
    }
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(normalizeDocumentSettings(cycle)).toEqual({});
  });
});

describe('documentSettingsStore', () => {
  it('loads every key and serializes them back', () => {
    const raw = { font: "'Source Serif 4', serif", pageSize: { name: 'a4' } };
    store().load(raw, 'doc-a');
    expect(store().documentId).toBe('doc-a');
    expect(store().serialize()).toEqual(raw);
  });

  it('serializes no settings as undefined, so a save writes no empty field', () => {
    store().load(undefined, 'doc-a');
    expect(store().serialize()).toBeUndefined();
  });

  it('sets, replaces and removes one setting, leaving the others as they were', () => {
    store().load({ font: 'Inter, sans-serif', pageSize: { name: 'a4' } }, 'doc-a');
    const pageSize = store().settings['pageSize'];

    store().set('font', 'Caveat, cursive');
    expect(store().settings).toEqual({ font: 'Caveat, cursive', pageSize: { name: 'a4' } });
    expect(store().settings['pageSize']).toBe(pageSize);

    store().set('font', undefined);
    expect(store().settings).toEqual({ pageSize: { name: 'a4' } });
    expect(store().settings['pageSize']).toBe(pageSize);
  });

  it('removing a setting that is not there changes nothing', () => {
    store().load({ font: 'Inter, sans-serif' }, 'doc-a');
    const before = store().settings;
    store().set('missing', undefined);
    expect(store().settings).toBe(before);
  });

  it('adopts a peer’s settings without changing which document they belong to', () => {
    store().load({ font: 'Inter, sans-serif' }, 'doc-a');
    store().loadRemote({ font: 'Caveat, cursive', extra: 1 });
    expect(store().settings).toEqual({ font: 'Caveat, cursive', extra: 1 });
    expect(store().documentId).toBe('doc-a');
  });

  it('a new document starts with none', () => {
    store().load({ font: 'Inter, sans-serif' }, 'doc-a');
    store().clear();
    expect(store().settings).toEqual({});
    expect(store().documentId).toBeNull();
  });
});

describe('settingsForSave', () => {
  const stored = { font: 'Stored, serif' };

  it('keeps the stored copy’s settings when no document has loaded yet', () => {
    expect(settingsForSave(stored)).toEqual(stored);
  });

  it('writes the store’s settings once a document has loaded, even none', () => {
    store().load({ font: 'Live, serif' }, 'doc-a');
    expect(settingsForSave(stored)).toEqual({ font: 'Live, serif' });

    store().set('font', undefined);
    expect(settingsForSave(stored)).toBeUndefined();
  });

  it('writes the store’s settings for a new document', () => {
    store().clear();
    store().set('font', 'Caveat, cursive');
    expect(settingsForSave(undefined)).toEqual({ font: 'Caveat, cursive' });
  });
});
