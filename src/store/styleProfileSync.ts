/**
 * styleProfileSync — the seam between the client `styleProfileStore`
 * (canonical, network-free) and the relay's per-workspace style-profile
 * registry (JP-301).
 *
 * Close sibling of `collectionSync.ts`, and deliberately so: the two solve the
 * same problem (a client-authoritative set that must survive two clients
 * writing at once) and share its shape — a serialized read-modify-write against
 * the relay's current set, rebased once on a version conflict. Keeping them
 * parallel rather than extracting a shared helper is a considered call: the
 * collection path is durability-critical and already proven, and refactoring it
 * underneath a new feature would trade a known-good implementation for a
 * speculative one. Extract when a third registry appears.
 *
 * Two things differ from collections, and both come from profiles being
 * **metered storage** rather than free metadata:
 *
 *  - **A push can be legitimately refused** (507, over quota). That is not a
 *    transient miss to swallow — the user's styles did not save and they need
 *    to know, so it surfaces as a notification.
 *  - **Sync is manual, not automatic** (the JP-301 constraint: no sync surface).
 *    Profiles push when the user changes a workspace-scoped one and pull on
 *    sign-in or an explicit Refresh. There is no background reconciler.
 */

import { RelayError, VersionConflictError, type RelayStyleProfileDef } from '../api/relayClient';
import {
  useStyleProfileStore,
  type StyleProfile,
} from './styleProfileStore';
import { useNotificationStore } from './notificationStore';
import { getDocProvider, isCloudSignedIn } from './relayDocumentStore';

/** Workspace profile ids created locally whose push hasn't been confirmed yet.
 *  A pull that races (or follows a failed push) must not treat "absent from the
 *  relay" as "deleted" for these — same guard as `collectionSync`'s
 *  `unconfirmedWorkspaceDefIds` (JP-424), and for the same reason: without it a
 *  brand-new profile is erased by the next refresh. */
let unconfirmedIds = new Set<string>();

/** Whether this session has already pulled the workspace's registry. Profiles
 *  hydrate **once** per workspace connection, not on every document-list
 *  refresh: the registry is the user's own working set, and re-pulling it
 *  underneath them mid-session is how a local edit gets silently reverted.
 *  Everything after the first pull is an explicit Refresh. */
let hydrated = false;

/** Forget the connected workspace's sync state. Called when leaving a workspace
 *  so a stale set can't gate the next workspace's pushes, and so the next
 *  workspace hydrates fresh rather than inheriting this one's. */
export function resetStyleProfileSync(): void {
  unconfirmedIds = new Set();
  hydrated = false;
}

/** Pull the registry once per workspace connection. Safe to call on every
 *  document-list fetch — it no-ops after the first success. */
export async function ensureStyleProfilesHydrated(): Promise<void> {
  if (hydrated) return;
  if (!isCloudSignedIn()) return;
  hydrated = true;
  try {
    await pullStyleProfiles();
  } catch (e) {
    hydrated = false; // let the next list fetch retry
    console.warn('[styleProfileSync] initial hydrate failed:', e);
  }
}

/** Serialize registry read-modify-writes so concurrent mutations can't
 *  interleave their GET/PUT and clobber each other. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Client profile → wire shape. Drops `scope`, which is a client-side concept:
 *  everything in the registry is by definition workspace-scoped. */
export function toRelayDef(profile: StyleProfile): RelayStyleProfileDef {
  return {
    id: profile.id,
    name: profile.name,
    properties: profile.properties,
    createdAt: profile.createdAt,
    ...(profile.favorite ? { favorite: true } : {}),
    ...(profile.collectionIds && profile.collectionIds.length > 0
      ? { collectionIds: profile.collectionIds }
      : {}),
  };
}

/** Wire shape → client profile, stamped back to `workspace` scope. */
export function fromRelayDef(def: RelayStyleProfileDef): StyleProfile {
  return {
    id: def.id,
    name: def.name,
    properties: def.properties,
    createdAt: def.createdAt,
    favorite: def.favorite === true,
    scope: 'workspace',
    ...(def.collectionIds && def.collectionIds.length > 0
      ? { collectionIds: def.collectionIds }
      : {}),
  };
}

/** The workspace-scoped slice of the local store — what the registry should hold. */
function localWorkspaceProfiles(): StyleProfile[] {
  return useStyleProfileStore
    .getState()
    .profiles.filter((p) => p.scope === 'workspace' && !p.id.startsWith('default-'));
}

/** One GET → transform → conditional PUT cycle. Sends the fetched registry
 *  version as `expectedVersion` and, on success, confirms pending created ids. */
