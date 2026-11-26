/**
 * FontSelect (DSK-246): which fonts it offers where, what a stored value
 * selects, and what choosing reports. RichSelect is stubbed to expose its props.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { RichSelectProps } from './components/RichSelect';

let props: RichSelectProps<string> | null = null;
vi.mock('./components/RichSelect', () => ({
  RichSelect: (received: RichSelectProps<string>) => {
    props = received;
    return null;
  },
}));

import { FontSelect } from './FontSelect';
import { CAVEAT, INTER, JETBRAINS_MONO, SOURCE_SERIF } from '../fonts/catalogue';
import { FOLLOW_DOCUMENT_FONT } from '../fonts/fontFamily';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';

const values = () => props!.items.map((item) => item.value);
const labels = () => props!.items.map((item) => item.label);

beforeEach(() => {
  props = null;
  useDocumentSettingsStore.setState({ settings: { font: SOURCE_SERIF.css }, documentId: 'doc' });
});

describe('FontSelect', () => {
  it('offers the document fonts for a document, and no handwriting', () => {
    render(<FontSelect role="document" value={INTER.css} onChange={() => {}} ariaLabel="Document font" />);
    expect(values()).toEqual([INTER.css, SOURCE_SERIF.css, JETBRAINS_MONO.css]);
    expect(props!.value).toBe(INTER.css);
  });

  it('offers a shape "Document font" first, then every shape font', () => {
    render(<FontSelect role="shape" value={undefined} onChange={() => {}} ariaLabel="Font" />);
    expect(labels()).toEqual(['Document font', 'Inter', 'Source Serif 4', 'JetBrains Mono', 'Caveat']);
    expect(props!.value).toBe(FOLLOW_DOCUMENT_FONT);
  });

  it('selects a bundled font however it was stored', () => {
    render(<FontSelect role="shape" value="caveat" onChange={() => {}} ariaLabel="Font" />);
    expect(props!.value).toBe(CAVEAT.css);
  });

  it('lists a font it does not bundle as it is, so the choice survives', () => {
    render(<FontSelect role="shape" value="'Comic Sans MS', cursive" onChange={() => {}} ariaLabel="Font" />);
    expect(props!.value).toBe("'Comic Sans MS', cursive");
    expect(labels()[labels().length - 1]).toBe('Comic Sans MS');
  });

  it('reports "Document font" as following the document, and a font as its list', () => {
    const onChange = vi.fn();
    render(<FontSelect role="shape" value={CAVEAT.css} onChange={onChange} ariaLabel="Font" />);
    props!.onChange(FOLLOW_DOCUMENT_FONT);
    props!.onChange(SOURCE_SERIF.css);
    expect(onChange.mock.calls).toEqual([[undefined], [SOURCE_SERIF.css]]);
  });
});
