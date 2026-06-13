/**
 * Tests for the field store (Phase 3 — Document Fields). Pure data store:
 * upsert/update by name, remove, ordered listing, serialize, and defensive
 * loadFields (mirrors referenceStore's coverage).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useFieldStore } from './fieldStore';
import type { FieldLibrary } from '../types/Field';

beforeEach(() => {
  useFieldStore.getState().clear();
});

describe('setField', () => {
  it('adds a new field and appends it to the order', () => {
    const s = useFieldStore.getState();
    s.setField('Company', 'Acme');
    expect(s.getField('Company')).toEqual({ name: 'Company', value: 'Acme' });
    expect(useFieldStore.getState().order).toEqual(['Company']);
  });

  it('updates the value without duplicating the order entry', () => {
    const s = useFieldStore.getState();
    s.setField('Company', 'Acme');
    s.setField('Company', 'Globex');
    expect(useFieldStore.getState().getField('Company')?.value).toBe('Globex');
    expect(useFieldStore.getState().order).toEqual(['Company']);
  });

  it('trims the name and ignores an empty name', () => {
    const s = useFieldStore.getState();
    s.setField('  Spaced  ', 'v');
    s.setField('   ', 'ignored');
    expect(useFieldStore.getState().order).toEqual(['Spaced']);
    expect(useFieldStore.getState().getField('Spaced')?.value).toBe('v');
  });
});

describe('removeField', () => {
  it('removes a field and its order entry', () => {
    const s = useFieldStore.getState();
    s.setField('A', '1');
    s.setField('B', '2');
    s.removeField('A');
    expect(useFieldStore.getState().getField('A')).toBeUndefined();
    expect(useFieldStore.getState().order).toEqual(['B']);
  });

  it('is a no-op for an unknown name', () => {
    const s = useFieldStore.getState();
    s.setField('A', '1');
    s.removeField('nope');
    expect(useFieldStore.getState().order).toEqual(['A']);
  });
});

describe('listFields', () => {
  it('returns fields in insertion order', () => {
    const s = useFieldStore.getState();
    s.setField('Z', '1');
    s.setField('A', '2');
    expect(useFieldStore.getState().listFields().map((f) => f.name)).toEqual(['Z', 'A']);
  });
});

describe('serialize / loadFields', () => {
  it('round-trips through serialize → loadFields', () => {
    const s = useFieldStore.getState();
    s.setField('A', '1');
    s.setField('B', '2');
    const lib = useFieldStore.getState().serialize();

    useFieldStore.getState().clear();
    useFieldStore.getState().loadFields(lib);
    expect(useFieldStore.getState().listFields()).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
  });

  it('reconciles order with fields (drops dangling, appends missing)', () => {
    const lib: FieldLibrary = {
      fields: { A: { name: 'A', value: '1' }, B: { name: 'B', value: '2' } },
      order: ['A', 'ghost'], // ghost has no field; B missing from order
    };
    useFieldStore.getState().loadFields(lib);
    expect(useFieldStore.getState().order).toEqual(['A', 'B']);
  });

  it('degrades malformed input to an empty library', () => {
    useFieldStore.getState().setField('A', '1');
    // @ts-expect-error — intentionally malformed
    useFieldStore.getState().loadFields({ fields: null, order: 'nope' });
    expect(useFieldStore.getState().order).toEqual([]);
    expect(useFieldStore.getState().listFields()).toEqual([]);
  });
});