async function pushOnce(
  getStyleProfiles: () => Promise<{ profiles: RelayStyleProfileDef[]; version?: number }>,
  setStyleProfiles: (defs: RelayStyleProfileDef[], expectedVersion?: number) => Promise<void>,
  transform: (defs: RelayStyleProfileDef[]) => RelayStyleProfileDef[],
): Promise<void> {
  const { profiles: current, version } = await getStyleProfiles();
  const next = transform(current);
  await setStyleProfiles(next, version);
  for (const def of next) unconfirmedIds.delete(def.id);
}

/**
 * Read the workspace's registry, apply `transform`, write it back. Serialized +
 * auth-gated. A version conflict (another client wrote between our GET and PUT)
 * is rebased exactly once; a second conflict is left for the next pull to heal.
 *
 * A quota refusal is re-raised to the caller rather than swallowed — see the
 * module note.
 */
function mutateRegistry(
  transform: (defs: RelayStyleProfileDef[]) => RelayStyleProfileDef[],
): Promise<void> {
  return serialize(async () => {
    const provider = getDocProvider();
    const getStyleProfiles = provider?.getStyleProfiles?.bind(provider);
    const setStyleProfiles = provider?.setStyleProfiles?.bind(provider);
    if (!getStyleProfiles || !setStyleProfiles) return;
    if (!isCloudSignedIn()) return;
    try {
      await pushOnce(getStyleProfiles, setStyleProfiles, transform);
    } catch (e) {
      if (e instanceof VersionConflictError) {
        try {
          await pushOnce(getStyleProfiles, setStyleProfiles, transform);
          return;
        } catch (retryError) {
          reportPushFailure(retryError);
          return;
        }
      }
      reportPushFailure(e);
    }
  });
}

/**
 * Surface a failed push. A 507 means the workspace is out of storage and the
 * styles genuinely did not save — the user has to be told, or they will believe
 * work is backed up when it isn't. Anything else stays best-effort: it is
 * almost always a dropped connection, and the next push or pull heals it.
 */
function reportPushFailure(error: unknown): void {
  if (error instanceof RelayError && error.status === 507) {
    useNotificationStore
      .getState()
      .error(
        "Style profiles didn't sync — your workspace is out of storage. " +
          'Free up space, then try again.',
      );
    return;
  }
  console.warn('[styleProfileSync] push failed (best-effort):', error);
}

/**
 * Push the local workspace-scoped set to the relay. The registry is replaced
 * with exactly the client's workspace slice, which is safe because — unlike
 * collections, where one relay origin serves every Cloud workspace — the store
 * only ever holds profiles for the workspace it is signed into, and the relay
 * scopes the write to the token's workspace regardless.
 */
export function pushStyleProfiles(): Promise<void> {
  const local = localWorkspaceProfiles();
  for (const p of local) unconfirmedIds.add(p.id);
  return mutateRegistry(() => local.map(toRelayDef));
}

/**
 * Pull the workspace's registry and hydrate it into the store, replacing the
 * workspace-scoped slice and leaving local profiles untouched. Ids whose push
 * hasn't been confirmed are preserved so a refresh can't erase a profile whose
 * create is still in flight.
 *
 * Returns the number of workspace profiles now present, so a caller driving an
 * explicit Refresh can report what happened.
 */
export function pullStyleProfiles(): Promise<number> {
  return serialize(async () => {
    const provider = getDocProvider();
    const getStyleProfiles = provider?.getStyleProfiles?.bind(provider);
    if (!getStyleProfiles) return 0;
    if (!isCloudSignedIn()) return 0;

    let remote: RelayStyleProfileDef[];
    try {
      ({ profiles: remote } = await getStyleProfiles());
    } catch (e) {
      console.warn('[styleProfileSync] pull failed (best-effort):', e);
      return 0;
    }

    const remoteIds = new Set(remote.map((d) => d.id));
    const unconfirmed = localWorkspaceProfiles().filter(
      (p) => unconfirmedIds.has(p.id) && !remoteIds.has(p.id),
    );
    const hydrated = [...remote.map(fromRelayDef), ...unconfirmed];
    useStyleProfileStore.getState().hydrateWorkspaceProfiles(hydrated);
    return hydrated.length;
  });
}

/**
 * Promote a local profile to the workspace (or demote it back), then reconcile
 * the registry. Demotion removes it from the workspace for *every* device, which
 * is why the caller is expected to confirm first.
 */
export async function setStyleProfileScopeSynced(
  id: string,
  scope: 'local' | 'workspace',
): Promise<void> {
  useStyleProfileStore.getState().setProfileScope(id, scope);
  await pushStyleProfiles();
}
