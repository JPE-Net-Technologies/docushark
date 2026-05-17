/**
 * Permission Store
 *
 * Provides permission checking for relay mode operations.
 * Computes permissions based on current user, ownership, and team role.
 */

import { create } from 'zustand';
import {
  PermissionAction,
  PermissionTarget,
  PermissionResult,
  Ownership,
  isAdmin,
  isOwner,
} from '../types/Auth';
import { useUserStore } from './userStore';
import { useConnectionStore, isRelayAuthenticated } from './connectionStore';
import { GroupShape } from '../shapes/Shape';
import { StyleProfile } from './styleProfileStore';

/**
 * Permission store state (computed, not persisted)
 */
interface PermissionState {
  /** Cache of recent permission checks */
  _cache: Map<string, PermissionResult>;
}

/**
 * Permission store actions
 */
interface PermissionActions {
  /**
   * Check if current user can perform an action on a target
   */
  canPerform: (
    action: PermissionAction,
    target: PermissionTarget,
    ownership?: Ownership | null
  ) => PermissionResult;

  /**
   * Check if current user can edit a document
   */
  canEditDocument: () => PermissionResult;

  /**
   * Check if current user can edit a group
   */
  canEditGroup: (group: GroupShape) => PermissionResult;

  /**
   * Check if current user can delete a group
   */
  canDeleteGroup: (group: GroupShape) => PermissionResult;

  /**
   * Check if current user can edit a style profile
   */
  canEditStyleProfile: (profile: StyleProfile) => PermissionResult;

  /**
   * Check if current user can delete a style profile
   */
  canDeleteStyleProfile: (profile: StyleProfile) => PermissionResult;

  /**
   * Check if current user can manage users (admin only)
   */
  canManageUsers: () => PermissionResult;

  /**
   * Check if current user can create shapes
   */
  canCreateShapes: () => PermissionResult;

  /**
   * Check if current user can delete shapes
   */
  canDeleteShapes: () => PermissionResult;

  /**
   * Clear permission cache (call when user/team state changes)
   */
  clearCache: () => void;
}

/**
 * Permission store for authorization checks.
 *
 * This store is computed from userStore and teamStore state.
 * All permission checks follow these rules:
 *
 * 1. In offline mode: All actions allowed (single user)
 * 2. In relay mode:
 *    - Documents: Owned by SYSTEM, all users can edit
 *    - Groups: Can be owned by users, owner can lock
 *    - Style Profiles: Can be owned by users, owner can lock
 *    - User management: Admin only
 */
export const usePermissionStore = create<PermissionState & PermissionActions>()(
  (set, get) => ({
    _cache: new Map(),

    canPerform: (
      action: PermissionAction,
      target: PermissionTarget,
      ownership?: Ownership | null
    ): PermissionResult => {
      // In offline mode, everything is allowed
      if (!isRelayAuthenticated()) {
        return { allowed: true };
      }

      const currentUser = useUserStore.getState().currentUser;

      // Not logged in = no permissions in relay mode
      if (!currentUser) {
        return {
          allowed: false,
          reason: 'You must be logged in to perform this action',
        };
      }

      // Admins can do everything
      if (isAdmin(currentUser)) {
        return { allowed: true };
      }

      // User management is admin-only
      if (target === 'user' && action === 'manage') {
        return {
          allowed: false,
          reason: 'Only administrators can manage users',
        };
      }

      // Check ownership for owned entities
      if (ownership) {
        // SYSTEM-owned (ownerId === null) = everyone can access
        if (ownership.ownerId === null) {
          return { allowed: true };
        }

        // Owner-locked = only owner can modify
        if (ownership.locked && !isOwner(currentUser.id, ownership)) {
          return {
            allowed: false,
            reason: 'This item is locked by its owner',
          };
        }

        // Delete action requires ownership
        if (action === 'delete' && !isOwner(currentUser.id, ownership)) {
          return {
            allowed: false,
            reason: 'Only the owner can delete this item',
          };
        }
      }

      // Default: allow
      return { allowed: true };
    },

    canEditDocument: (): PermissionResult => {
      // Documents are SYSTEM-owned, all relay members can edit
      if (!isRelayAuthenticated()) {
        return { allowed: true };
      }

      const currentUser = useUserStore.getState().currentUser;
      if (!currentUser) {
        return {
          allowed: false,
          reason: 'You must be logged in to edit documents',
        };
      }

      return { allowed: true };
    },

    canEditGroup: (group: GroupShape): PermissionResult => {
      const ownership: Ownership | null = group.ownerId !== undefined
        ? {
            ownerId: group.ownerId,
            locked: group.ownerLocked,
          }
        : null;

      return get().canPerform('edit', 'group', ownership);
    },

    canDeleteGroup: (group: GroupShape): PermissionResult => {
      const ownership: Ownership | null = group.ownerId !== undefined
        ? {
            ownerId: group.ownerId,
            locked: group.ownerLocked,
          }
        : null;

      return get().canPerform('delete', 'group', ownership);
    },

    canEditStyleProfile: (profile: StyleProfile): PermissionResult => {
      // Built-in profiles can't be edited
      if (profile.id.startsWith('default-')) {
        return {
          allowed: false,
          reason: 'Built-in profiles cannot be edited',
        };
      }

      const ownership: Ownership | null = profile.ownerId !== undefined
        ? {
            ownerId: profile.ownerId,
            locked: profile.ownerLocked,
          }
        : null;

      return get().canPerform('edit', 'styleProfile', ownership);
    },

    canDeleteStyleProfile: (profile: StyleProfile): PermissionResult => {
      // Built-in profiles can't be deleted
      if (profile.id.startsWith('default-')) {
        return {
          allowed: false,
          reason: 'Built-in profiles cannot be deleted',
        };
      }

      const ownership: Ownership | null = profile.ownerId !== undefined
        ? {
            ownerId: profile.ownerId,
            locked: profile.ownerLocked,
          }
        : null;

      return get().canPerform('delete', 'styleProfile', ownership);
    },

    canManageUsers: (): PermissionResult => {
      return get().canPerform('manage', 'user');
    },

    canCreateShapes: (): PermissionResult => {
      // In relay mode, need to be logged in
      if (!isRelayAuthenticated()) {
        return { allowed: true };
      }

      const currentUser = useUserStore.getState().currentUser;
      if (!currentUser) {
        return {
          allowed: false,
          reason: 'You must be logged in to create shapes',
        };
      }

      return { allowed: true };
    },

    canDeleteShapes: (): PermissionResult => {
      // Same as create - need to be logged in for relay mode
      return get().canCreateShapes();
    },

    clearCache: () => {
      set({ _cache: new Map() });
    },
  })
);

/**
 * Helper hook for checking if an action is allowed
 * Returns just the boolean for simpler conditional checks
 */
export function useCanPerform(
  action: PermissionAction,
  target: PermissionTarget,
  ownership?: Ownership | null
): boolean {
  const { canPerform } = usePermissionStore();
  return canPerform(action, target, ownership).allowed;
}

/**
 * Subscribe to user/team store changes to clear permission cache
 */
useUserStore.subscribe(() => {
  usePermissionStore.getState().clearCache();
});

useConnectionStore.subscribe(() => {
  usePermissionStore.getState().clearCache();
});
