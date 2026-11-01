/**
 * Naming new documents from what's in them (DSK-209).
 *
 * A new document was "Untitled Document" until the writer found that the
 * toolbar title is clickable, and untitled documents piled up in the list. Now
 * a document whose first block is a heading takes that heading as its name, and
 * one without gets a single prompt with a suggestion. These are the pure parts:
 * the suggestion, the leading-heading check, the per-browser memory of which
 * documents were already prompted or declined, and the small store the title
 * surfaces read (the suggestion, and a request to open the title for editing).
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { create } from 'zustand';

/** The longest suggested name; longer text is cut at a word boundary. */
export const SUGGESTED_NAME_MAX = 60;

/** A name from a block's text: whitespace collapsed, clipped, or null if there's nothing to go on. */
export function nameFromText(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2) return null;
  if (collapsed.length <= SUGGESTED_NAME_MAX) return collapsed;
  // One character past the limit, so a word ending exactly at it is kept whole.
  const boundary = collapsed.slice(0, SUGGESTED_NAME_MAX + 1).lastIndexOf(' ');
  const cut = boundary > SUGGESTED_NAME_MAX / 2 ? collapsed.slice(0, boundary) : collapsed.slice(0, SUGGESTED_NAME_MAX);
  return `${cut.replace(/[\s,;:.-]+$/, '')}…`;
}

/** The suggested name: the first heading, else the first line of text. */
export function suggestDocumentName(doc: PMNode): string | null {
  let heading: string | null = null;
  let firstLine: string | null = null;
  doc.forEach((block) => {
    if (!block.isTextblock) return;
    const name = nameFromText(block.textContent);
    if (!name) return;
    if (heading === null && block.type.name === 'heading') heading = name;
    if (firstLine === null) firstLine = name;
  });
  return heading ?? firstLine;
}

/** The name a leading heading gives the document, or null if the first block isn't a heading with text. */
export function leadingHeadingName(doc: PMNode): string | null {
  const first = doc.firstChild;
  return first?.type.name === 'heading' ? nameFromText(first.textContent) : null;
}

/** Words of text in the document, to tell a real start from a stray keystroke. */
export function wordCount(doc: PMNode): number {
  // Blocks separated, or the last word of one paragraph runs into the first of the next.
  return doc.textBetween(0, doc.content.size, ' ', ' ').split(/\s+/).filter(Boolean).length;
}

// --- What the title surfaces read --------------------------------------------

interface DocumentNamingState {
  /** The current untitled document's suggested name, or null. */
  suggestion: string | null;
  /** Bumped to ask the visible title (toolbar or phone chip) to open for editing. */
  titleEditRequest: number;
  setSuggestion: (suggestion: string | null) => void;
  requestTitleEdit: () => void;
}

export const useDocumentNamingStore = create<DocumentNamingState>((set) => ({
  suggestion: null,
  titleEditRequest: 0,
  setSuggestion: (suggestion) => set((s) => (s.suggestion === suggestion ? s : { suggestion })),
  requestTitleEdit: () => set((s) => ({ titleEditRequest: s.titleEditRequest + 1 })),
}));

// --- What this browser remembers ---------------------------------------------

const MEMORY_KEY = 'docushark-document-naming';
const MEMORY_CAP = 200;

interface NamingMemory {
  /** Documents whose name from a heading was undone: never named automatically again. */
  declined: string[];
  /** Documents already prompted for a name. */
  prompted: string[];
}

function readMemory(): NamingMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Partial<NamingMemory>;
    return { declined: parsed.declined ?? [], prompted: parsed.prompted ?? [] };
  } catch {
    return { declined: [], prompted: [] };
  }
}

function remember(list: keyof NamingMemory, docId: string): void {
  const memory = readMemory();
  if (memory[list].includes(docId)) return;
  memory[list] = [...memory[list], docId].slice(-MEMORY_CAP);
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Storage full or unavailable: the worst case is a second prompt.
  }
}

export const namingMemory = {
  wasDeclined: (docId: string) => readMemory().declined.includes(docId),
  wasPrompted: (docId: string) => readMemory().prompted.includes(docId),
  markDeclined: (docId: string) => remember('declined', docId),
  markPrompted: (docId: string) => remember('prompted', docId),
};
