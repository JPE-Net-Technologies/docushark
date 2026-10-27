/**
 * No UI code spells a shortcut by hand (DSK-198).
 *
 * Labels written as "Ctrl+…" were wrong on a Mac, the layout tiles' "⌘⇧2" was
 * wrong everywhere else, and a hand-written label can outlive its binding:
 * "Save now (Ctrl+S)" advertised a shortcut nothing handled. Labels come from
 * `commandShortcut(id)` for registry commands, or `formatCombo(spec)` for a
 * binding an editor owns.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { commandShortcut } from '../engine/CommandRegistry';
import { LAYOUT_MODES } from './layout/types';

const ROOTS = ['src/ui', 'src/tiptap'];
/** Unmounted; its removal is tracked separately. */
const IGNORED = new Set(['src/ui/FileMenu.tsx']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('shortcut labels (DSK-198)', () => {
  it('come from the shared formatter, never spelled out for one platform', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(resolve(process.cwd(), root))) {
        const rel = relative(process.cwd(), file);
        if (IGNORED.has(rel)) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return; // comments
            if (/\b(Ctrl|Cmd)\+|[⌘⇧⌥⌃]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('name commands that exist and are bound to keys', () => {
    // A mistyped id reads back undefined and leaves a blank label, which no
    // render test would notice. The layout tiles build theirs from the modes.
    const ids = new Set(LAYOUT_MODES.map((mode) => `view.layout.${mode}`));
    for (const root of ROOTS) {
      for (const file of sources(resolve(process.cwd(), root))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/commandShortcut\('([^']+)'\)/g)) {
          const id = match[1];
          if (id) ids.add(id);
        }
      }
    }
    expect(ids.size).toBeGreaterThan(LAYOUT_MODES.length);
    expect([...ids].filter((id) => commandShortcut(id) === undefined)).toEqual([]);
  });
});
