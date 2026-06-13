/**
 * CodeBlockComponent - React nodeView for code blocks.
 *
 * Renders the editable code (via NodeViewContent as a `<code>` inside `<pre>`)
 * plus a non-editable header with a language selector and a copy button. The
 * lowlight syntax-highlight decorations apply to the NodeViewContent exactly as
 * they would without a nodeView — this only adds chrome.
 */

import { useState } from 'react';
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { CODE_BLOCK_LANGUAGES } from '../tiptap/CodeBlockExtension';
import './CodeBlockComponent.css';

export function CodeBlockComponent({ node, updateAttributes, editor }: NodeViewProps) {
  const language = (node.attrs['language'] as string | null) || 'plaintext';
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (permissions / insecure context) — ignore.
    }
  };

  return (
    <NodeViewWrapper className="code-block">
      <div className="code-block-header" contentEditable={false}>
        <select
          className="code-block-lang"
          value={language}
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value })}
          aria-label="Code language"
          // Keep the editor selection from collapsing when interacting.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {CODE_BLOCK_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
        <button
          type="button"
          className="code-block-copy"
          onClick={copy}
          onMouseDown={(e) => e.preventDefault()}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="tiptap-code-block">
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
