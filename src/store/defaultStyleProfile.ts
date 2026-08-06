/**
 * Apply the user's configured default style profile to a newly-drawn shape.
 *
 * Settings → General has offered a **Default Style Profile** picker since long
 * before JP-301, with the hint "New shapes will be created with this style
 * applied". It never did: `defaultStyleProfileId` was written by the settings
 * UI, persisted, and included in backups — but no code ever read it back. The
 * control was a promise the app didn't keep.
 *
 * This is the missing reader. It routes through `getProfileUpdates`, the same
 * primitive the Style Profiles panel uses to apply a profile by hand, so a
 * shape created with a default looks exactly like one styled with that profile
 * afterwards — there is no second interpretation of what a profile means.
 */

import { useSettingsStore } from './settingsStore';
import { useStyleProfileStore, getProfileUpdates } from './styleProfileStore';
import type { Shape } from '../shapes/Shape';

/**
 * Return `shape` with the default profile merged in, or unchanged when no
 * default is configured (or the configured one has since been deleted — a
 * dangling id must degrade to "tool defaults", never throw).
 */
export function applyDefaultStyleProfile<T extends Shape>(shape: T): T {
  const profileId = useSettingsStore.getState().defaultStyleProfileId;
  if (!profileId) return shape;

  const profile = useStyleProfileStore.getState().getProfile(profileId);
  if (!profile) return shape;

  // The gated per-shape apply means a profile hands each shape only the fields
  // its own facets own — a rectangle default won't smear swimlane chrome onto
  // a connector.
  return { ...shape, ...getProfileUpdates(profile, shape) } as T;
}
