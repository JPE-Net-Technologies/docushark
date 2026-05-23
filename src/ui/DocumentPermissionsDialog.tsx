/**
 * DocumentPermissionsDialog component
 *
 * Modal dialog for managing document ownership and access permissions.
 * Only document owners can access this dialog.
 *
 * Phase 20.3 Slice E.5: dropped the host-mode member picker (the
 * relay no longer exposes a renderer-side user roster). Users now
 * add shares by typing the relay user ID + display name; server-side
 * `POST /api/docs/:id/share` rejects unknown IDs and the error
 * surfaces inline.
 */

import { useState, useCallback, useEffect, useMemo, FormEvent } from 'react';
import { useUserStore } from '../store/userStore';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import type { Permission, RemoteDocument } from '../types/DocumentRegistry';
import type { DocumentShare } from '../types/Document';
import './DocumentPermissionsDialog.css';

interface DocumentPermissionsDialogProps {
  /** Document ID to manage */
  documentId: string;
  /** Close callback */
  onClose: () => void;
}

interface MemberAccess {
  userId: string;
  username: string;
  permission: 'view' | 'edit' | 'none';
}

export function DocumentPermissionsDialog({ documentId, onClose }: DocumentPermissionsDialogProps) {
  const entries = useDocumentRegistry((s) => s.entries);
  const updateRecord = useDocumentRegistry((s) => s.updateRecord);
  const currentUser = useUserStore((s) => s.currentUser);
  const updateDocumentShares = useRelayDocumentStore((s) => s.updateDocumentShares);
  const transferDocumentOwnership = useRelayDocumentStore((s) => s.transferDocumentOwnership);
  const relayDocuments = useRelayDocumentStore((s) => s.relayDocuments);

  const [accessList, setAccessList] = useState<MemberAccess[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [transferToUserId, setTransferToUserId] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Inline "Add user" form state.
  const [newUserId, setNewUserId] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newPermission, setNewPermission] = useState<'view' | 'edit'>('view');

  const entry = entries[documentId];
  const record = entry?.record as RemoteDocument | undefined;

  const docMetadata = relayDocuments[documentId];

  // Build access list from existing shares only. With no local member
  // roster, the only knowable users are those already shared with.
  useEffect(() => {
    if (!record || record.type !== 'remote') return;

    const existingShares: DocumentShare[] = docMetadata?.sharedWith ?? [];
    const list: MemberAccess[] = existingShares
      .filter(
        (share) => share.userId !== currentUser?.id && share.userId !== record.ownerId,
      )
      .map((share) => ({
        userId: share.userId,
        username: share.userName,
        permission: share.permission,
      }));

    setAccessList(list);
    setHasChanges(false);
  }, [currentUser?.id, record, docMetadata]);

  const accessCounts = useMemo(() => {
    const editors = accessList.filter((m) => m.permission === 'edit').length;
    const viewers = accessList.filter((m) => m.permission === 'view').length;
    return { editors, viewers, total: editors + viewers };
  }, [accessList]);

  const handlePermissionChange = useCallback(
    (userId: string, permission: 'view' | 'edit' | 'none') => {
      setAccessList((prev) => prev.map((m) => (m.userId === userId ? { ...m, permission } : m)));
      setHasChanges(true);
      setError(null);
      setSuccessMessage(null);
    },
    [],
  );

  const handleRevokeAll = useCallback(() => {
    setAccessList((prev) => prev.map((m) => ({ ...m, permission: 'none' })));
    setHasChanges(true);
  }, []);

  const handleAddUser = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const id = newUserId.trim();
      const name = newUserName.trim();
      if (!id || !name) return;
      if (accessList.some((m) => m.userId === id)) {
        setError(`User ${id} is already in the access list`);
        return;
      }
      setAccessList((prev) => [...prev, { userId: id, username: name, permission: newPermission }]);
      setHasChanges(true);
      setError(null);
      setSuccessMessage(null);
      setNewUserId('');
      setNewUserName('');
      setNewPermission('view');
    },
    [newUserId, newUserName, newPermission, accessList],
  );

  const handleTransferOwnership = useCallback((userId: string) => {
    setTransferToUserId(userId);
  }, []);

  const handleConfirmTransfer = useCallback(async () => {
    if (!transferToUserId || !record) return;

    setIsSaving(true);
    setError(null);

    try {
      const newOwner = accessList.find((m) => m.userId === transferToUserId);
      if (newOwner) {
        await transferDocumentOwnership(documentId, newOwner.userId, newOwner.username);
        updateRecord(documentId, {
          permission: 'editor' as Permission,
          ownerName: newOwner.username,
          ownerId: newOwner.userId,
        });
        setSuccessMessage(`Ownership transferred to ${newOwner.username}`);
      }
      setTransferToUserId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transfer ownership');
    } finally {
      setIsSaving(false);
    }
  }, [transferToUserId, record, accessList, documentId, transferDocumentOwnership, updateRecord]);

  const handleSave = useCallback(async () => {
    if (!record) return;

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const shares = accessList
        .filter((m) => m.permission !== 'none')
        .map((m) => ({
          userId: m.userId,
          userName: m.username,
          permission: m.permission,
        }));

      await updateDocumentShares(documentId, shares);
      setSuccessMessage(
        `Permissions saved (${shares.length} user${shares.length !== 1 ? 's' : ''} with access)`,
      );
      setHasChanges(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setIsSaving(false);
    }
  }, [record, accessList, documentId, updateDocumentShares]);

  if (!record || record.type !== 'remote') {
    return (
      <div className="document-permissions-dialog__overlay" onClick={onClose}>
        <div className="document-permissions-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="document-permissions-dialog__header">
            <h3>Manage Access</h3>
            <button className="document-permissions-dialog__close" onClick={onClose}>×</button>
          </div>
          <div className="document-permissions-dialog__content">
            <p className="document-permissions-dialog__empty">Document not found or not a relay document.</p>
            <div className="document-permissions-dialog__actions">
              <button className="document-permissions-dialog__btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="document-permissions-dialog__overlay" onClick={onClose}>
      <div className="document-permissions-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="document-permissions-dialog__header">
          <h3>Manage Access</h3>
          <button className="document-permissions-dialog__close" onClick={onClose}>×</button>
        </div>

        <div className="document-permissions-dialog__content">
          <div className="document-permissions-dialog__doc-info">
            <div className="document-permissions-dialog__doc-name">{record.name}</div>
            <div className="document-permissions-dialog__doc-meta">
              <span className="document-permissions-dialog__owner-badge">👑 {record.ownerName}</span>
              <span className="document-permissions-dialog__access-count">
                {accessCounts.total} user{accessCounts.total !== 1 ? 's' : ''} with access
                {accessCounts.editors > 0 && ` (${accessCounts.editors} editor${accessCounts.editors !== 1 ? 's' : ''})`}
              </span>
            </div>
          </div>

          {error && <div className="document-permissions-dialog__error">{error}</div>}
          {successMessage && <div className="document-permissions-dialog__success">{successMessage}</div>}

          {transferToUserId && (
            <div className="document-permissions-dialog__transfer-confirm">
              <p>
                Transfer ownership to{' '}
                <strong>{accessList.find((m) => m.userId === transferToUserId)?.username}</strong>?
              </p>
              <p className="document-permissions-dialog__transfer-warning">
                ⚠️ You will lose owner privileges and become an editor. This action cannot be undone.
              </p>
              <div className="document-permissions-dialog__transfer-actions">
                <button
                  className="document-permissions-dialog__btn document-permissions-dialog__btn--danger"
                  onClick={handleConfirmTransfer}
                  disabled={isSaving}
                >
                  {isSaving ? 'Transferring...' : 'Transfer Ownership'}
                </button>
                <button
                  className="document-permissions-dialog__btn"
                  onClick={() => setTransferToUserId(null)}
                  disabled={isSaving}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!transferToUserId && (
            <>
              <div className="document-permissions-dialog__section">
                <h4>Add User</h4>
                <form
                  className="document-permissions-dialog__add-form"
                  onSubmit={handleAddUser}
                >
                  <input
                    type="text"
                    className="document-permissions-dialog__permission-select"
                    placeholder="User ID"
                    value={newUserId}
                    onChange={(e) => setNewUserId(e.target.value)}
                    disabled={isSaving}
                    required
                  />
                  <input
                    type="text"
                    className="document-permissions-dialog__permission-select"
                    placeholder="Display name"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    disabled={isSaving}
                    required
                  />
                  <select
                    className="document-permissions-dialog__permission-select"
                    value={newPermission}
                    onChange={(e) => setNewPermission(e.target.value as 'view' | 'edit')}
                    disabled={isSaving}
                  >
                    <option value="view">Viewer</option>
                    <option value="edit">Editor</option>
                  </select>
                  <button
                    type="submit"
                    className="document-permissions-dialog__btn"
                    disabled={isSaving || !newUserId.trim() || !newUserName.trim()}
                  >
                    Add
                  </button>
                </form>
                <p className="document-permissions-dialog__hint">
                  The relay validates user IDs on save. Unknown IDs will be rejected.
                </p>
              </div>

              <div className="document-permissions-dialog__quick-actions">
                <button
                  className="document-permissions-dialog__quick-btn document-permissions-dialog__quick-btn--danger"
                  onClick={handleRevokeAll}
                  disabled={accessList.length === 0}
                  title="Revoke all access"
                >
                  Revoke All
                </button>
              </div>

              <div className="document-permissions-dialog__section">
                <h4>Current Shares</h4>
                {accessList.length === 0 ? (
                  <p className="document-permissions-dialog__empty">No users have access yet.</p>
                ) : (
                  <ul className="document-permissions-dialog__members">
                    {accessList.map((member) => (
                      <li
                        key={member.userId}
                        className={`document-permissions-dialog__member ${member.permission !== 'none' ? 'document-permissions-dialog__member--has-access' : ''}`}
                      >
                        <div className="document-permissions-dialog__member-info">
                          <span className="document-permissions-dialog__member-name">
                            {member.username}
                            <span className="document-permissions-dialog__offline-badge">{member.userId}</span>
                          </span>
                        </div>
                        <div className="document-permissions-dialog__member-controls">
                          <select
                            className="document-permissions-dialog__permission-select"
                            value={member.permission}
                            onChange={(e) =>
                              handlePermissionChange(
                                member.userId,
                                e.target.value as 'view' | 'edit' | 'none',
                              )
                            }
                          >
                            <option value="none">No Access</option>
                            <option value="view">Viewer</option>
                            <option value="edit">Editor</option>
                          </select>
                          {member.permission !== 'none' && (
                            <button
                              className="document-permissions-dialog__transfer-btn"
                              onClick={() => handleTransferOwnership(member.userId)}
                              title="Transfer ownership to this user"
                            >
                              👑
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="document-permissions-dialog__actions">
                <button
                  className="document-permissions-dialog__btn document-permissions-dialog__btn--primary"
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges}
                >
                  {isSaving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
                </button>
                <button
                  className="document-permissions-dialog__btn"
                  onClick={onClose}
                  disabled={isSaving}
                >
                  {hasChanges ? 'Cancel' : 'Close'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default DocumentPermissionsDialog;
