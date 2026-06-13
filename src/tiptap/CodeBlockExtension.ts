/**
 * Code block extension — `CodeBlockLowlight` (syntax highlighting via lowlight)
 * with a React nodeView that adds a language selector and a copy button.
 *
 * Replaces StarterKit's plain `codeBlock` (disabled in both editors). It keeps
 * the same node name (`codeBlock`), `<pre><code>` serialization, and the
 * `tiptap-code-block` class, so:
 *   - existing documents' code blocks parse unchanged (the new `language` attr
 *     just defaults to null → no migration), and
 *   - `CodeBlockKeymap` (Tab-to-indent, which keys off `parent.type.name ===
 *     'codeBlock'`) keeps working.
 *
 * Highlighting is a view-only decoration — `getHTML()` still emits a plain
 * `<pre><code class="language-…">`, so PDF / MCP / offline are self-contained.
 *
 * The lowlight `common` set (~37 languages) loads with the lazy prose chunk, not
 * the main bundle.
 */

import { ReactNodeViewRenderer } from '@tiptap/react';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import { CodeBlockComponent } from '../ui/CodeBlockComponent';

// Register a curated language set rather than lowlight's `common` (~37
// languages). highlight.js rides the prose extension graph, which is eager
// (same as katex via LatexExtension), so `common` would add ~1MB to the initial
// bundle. This dozen covers the overwhelming majority of code blocks; broadening
// (or lazy-loading the whole prose stack) is tracked as an optimization.
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml'; // also powers html (alias)
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight();
lowlight.register({
  bash, c, cpp, csharp, css, go, java, javascript, json, markdown, python, rust,
  sql, typescript, xml, yaml,
});

/** Languages offered in the nodeView selector (registered above; `xml` also
 * highlights `html` via its alias). `plaintext` disables highlighting. */
export const CODE_BLOCK_LANGUAGES = [
  'plaintext', 'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java',
  'javascript', 'json', 'markdown', 'python', 'rust', 'sql', 'typescript',
  'xml', 'yaml',
] as const;

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent);
  },
}).configure({
  lowlight,
  HTMLAttributes: { class: 'tiptap-code-block' },
});
