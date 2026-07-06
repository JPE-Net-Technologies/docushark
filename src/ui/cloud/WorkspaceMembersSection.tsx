/**
 * Workspace members + invites (JP-370).
 *
 * Rendered inside the signed-in Cloud panel. Any member sees the roster; the
 * workspace **owner** additionally gets shareable invite links (create / copy /
 * revoke) and can remove members. Talks to `docushark-web` via `webClient` with
 * the cached relay token. Best-effort: a load failure shows an inline note
 * rather than breaking the panel (self-host / offline have no control plane).
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Loader2, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import {
  webClient,
  type WorkspaceMember,
  type WorkspaceInvite,
} from '../../api/webClient';
import { useNotificationStore } from '../../store/notificationStore';
import { confirmDialog } from '../../ui/confirm/confirmStore';
import { RichSelect, type RichSelectItem } from '../components/RichSelect';
import { InitialsAvatar } from '../components/InitialsAvatar';
import { RoleBadge, type BadgeRole } from '../components/RoleBadge';

/** Invite-role choices, with the consequence spelled out in the option row. */
const INVITE_ROLE_ITEMS: RichSelectItem<'member' | 'viewer'>[] = [
  {
    value: 'member',
    label: 'Member',
    render: () => (
      <span className="cloud-connect__role-option">
        <strong>Member</strong>
        <small>Can edit shared documents</small>
      </span>
    ),
  },
  {
    value: 'viewer',
    label: 'Viewer',
    render: () => (
      <span className="cloud-connect__role-option">
        <strong>Viewer</strong>
        <small>Read-only access</small>
      </span>
    ),
  },
];

interface WorkspaceMembersSectionProps {
  /** True when the signed-in user is the workspace owner (invite/remove gating). */
  isOwner: boolean;
  /** The signed-in user's id (so they can't remove themselves). */
  currentUserId: string | undefined;
}

