/**
 * DocumentGroupStore
 *
 * Local-only document organisation. Each document can be assigned to a single
 * flat group (tag-like). Groups are user-defined with a name, optional accent
 * colour, and a user-controlled order. Assignments are keyed by document id so
 * they work uniformly for local, remote, and cached document records — no
 * changes to the document JSON schema are needed.
 *
 * Stale assignments (referencing documents that no longer exist) are harmless;
 * the browser UI prunes them lazily when rendering.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';

export interface DocumentGroup {
  id: string;
  name: string;
  color?: string;
  order: number;
  createdAt: number;
}

export interface DocumentGroupState {
  /** Group definitions keyed by group id. */
  groups: Record<string, DocumentGroup>;
  /** documentId -> groupId. Absence means "Ungrouped". */
  assignments: Record<string, string>;
}

export interface DocumentGroupActions {
  createGroup: (name: string, color?: string) => string;
  renameGroup: (id: string, name: string) => void;
  recolorGroup: (id: string, color: string | undefined) => void;
  reorderGroups: (orderedIds: string[]) => void;
  deleteGroup: (id: string) => void;
  assignDocument: (documentId: string, groupId: string | null) => void;
  assignMany: (documentIds: string[], groupId: string | null) => void;
  getGroupForDocument: (documentId: string) => DocumentGroup | undefined;
  /** Returns groups sorted by order asc. */
  listGroups: () => DocumentGroup[];
  reset: () => void;
}

const initialState: DocumentGroupState = {
  groups: {},
  assignments: {},
};

export const useDocumentGroupStore = create<DocumentGroupState & DocumentGroupActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      createGroup: (name, color) => {
        const trimmed = name.trim();
        if (!trimmed) return '';
        const id = nanoid();
        const { groups } = get();
        const maxOrder = Object.values(groups).reduce((m, g) => Math.max(m, g.order), -1);
        const group: DocumentGroup = {
          id,
          name: trimmed,
          order: maxOrder + 1,
          createdAt: Date.now(),
          ...(color !== undefined ? { color } : {}),
        };
        set({ groups: { ...groups, [id]: group } });
        return id;
      },

      renameGroup: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const { groups } = get();
        const existing = groups[id];
        if (!existing) return;
        set({ groups: { ...groups, [id]: { ...existing, name: trimmed } } });
      },

      recolorGroup: (id, color) => {
        const { groups } = get();
        const existing = groups[id];
        if (!existing) return;
        const next: DocumentGroup =
          color === undefined
            ? (() => {
                const { color: _drop, ...rest } = existing;
                return rest as DocumentGroup;
              })()
            : { ...existing, color };
        set({ groups: { ...groups, [id]: next } });
      },

      reorderGroups: (orderedIds) => {
        const { groups } = get();
        const next: Record<string, DocumentGroup> = { ...groups };
        orderedIds.forEach((id, index) => {
          const existing = next[id];
          if (existing) {
            next[id] = { ...existing, order: index };
          }
        });
        set({ groups: next });
      },

      deleteGroup: (id) => {
        const { groups, assignments } = get();
        if (!groups[id]) return;
        const nextGroups = { ...groups };
        delete nextGroups[id];
        const nextAssignments: Record<string, string> = {};
        for (const [docId, gid] of Object.entries(assignments)) {
          if (gid !== id) nextAssignments[docId] = gid;
        }
        set({ groups: nextGroups, assignments: nextAssignments });
      },

      assignDocument: (documentId, groupId) => {
        const { assignments, groups } = get();
        if (groupId === null) {
          if (!(documentId in assignments)) return;
          const next = { ...assignments };
          delete next[documentId];
          set({ assignments: next });
          return;
        }
        if (!groups[groupId]) return;
        if (assignments[documentId] === groupId) return;
        set({ assignments: { ...assignments, [documentId]: groupId } });
      },

      assignMany: (documentIds, groupId) => {
        const { assignments, groups } = get();
        if (groupId !== null && !groups[groupId]) return;
        const next = { ...assignments };
        for (const docId of documentIds) {
          if (groupId === null) {
            delete next[docId];
          } else {
            next[docId] = groupId;
          }
        }
        set({ assignments: next });
      },

      getGroupForDocument: (documentId) => {
        const { assignments, groups } = get();
        const gid = assignments[documentId];
        if (!gid) return undefined;
        return groups[gid];
      },

      listGroups: () => {
        const { groups } = get();
        return Object.values(groups).sort((a, b) => a.order - b.order);
      },

      reset: () => set(initialState),
    }),
    {
      name: 'docushark-document-groups',
      partialize: (state) => ({
        groups: state.groups,
        assignments: state.assignments,
      }),
    }
  )
);

/** Preset swatches for the group recolor picker. */
export const DOCUMENT_GROUP_SWATCHES: readonly string[] = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];
