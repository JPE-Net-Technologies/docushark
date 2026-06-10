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

  /** Options for `Cite.format`. */
  export interface CiteFormatOptions {
    /** Output format, e.g. `'html'` or `'text'`. */
    format?: 'html' | 'text' | 'string';
    /** Registered template/style name, e.g. `'apa'`, `'mla'`. */
    template?: string;
    /** Locale, e.g. `'en-US'`. */
    lang?: string;
  }

  export class Cite {
    constructor(data?: unknown, options?: CiteOptions);
    /** Parsed entries as CSL-JSON objects (ids auto-filled when absent). */
    data: Array<Record<string, unknown>>;
    /** Render the data, e.g. `format('bibliography', { template: 'apa' })`. */
    format(type: 'bibliography' | 'citation', options?: CiteFormatOptions): string;
  }

  /** A `@citation-js/core` `util.Register`-style keyed registry. */
  export interface Register<T> {
    has(key: string): boolean;
    get(key: string): T;
    add(key: string, value: T): void;
  }

  /** The `@csl` plugin's config object (templates + locales registries). */
  export interface CslPluginConfig {
    templates: Register<string>;
    locales: Register<string>;
  }

  export const plugins: {
    config: {
      get(name: '@csl'): CslPluginConfig;
    };
  };
}

/** Side-effect plugin: registers the `@bibtex/*` input formats with core. */
declare module '@citation-js/plugin-bibtex';

/** Side-effect plugin: registers the `@csl` output format + style/locale config. */
declare module '@citation-js/plugin-csl';
