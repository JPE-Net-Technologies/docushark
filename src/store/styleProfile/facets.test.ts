/**
 * Every style facet applies each key it declares. The departures test checks
 * the keys a facet applies, so a facet that declared a key and then dropped it
 * went unseen there (found adding the label font, DSK-246).
 */
import { describe, expect, it } from 'vitest';
import { STYLE_FACETS } from './facets';

describe('style facets', () => {
  for (const facet of STYLE_FACETS) {
    it(`${facet.id} applies every key it declares`, () => {
      // Some facets check a field's type, so offer each key a string and a number.
      const applied = (sample: (key: string) => unknown) => {
        // A facet that writes `customProperties` merges into the shape's own.
        const shape = { id: 's', type: 'rectangle', customProperties: {} } as never;
        const out = facet.apply(Object.fromEntries(facet.keys.map((key) => [key, sample(key)])) as never, shape) as Record<
          string,
          unknown
        > & { customProperties?: Record<string, unknown> };
        return (key: string) => out[key] !== undefined || out.customProperties?.[key] !== undefined;
      };
      const asString = applied((key) => `value of ${key}`);
      const asNumber = applied(() => 1);
      expect(facet.keys.filter((key) => !asString(key) && !asNumber(key))).toEqual([]);
    });
  }
});
