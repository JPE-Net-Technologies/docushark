/**
 * Minimal ambient types for `@citation-js/core` (JP-89 slice 2).
 *
 * citation-js ships no TypeScript declarations. We only use a narrow surface —
 * the `Cite` constructor with `forceType` and its `data` array (CSL-JSON items)
 * — so we declare just that rather than depend on an out-of-tree `@types`
 * package. The library is lazy-loaded (dynamic `import()`) so it stays out of
 * the core PWA bundle; these declarations type both the static and dynamic import.
 */

declare module '@citation-js/core' {
  export interface CiteOptions {
    /** Force the input parser, e.g. `'@bibtex/text'`. */
    forceType?: string;
    generateGraph?: boolean;
  }

  export class Cite {
    constructor(data?: unknown, options?: CiteOptions);
    /** Parsed entries as CSL-JSON objects (ids auto-filled when absent). */
    data: Array<Record<string, unknown>>;
  }
}

/** Side-effect plugin: registers the `@bibtex/*` input formats with core. */
declare module '@citation-js/plugin-bibtex';
