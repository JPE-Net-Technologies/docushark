/**
 * Workspace directory (JP-459) — the one place a user id becomes a person.
 *
 * ## Why this exists
 *
 * The relay has no display names to give. OIDC tokens don't carry a `username`,
 * so `handle_auth` surfaces `claims.sub` as one, and everything downstream that
 * stored or rendered a "name" ended up holding an account UUID — visible on
 * document cards, the People tooltips, "Last edited by", and share rows alike.
 *
 * Names belong to the control plane, which is the only thing that knows them and
 * the only thing that sees them change. So they are **resolved at display time,
 * never stored next to a grant**: a copy on the relay is stale the moment
 * someone renames themselves, and a cache nobody can invalidate is worse than no
 * cache at all.
 *
 * Two surfaces already fetched the roster ad hoc (the access panel and the Cloud
 * panel). This replaces both with a single cache rather than adding a third.
 *
 * ## What it is not
 *
 * Not an authorization input. A directory entry is a label; permission decisions
 * key on `userId` and only on `userId` (`permissions::resolve` in the relay does
 * the same). Keep it that way — a future self-hosted directory would be
 * populated from what connecting clients *claim* their name is, which is fine
 * for a label and unacceptable for a grant.
 */

import { create } from 'zustand';
import { webClient, type WorkspaceMember } from '../api/webClient';
import { activeWorkspaceId } from './activeWorkspace';

/** Shown when nobody can tell us who this is. Never a raw account id. */
export const UNKNOWN_PERSON = 'Unknown user';

interface WorkspaceDirectoryState {
  /** Members of `workspaceId`, by user id. Empty until loaded. */
  members: Record<string, WorkspaceMember>;
  /** Which workspace `members` describes — the cache key. */
  workspaceId: string | null;
  /** True once a fetch has completed for the current workspace. */
  loaded: boolean;
}

interface WorkspaceDirectoryActions {
  /**
   * Populate the directory for the active workspace, at most once.
   *
   * Idempotent and single-flight. The in-flight promise is memoised
   * *separately* from `loaded`, because `loaded` is only set after an `await`:
   * two callers on the same tick would both observe `false`, both fetch, and
   * both write. The same shape as `ensureSignInResumed` in
   * `src/api/resumeInterruptedSignIn.ts`, which needed it for the same reason.
   *
   * Failures are deliberately **not** cached. A control plane that blips for one
   * request must not leave every name in the session unresolvable; the
   * single-flight guard already stops a retry storm.
   */
  ensureLoaded: () => Promise<void>;
  /** Replace the directory wholesale (used by callers that already hold a roster). */
  setMembers: (members: WorkspaceMember[], workspaceId?: string) => void;
  /** Forget everything — sign-out, or a workspace switch. */
  clear: () => void;
}

let inFlight: Promise<void> | null = null;

export const useWorkspaceDirectory = create<
  WorkspaceDirectoryState & WorkspaceDirectoryActions
>()((set, get) => ({
  members: {},
  workspaceId: null,
  loaded: false,

  ensureLoaded: async () => {
    const ws = activeWorkspaceId();
    // A workspace switch invalidates rather than merging two rosters — ids are
    // unique per person, but membership and roles are not shared across
    // workspaces, so a stale entry would misreport both.
    if (get().workspaceId !== ws) {
      set({ members: {}, workspaceId: ws, loaded: false });
      inFlight = null;
    }
    if (get().loaded) return;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const members = await webClient.getWorkspaceMembers(ws);
        // Guard against a switch that landed mid-flight: the response describes
        // the workspace we asked about, not necessarily the current one.
        if (activeWorkspaceId() !== ws) return;
        get().setMembers(members, ws);
      } catch {
        // Self-hosted workspaces have no control plane, and a transient failure
        // is not a fact about the workspace. Leave `loaded` false so the next
        // caller retries; names fall back until then.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  setMembers: (members, workspaceId) => {
    const byId: Record<string, WorkspaceMember> = {};
    for (const m of members) byId[m.userId] = m;
    set({ members: byId, workspaceId: workspaceId ?? activeWorkspaceId(), loaded: true });
  },

  clear: () => {
    inFlight = null;
    set({ members: {}, workspaceId: null, loaded: false });
  },
}));

/**
 * A user id rendered as a person.
 *
 * Resolution order, most to least authoritative:
 *
 *   1. the roster's display name
 *   2. the roster's email — a real identifier when the name is blank
 *   3. `stored`, the name carried on the record, **unless it is the id itself**
 *   4. {@link UNKNOWN_PERSON}
 *
 * Step 4 is the point. The obvious last resort — "fall back to the id" — is a
 * no-op against the data we actually have: when the stored name *is* the id,
 * falling back to the id renders the identical UUID. A raw account id tells a
 * reader nothing, so it is never the label. Callers that need it for support can
 * put it in a `title`.
 */
export function resolvePersonName(userId: string | undefined, stored?: string): string {
  if (!userId) return stored?.trim() || UNKNOWN_PERSON;
  const member = useWorkspaceDirectory.getState().members[userId];
  const fromRoster = member?.displayName?.trim() || member?.email?.trim();
  if (fromRoster) return fromRoster;
  const trimmed = stored?.trim();
  if (trimmed && trimmed !== userId) return trimmed;
  return UNKNOWN_PERSON;
}

/** Reactive form of {@link resolvePersonName} for React components. */
export function usePersonName(userId: string | undefined, stored?: string): string {
  return useWorkspaceDirectory((s) => {
    if (!userId) return stored?.trim() || UNKNOWN_PERSON;
    const member = s.members[userId];
    const fromRoster = member?.displayName?.trim() || member?.email?.trim();
    if (fromRoster) return fromRoster;
    const trimmed = stored?.trim();
    if (trimmed && trimmed !== userId) return trimmed;
    return UNKNOWN_PERSON;
  });
}
