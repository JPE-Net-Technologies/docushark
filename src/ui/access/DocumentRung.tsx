/**
 * Document rung of the access ladder (JP-456) — the owner plus the people
 * explicitly given access to THIS document.
 *
 * Ported from `DocumentPermissionsDialog`. Behaviour preserved: pick from the
 * workspace roster, set view/edit, revoke, transfer ownership, and flag shares
 * held by people who have since left the workspace. Two things change:
 *
 *  - **Saving is explicit, and says so.** The old dialog mutated a local list
 *    and only pushed on "Save Changes", which is easy to miss on the way out;
 *    the pending-change count is now stated next to the button.
 *  - **Provenance is shown.** A row says whether access comes from ownership,
 *    from being a workspace owner/admin (who hold owner rights on every
 *    document), or from a direct share — the question the split UI never answered.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useUserStore } from '../../store/userStore';
import { useRelayDocumentStore } from '../../store/relayDocumentStore';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { confirmDialog } from '../confirm/confirmStore';
import { RichSelect, type RichSelectItem } from '../components/RichSelect';
import { InitialsAvatar } from '../components/InitialsAvatar';
import { RoleBadge } from '../components/RoleBadge';
import type { WorkspaceMember } from '../../api/webClient';
import type { Permission, RemoteDocument } from '../../types/DocumentRegistry';
import type { DocumentShare } from '../../types/Document';

type SharePermission = 'view' | 'edit' | 'none';

const PERMISSION_ITEMS: RichSelectItem<SharePermission>[] = [
  { value: 'edit', label: 'Can edit' },
  { value: 'view', label: 'Can view' },
  { value: 'none', label: 'Remove access' },
];

const ADD_PERMISSION_ITEMS: RichSelectItem<'view' | 'edit'>[] = [
  { value: 'view', label: 'Can view' },
  { value: 'edit', label: 'Can edit' },
];

interface ShareRow {
  userId: string;
  username: string;
  permission: SharePermission;
}

export interface DocumentRungProps {
  documentId: string;
  record: RemoteDocument;
  roster: WorkspaceMember[];
}

export function DocumentRung({ documentId, record, roster }: DocumentRungProps) {
  const currentUser = useUserStore((s) => s.currentUser);
  const updateRecord = useDocumentRegistry((s) => s.updateRecord);
  const updateDocumentShares = useRelayDocumentStore((s) => s.updateDocumentShares);
  const transferDocumentOwnership = useRelayDocumentStore((s) => s.transferDocumentOwnership);
  const metadata = useRelayDocumentStore((s) => s.relayDocuments[documentId]);

  const [shares, setShares] = useState<ShareRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState('');
  const [addPermission, setAddPermission] = useState<'view' | 'edit'>('view');

  // Seed from server state. Owner and self are represented separately (owner as
  // its own row, self as "You"), so they're excluded from the editable list.
  useEffect(() => {
    const existing: DocumentShare[] = metadata?.sharedWith ?? [];
    setShares(
      existing
        .filter((s) => s.userId !== record.ownerId && s.userId !== currentUser?.id)
        .map((s) => ({ userId: s.userId, username: s.userName, permission: s.permission })),
    );
    setDirty(false);
  }, [metadata, record.ownerId, currentUser?.id]);

  const rosterIds = useMemo(() => new Set(roster.map((m) => m.userId)), [roster]);
  /** A share held by someone no longer in the workspace — an orphaned grant. */
  const isFormerMember = useCallback(
    (userId: string) => roster.length > 0 && !rosterIds.has(userId),
    [roster.length, rosterIds],
  );

  /**
   * Workspace owners hold owner rights on EVERY document in the workspace —
   * `get_user_permission` returns Owner for `wsp[].role == "owner"` before it
   * ever looks at shares. That's the inheritance the ladder exists to show.
   */
  const inheritedOwners = useMemo(
    () => roster.filter((m) => m.role === 'owner' && m.userId !== record.ownerId),
    [roster, record.ownerId],
  );

  const addable = useMemo(() => {
    const taken = new Set(shares.map((s) => s.userId));
    return roster.filter(
      (m) =>
        m.userId !== record.ownerId &&
        !taken.has(m.userId) &&
        !inheritedOwners.some((o) => o.userId === m.userId),
    );
  }, [roster, shares, record.ownerId, inheritedOwners]);

  const pendingCount = useMemo(() => {
    const original = new Map(
      (metadata?.sharedWith ?? []).map((s) => [s.userId, s.permission as SharePermission]),
    );
    let n = 0;
    for (const row of shares) {
      if (original.get(row.userId) !== row.permission) n += 1;
    }
    return n;
  }, [shares, metadata]);

  const setPermission = useCallback((userId: string, permission: SharePermission) => {
    setShares((prev) => prev.map((s) => (s.userId === userId ? { ...s, permission } : s)));
    setDirty(true);
    setError(null);
    setSaved(null);
  }, []);

  const handleAdd = useCallback(() => {
    const member = roster.find((m) => m.userId === addUserId);
    if (!member || shares.some((s) => s.userId === member.userId)) return;
    setShares((prev) => [
      ...prev,
      { userId: member.userId, username: member.displayName, permission: addPermission },
    ]);
    setDirty(true);
    setError(null);
    setSaved(null);
    setAddUserId('');
    setAddPermission('view');
  }, [roster, addUserId, addPermission, shares]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const next = shares
        .filter((s) => s.permission !== 'none')
        .map((s) => ({ userId: s.userId, userName: s.username, permission: s.permission }));
      await updateDocumentShares(documentId, next);
      setSaved(`Saved — ${next.length} ${next.length === 1 ? 'person has' : 'people have'} access`);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save access');
    } finally {
      setSaving(false);
    }
  }, [shares, documentId, updateDocumentShares]);

  const handleTransfer = useCallback(
    async (row: ShareRow) => {
      const ok = await confirmDialog({
        title: `Make ${row.username} the owner?`,
        message: 'They become this document’s owner immediately.',
        details: 'You lose owner rights and become an editor. This cannot be undone.',
        confirmLabel: 'Transfer ownership',
        danger: true,
      });
      if (!ok) return;
      setSaving(true);
      setError(null);
      try {
        await transferDocumentOwnership(documentId, row.userId, row.username);
        updateRecord(documentId, {
          permission: 'editor' as Permission,
          ownerId: row.userId,
          ownerName: row.username,
        });
        setSaved(`${row.username} now owns this document`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not transfer ownership');
      } finally {
        setSaving(false);
      }
    },
    [documentId, transferDocumentOwnership, updateRecord],
  );

  const canManage = record.permission === 'owner';

  return (
    <div className="access-rung__content">
      <ul className="access-people">
        <li className="access-person">
          <InitialsAvatar name={record.ownerName || 'Owner'} />
          <span className="access-person__id">
            <span className="access-person__name">
              {record.ownerName || record.ownerId || 'Unknown'}
              {record.ownerId === currentUser?.id ? (
                <span className="access-person__you">You</span>
              ) : null}
            </span>
          </span>
          <RoleBadge role="owner" />
        </li>

        {inheritedOwners.map((m) => (
          <li key={m.userId} className="access-person">
            <InitialsAvatar name={m.displayName} />
            <span className="access-person__id">
              <span className="access-person__name">{m.displayName}</span>
              {m.email ? <span className="access-person__sub">{m.email}</span> : null}
            </span>
            {/* The ladder's whole point: say WHERE this access comes from. */}
            <span className="access-via">via workspace</span>
          </li>
        ))}

        {shares.map((row) => (
          <li
            key={row.userId}
            className={`access-person${row.permission === 'none' ? ' access-person--revoked' : ''}`}
          >
            <InitialsAvatar name={row.username} />
            <span className="access-person__id">
              <span className="access-person__name">
                {row.username}
                {isFormerMember(row.userId) ? (
                  <span className="access-person__flag" title="No longer in this workspace">
                    Former member
                  </span>
                ) : null}
              </span>
            </span>
            <span className="access-via access-via--direct">shared directly</span>
            {canManage ? (
              <RichSelect
                value={row.permission}
                onChange={(p) => setPermission(row.userId, p)}
                items={PERMISSION_ITEMS}
                ariaLabel={`Access for ${row.username}`}
                minWidth={128}
              />
            ) : (
              <RoleBadge role={row.permission === 'edit' ? 'edit' : 'view'} />
            )}
            {canManage && row.permission === 'edit' ? (
              <button
                type="button"
                className="access-panel__btn access-panel__btn--compact"
                onClick={() => void handleTransfer(row)}
                disabled={saving}
              >
                Make owner
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {canManage ? (
        <>
          <div className="access-add">
            <RichSelect
              value={addUserId}
              onChange={setAddUserId}
              items={[
                { value: '', label: addable.length ? 'Add someone…' : 'Nobody left to add' },
                ...addable.map((m) => ({ value: m.userId, label: m.displayName })),
              ]}
              ariaLabel="Add a person"
              minWidth={180}
            />
            <RichSelect
              value={addPermission}
              onChange={setAddPermission}
              items={ADD_PERMISSION_ITEMS}
              ariaLabel="Access level"
              minWidth={110}
            />
            <button
              type="button"
              className="access-panel__btn"
              onClick={handleAdd}
              disabled={!addUserId}
            >
              Add
            </button>
          </div>

          <div className="access-save">
            <button
              type="button"
              className="access-panel__btn access-panel__btn--primary"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
            >
              {saving ? (
                <Loader2 size={14} className="access-panel__spin" aria-hidden="true" />
              ) : null}
              {dirty ? `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}` : 'Saved'}
            </button>
            {/* Stated, not implied: the old dialog let people walk away from
                unsaved permission edits with no signal at all. */}
            {dirty ? (
              <span className="access-save__note">Nothing changes until you save.</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="access-panel__hint">Only the document’s owner can change who has access.</p>
      )}

      {error ? (
        <p className="access-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="access-panel__ok" role="status">
          {saved}
        </p>
      ) : null}
    </div>
  );
}

export default DocumentRung;
