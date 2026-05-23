/**
 * User Store
 *
 * Thin facade over `useConnectionStore.user`. Surfaces the legacy
 * `{ currentUser, isCurrentUserAdmin }` API that the rest of the
 * codebase reads from. Phase 20.3 Slice E.4: the Tauri-side login
 * path (`invoke('login')`) is gone; user identity now arrives via
 * the REST login wired through `UnifiedSyncProvider.loginWithCredentials`
 * (Slice E.2 Commit 3), which calls `useConnectionStore.setUser`.
 *
 * Kept rather than deleted so callsites (~6 files) don't all need to
 * be rewritten to consume connectionStore directly.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { useConnectionStore, type AuthenticatedUser } from './connectionStore';

/**
 * Shape exposed to consumers — same as the pre-E.4 `User` for the
 * fields anyone actually reads. `displayName` falls back to
 * `username` since the relay's `AuthenticatedUser` doesn't carry a
 * separate display name.
 */
export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: string | undefined;
}

interface UserState {
  currentUser: CurrentUser | null;
}

interface UserActions {
  /** Internal setter used by the connectionStore subscription. */
  _setFromConnection: (user: AuthenticatedUser | null) => void;
  /** True when the current user has the `admin` role. */
  isCurrentUserAdmin: () => boolean;
}

function mapUser(u: AuthenticatedUser | null): CurrentUser | null {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.username,
    role: u.role,
  };
}

export const useUserStore = create<UserState & UserActions>()((set, get) => ({
  currentUser: mapUser(useConnectionStore.getState().user),

  _setFromConnection: (user) => set({ currentUser: mapUser(user) }),

  isCurrentUserAdmin: () => get().currentUser?.role === 'admin',
}));

// Mirror connectionStore.user → userStore.currentUser whenever auth
// state changes. Subscribed once at module load.
useConnectionStore.subscribe((state) => {
  useUserStore.getState()._setFromConnection(state.user);
});

/**
 * React hook returning the current user. Same signature as the
 * pre-E.4 selector callsites used.
 */
export function useCurrentUser(): CurrentUser | null {
  return useUserStore((s) => s.currentUser);
}

/**
 * No-op kept so the import in `App.tsx` (or anywhere that called the
 * pre-E.4 boot helper) doesn't break. The connectionStore is now the
 * single source of truth for session presence; nothing to validate
 * at boot.
 */
export async function validateStoredSession(): Promise<boolean> {
  return useConnectionStore.getState().status === 'authenticated';
}

/** Stub to satisfy any lingering imports — does nothing. */
export function useUserStoreInit(): void {
  useEffect(() => {
    // No-op; subscription is set up at module load above.
  }, []);
}
