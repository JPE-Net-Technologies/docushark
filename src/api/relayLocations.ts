/**
 * Relay location registry — the location → relay-origin mapping that backs the
 * Cloud connect modal's location switcher.
 *
 * The relay origin for a given location differs per environment (localhost in
 * dev, the staging Fly app, the prod custom domain), so the primary region's
 * origin is injected at **build time** via `VITE_RELAY_BASE_URL` — mirroring
 * `VITE_CLOUD_BASE_URL` (see `relayConnection.ts`). A hosted build pairs with
 * its environment's relay; the OSS source keeps a generic `localhost` default so
 * no deployment origin lands in the public tree.
 *
 * Region-resolution is ultimately a server concern: the relay app-token response
 * already carries the workspace's region-resolved `relay_url`, which the session
 * adopts as authoritative (see `cloudAuth.ts` / `completeCloudSignIn.ts`). This
 * registry governs the *pre-sign-in default* the user sees + a self-host override.
 */

/**
 * Build-time relay origin for the primary region; `http://localhost:9876` for
 * OSS/dev. Injected per-environment in the editor build (docushark-web CI),
 * exactly like `VITE_CLOUD_BASE_URL`. Just an origin (not a secret).
 */
export const DEFAULT_RELAY_BASE_URL =
  import.meta.env.VITE_RELAY_BASE_URL ?? 'http://localhost:9876';

export interface RelayLocation {
  /** Region code, e.g. `yyz`. */
  id: string;
  /** Human label shown in the switcher, e.g. `Toronto, Canada`. */
  label: string;
  /** Relay REST origin for this location (e.g. `http://localhost:9876`). */
  relayUrl: string;
}

// Declare the location const first, then build the list + default from it — so
// DEFAULT_RELAY_LOCATION is `RelayLocation`, not `RelayLocation | undefined`
// (RELAY_LOCATIONS[0] would be `| undefined` under noUncheckedIndexedAccess).
//
// Only Toronto (`yyz`) is live today. ord/nrt/fra light up on demand; each will
// get its own `VITE_RELAY_BASE_URL_<region>` build var when it does (YAGNI now).
const TORONTO: RelayLocation = {
  id: 'yyz',
  label: 'Toronto, Canada',
  relayUrl: DEFAULT_RELAY_BASE_URL,
};

export const RELAY_LOCATIONS: RelayLocation[] = [TORONTO];

/** The location selected by default before the user picks one. */
export const DEFAULT_RELAY_LOCATION: RelayLocation = TORONTO;

/** Trim trailing slashes so `http://host/` and `http://host` compare equal. */
function normalizeOrigin(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The known location whose relay origin matches `url` (slash-normalized), or
 * `undefined` when none does — in which case the switcher shows "Custom" (a
 * self-host / Advanced-override URL).
 */
export function locationForUrl(url: string): RelayLocation | undefined {
  const target = normalizeOrigin(url);
  return RELAY_LOCATIONS.find((loc) => normalizeOrigin(loc.relayUrl) === target);
}