export function WorkspaceMembersSection({ isOwner, currentUserId }: WorkspaceMembersSectionProps) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<'member' | 'viewer'>('member');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const roster = await webClient.getWorkspaceMembers();
      setMembers(roster);
      // Pending invites are owner-only on the server; only fetch them if owner.
      if (isOwner) {
        setInvites(await webClient.listInvites());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load members');
    } finally {
      setLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyLink = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => useNotificationStore.getState().success('Invite link copied to clipboard'),
      () => useNotificationStore.getState().info(`Invite link: ${url}`),
    );
  }, []);

  const handleCreateInvite = useCallback(async () => {
    setCreating(true);
    try {
      const invite = await webClient.createInvite(inviteRole);
      setInvites((prev) => [invite, ...prev]);
      copyLink(invite.url);
    } catch (err) {
      useNotificationStore
        .getState()
        .error(err instanceof Error ? err.message : 'Could not create an invite link');
    } finally {
      setCreating(false);
    }
  }, [inviteRole, copyLink]);

  const handleRevokeInvite = useCallback(async (token: string) => {
    // Extract the token from the invite URL's last path segment.
    try {
      await webClient.revokeInvite(token);
      setInvites((prev) => prev.filter((i) => inviteToken(i.url) !== token));
    } catch (err) {
      useNotificationStore
        .getState()
        .error(err instanceof Error ? err.message : 'Could not revoke the invite');
    }
  }, []);

  const handleRemoveMember = useCallback(async (member: WorkspaceMember) => {
    const ok = await confirmDialog({
      title: `Remove ${member.displayName}?`,
      message: 'They lose access to this workspace and its shared documents.',
      details: 'They keep any local copies already on their device. You can re-invite them later.',
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (!ok) return;
    try {
      await webClient.removeMember(member.userId);
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
    } catch (err) {
      useNotificationStore
        .getState()
        .error(err instanceof Error ? err.message : 'Could not remove the member');
    }
  }, []);

  if (loading) {
    return (
      <div className="cloud-connect__members cloud-connect__members--loading">
        <Loader2 size={14} className="cloud-connect__spin" /> Loading members…
      </div>
    );
  }

  if (error) {
    return (
      <div className="cloud-connect__members">
        <div className="cloud-connect__members-header">
          <h4>Members</h4>
          <button type="button" className="cloud-connect__icon-btn" onClick={() => void load()} title="Retry">
            <RefreshCw size={14} />
          </button>
        </div>
        <p className="cloud-connect__members-note">Couldn’t load workspace members ({error}).</p>
      </div>
    );
  }

  return (
    <div className="cloud-connect__members">
      <div className="cloud-connect__members-header">
        <h4>Members ({members.length})</h4>
        <button type="button" className="cloud-connect__icon-btn" onClick={() => void load()} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      <ul className="cloud-connect__member-list">
        {members.map((m) => (
          <li key={m.userId} className="cloud-connect__member">
            <InitialsAvatar name={m.displayName} />
            <div className="cloud-connect__member-id">
              <span className="cloud-connect__member-name">
                {m.displayName}
                {m.userId === currentUserId ? (
                  <span className="cloud-connect__member-you">you</span>
                ) : null}
              </span>
              {m.email ? <span className="cloud-connect__member-email">{m.email}</span> : null}
            </div>
            <RoleBadge role={m.role as BadgeRole} />
            {isOwner && m.role !== 'owner' && m.userId !== currentUserId ? (
              <button
                type="button"
                className="cloud-connect__icon-btn cloud-connect__icon-btn--danger"
                onClick={() => void handleRemoveMember(m)}
                title={`Remove ${m.displayName}`}
              >
                <Trash2 size={14} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {isOwner ? (
        <div className="cloud-connect__invites">
          <div className="cloud-connect__invite-create">
            <RichSelect
              value={inviteRole}
              onChange={setInviteRole}
              items={INVITE_ROLE_ITEMS}
              ariaLabel="Invite role"
              className={`cloud-connect__invite-role${creating ? ' cloud-connect__control-disabled' : ''}`}
              minWidth={110}
            />
            <button
              type="button"
              className="cloud-connect__btn cloud-connect__btn--secondary"
              onClick={() => void handleCreateInvite()}
              disabled={creating}
            >
              {creating ? <Loader2 size={14} className="cloud-connect__spin" /> : <UserPlus size={14} />}
              Create invite link
            </button>
          </div>

          {invites.length > 0 ? (
            <ul className="cloud-connect__invite-list">
              {invites.map((inv) => (
                <li key={inv.id} className="cloud-connect__invite">
                  <span className="cloud-connect__invite-icon" aria-hidden="true">
                    <Link2 size={14} />
                  </span>
                  <div className="cloud-connect__invite-body">
                    <span className="cloud-connect__invite-url" title={inv.url}>
                      {inv.url}
                    </span>
                    <RoleBadge role={inv.role as BadgeRole} />
                  </div>
                  <button
                    type="button"
                    className="cloud-connect__btn cloud-connect__btn--secondary cloud-connect__btn--compact"
                    onClick={() => copyLink(inv.url)}
                  >
                    <Copy size={14} />
                    Copy
                  </button>
                  <button
                    type="button"
                    className="cloud-connect__icon-btn cloud-connect__icon-btn--danger"
                    onClick={() => void handleRevokeInvite(inviteToken(inv.url))}
                    title="Revoke invite"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="cloud-connect__members-note">
            Anyone with an invite link can join this workspace until it expires or is revoked.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The opaque token is the last PATH segment of the invite URL. Parse via the
 * URL API so a query string or fragment (`/invite/<tok>?x=1#y`) never bleeds
 * into the token — a naive split would yield `<tok>?x=1` and the revoke would
 * silently miss. Falls back to a path-only split for a non-absolute URL.
 */
export function inviteToken(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? url;
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length ? decodeURIComponent(parts[parts.length - 1]!) : '';
}

export default WorkspaceMembersSection;
