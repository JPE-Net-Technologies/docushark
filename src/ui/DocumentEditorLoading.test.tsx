/**
 * The document editor's loading state (DSK-205): a labelled status, styled
 * from a stylesheet the main bundle loads, and the fallback for every lazy
 * editor mount. Before it, the region was an unstyled empty div.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DocumentEditorLoading } from './DocumentEditorLoading';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('DocumentEditorLoading (DSK-205)', () => {
  it('is a labelled status', () => {
    render(<DocumentEditorLoading />);
    expect(screen.getByRole('status', { name: 'Loading the editor' })).toBeTruthy();
  });

  it('is styled from App.css, not the stylesheet that arrives with the editor chunk', () => {
    expect(source('src/ui/App.css')).toMatch(/^\.document-editor-loading \{/m);
    expect(source('src/ui/DocumentEditorPanel.css')).not.toContain('.document-editor-loading');
  });

  it('paints the backdrop the panel paints, in either theme', () => {
    const background = (css: string, selector: string) =>
      css.match(new RegExp(`^${selector.replace('.', '\\.')} \\{[^}]*background: ([^;]+);`, 'm'))?.[1];
    const panelCss = source('src/ui/DocumentEditorPanel.css');
    const loading = background(source('src/ui/App.css'), '.document-editor-loading');
    expect(loading).toContain('--prose-backdrop');
    expect(background(panelCss, '.document-editor-panel')).toBe(loading);
    // A theme-specific panel backdrop would need its twin here; it belongs in the token.
    expect(panelCss).not.toMatch(/\[data-theme[^\]]*\]\s*\.document-editor-panel\s*\{[^}]*background/);
  });

  it('is the fallback for every lazy editor mount', () => {
    const app = source('src/ui/App.tsx');
    const mounts = app.match(/<DocumentEditorPanel\b/g)?.length ?? 0;
    expect(mounts).toBeGreaterThan(0);
    expect(app.match(/<Suspense fallback=\{<DocumentEditorLoading \/>\}>/g)?.length).toBe(mounts);
  });
});
