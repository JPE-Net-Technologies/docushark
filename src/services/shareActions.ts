/**
 * Sharing from the editor (DSK-257): the Share group's commands.
 *
 * Until now the open document could only be shared from Documents (a card's
 * ⋯ menu → Manage access). These commands put sharing where the writing is:
 * the top bar's Share menu, a Share group in Tools, and the palette. Export to
 * PDF joins them from the core catalogue (`file.exportPdf`).
 *
 * A contributed source, as the integration actions are: the registry is
 * engine-level and must not reach into the access panel or the archive code.
 */

import { Download, Globe, Users } from 'lucide-react';
import { registerCommandSource, type Command } from '../engine/CommandRegistry';
import { relaySessionUsable } from '../store/connectionStore';
import { getActiveDocumentRecord, isActiveDocReadOnly } from '../store/documentRegistry';
import { useNotificationStore } from '../store/notificationStore';
import { usePersistenceStore } from '../store/persistenceStore';
import { useUserStore } from '../store/userStore';
import { exportAndDownloadDocumentArchive } from '../storage/DocumentArchiveService';
import { openAccessPanel } from '../ui/access/accessPanelStore';

/** A workspace owner (or the relay's legacy admin) manages every document's access. */
function managesWorkspace(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Why the open document can't be shared with people now. */
export type ShareBlock = 'noDocument' | 'local' | 'offline' | 'external' | 'signedOut' | 'notOwner';

/**
 * Whether the open document can be shared with people, or why not. The same
 * rule Documents applies to Manage access: a workspace document, a usable
 * session, and its owner or a workspace owner.
 */
export function shareBlock(): ShareBlock | null {
  const record = getActiveDocumentRecord();
  if (!record) return 'noDocument';
  if (record.type === 'local') return 'local';
  if (record.type === 'external') return 'external';
  if (!relaySessionUsable()) return 'signedOut';
  if (record.type === 'cached') return 'offline';
  if (record.permission !== 'owner' && !managesWorkspace(useUserStore.getState().currentUser?.role)) return 'notOwner';
  return null;
}

/** What the Share menu says when the document can't be shared with people. */
export const SHARE_BLOCK_REASONS: Readonly<Record<ShareBlock, string>> = {
  noDocument: 'Open a document to share it.',
  local:
    'This document is only on this device. To share it, move it to your workspace: in Documents, open its ⋯ menu and choose Move to Cloud.',
  offline: 'Connect to your workspace to share this document.',
  external: 'This document can’t be shared from here.',
  signedOut: 'Sign in to your workspace to share this document.',
  notOwner: 'Only the document’s owner can share it.',
};

function openDocumentId(): string | null {
  return usePersistenceStore.getState().currentDocumentId;
}

/** Save the open document, then download it as a `.docushark` file with its images and files. */
export async function downloadCopy(): Promise<void> {
  const id = openDocumentId();
  if (!id) return;
  // The copy is built from the saved document, so the latest edits go in
  // first. A view-only document has none of its own to save.
  if (!isActiveDocReadOnly()) usePersistenceStore.getState().saveDocument();
  try {
    await exportAndDownloadDocumentArchive(id);
  } catch (error) {
    console.error('[share] Download a copy failed:', error);
    useNotificationStore.getState().error('Couldn’t download a copy of this document.');
  }
}

const SHARE_SURFACES = ['palette', 'tools', 'shareMenu'] as const;

export function currentShareActions(): Command[] {
  const canShare = () => shareBlock() === null;
  return [
    {
      id: 'share.people',
      label: 'Share with people…',
      category: 'Share',
      icon: Users,
      surfaces: SHARE_SURFACES,
      canExecute: canShare,
      execute: () => openAccessPanel({ scope: 'document', documentId: openDocumentId() }),
    },
    {
      id: 'share.publish',
      label: 'Publish a link…',
      category: 'Share',
      icon: Globe,
      surfaces: SHARE_SURFACES,
      canExecute: canShare,
      execute: () => openAccessPanel({ scope: 'document', documentId: openDocumentId(), focus: 'publish' }),
    },
    {
      id: 'share.downloadCopy',
      label: 'Download a copy',
      category: 'Share',
      icon: Download,
      surfaces: SHARE_SURFACES,
      canExecute: () => openDocumentId() !== null,
      execute: () => void downloadCopy(),
    },
  ];
}

/** Register the source. Called once from app startup; safe to call again. */
export function registerShareActions(): void {
  registerCommandSource('share', currentShareActions);
}
