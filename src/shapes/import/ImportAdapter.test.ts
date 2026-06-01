import { describe, it, expect, afterEach } from 'vitest';
import {
  registerImportAdapter,
  getImportAdapter,
  listImportAdapters,
  findImportAdapter,
  unregisterImportAdapter,
  type ImportAdapter,
} from './ImportAdapter';

const fakeMermaid: ImportAdapter = {
  id: 'fake-mermaid',
  label: 'Fake Mermaid',
  canImport: (raw) => raw.trimStart().startsWith('graph'),
  import: () => Promise.resolve({ shapes: [] }),
};

describe('ImportAdapter registry', () => {
  afterEach(() => {
    unregisterImportAdapter('fake-mermaid');
  });

  it('registers and retrieves an adapter by id', () => {
    registerImportAdapter(fakeMermaid);
    expect(getImportAdapter('fake-mermaid')).toBe(fakeMermaid);
    expect(listImportAdapters()).toContain(fakeMermaid);
  });

  it('throws on duplicate id', () => {
    registerImportAdapter(fakeMermaid);
    expect(() => registerImportAdapter(fakeMermaid)).toThrow(/already registered/);
  });

  it('finds an adapter by sniffing source text', () => {
    registerImportAdapter(fakeMermaid);
    expect(findImportAdapter('graph TD; A-->B')).toBe(fakeMermaid);
    expect(findImportAdapter('<mxGraphModel>')).toBeUndefined();
  });
});
