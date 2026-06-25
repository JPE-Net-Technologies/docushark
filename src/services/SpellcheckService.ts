
type NSpellInstance = {
  correct(word: string): boolean;
  suggest(word: string): string[];
  add(word: string): void;
  remove(word: string): void;
};

let loadPromise: Promise<NSpellInstance | null> | null = null;
let instance: NSpellInstance | null = null;
const sessionAdded = new Set<string>();

async function fetchAsText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.text();
}

async function loadDictionary(): Promise<NSpellInstance | null> {
  if (instance) return instance;
  // Files are copied into /public/dictionaries/en/ at install time.
  const base = `${import.meta.env.BASE_URL ?? '/'}dictionaries/en`;
  try {
    const [aff, dic] = await Promise.all([
      fetchAsText(`${base}/en.aff`),
      fetchAsText(`${base}/en.dic`),
    ]);
    // Dynamically import nspell so it isn't bundled into the main chunk —
    // it loads alongside the dictionary on first spellcheck use.
    const { default: nspell } = await import('nspell');
    const sp = nspell(aff, dic) as NSpellInstance;
    for (const w of sessionAdded) sp.add(w);
    instance = sp;
    return sp;
  } catch (err) {
    // Surface the failure (was a silent console.warn) so a dictionary
    // regression is visible rather than spell-check just doing nothing.
    console.error(`[Spellcheck] Failed to load dictionary from ${base}:`, err);
    return null;
  }
}

export const SpellcheckService = {
  /** Start loading the dictionary (idempotent). Resolves when ready. */
  prepare(): Promise<NSpellInstance | null> {
    if (!loadPromise) loadPromise = loadDictionary();
    return loadPromise;
  },

  /** True only when the dictionary is loaded and the word is unknown. */
  isMisspelled(word: string): boolean {
    if (!instance) return false;
    if (sessionAdded.has(word.toLowerCase())) return false;
    return !instance.correct(word);
  },

  suggest(word: string, max = 5): string[] {
    if (!instance) return [];
    return instance.suggest(word).slice(0, max);
  },

  /** Adds a word for the lifetime of this app session. */
  addToSession(word: string): void {
    const w = word.trim();
    if (!w) return;
    sessionAdded.add(w.toLowerCase());
    if (instance) instance.add(w);
  },

  /** Treat each word in the list as already-known (e.g. document-level dictionary). */
  loadCustomWords(words: readonly string[]): void {
    for (const w of words) this.addToSession(w);
  },

  isReady(): boolean {
    return instance !== null;
  },
};
