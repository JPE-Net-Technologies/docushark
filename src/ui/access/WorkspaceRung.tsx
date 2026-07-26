/**
 * Workspace rung of the access ladder (JP-456) — who is in the workspace, and
 * who that makes an owner of every document in it.
 *
 * Ported from `WorkspaceMembersSection`, which lived inside the Cloud sign-in
 * modal. Behaviour is preserved (roster, invite links, member removal); what
 * changes is that it now sits in the access panel next to the document rung it
 * relates to, and states the consequence of each role instead of leaving the
 * reader to infer it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Loader2, Trash2, UserPlus } from 'lucide-react';
import { webClient, type WorkspaceMember, type WorkspaceInvite } from '../../api/webClient';
import { useNotificationStore } from '../../store/notificationStore';
import { confirmDialog } from '../confirm/confirmStore';
import { RichSelect, type RichSelectItem } from '../components/RichSelect';
import { InitialsAvatar } from '../components/InitialsAvatar';
import { RoleBadge, type BadgeRole } from '../components/RoleBadge';

/** Invite roles, with the consequence spelled out rather than implied. */
const INVITE_ROLE_ITEMS: RichSelectItem<'member' | 'viewer'>[] = [
  {
    value: 'member',
    label: 'Member',
    render: () => (
      <span className="access-role-option">
        <strong>Member</strong>
        <small>Can be given access to documents</small>
      </span>
    ),
  },
  {
    value: 'viewer',
    label: 'Viewer',
    render: () => (
      <span className="access-role-option">
        <strong>Viewer</strong>
        <small>Read-only, even where shared</small>
      </span>
    ),
  },
];

export interface WorkspaceRungProps {
  roster: WorkspaceMember[];
  currentUserId: string | undefined;
  /** Lets the parent keep its single roster copy in sync after a removal. */
  onRosterChange: (next: WorkspaceMember[]) => void;
}

export function WorkspaceRung({ roster, currentUserId, onRosterChange }: WorkspaceRungProps) {
  const isOwner = roster.some((m) => m.userId === currentUserId && m.role === 'owner');

  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [inviteRole, setInviteRole] = useState<'member' | 'viewer'>('member');
  const [creating, setCreating] = useState(false);

  // Pending invites are owner-only on the server — don't even ask otherwise.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    webClient
      .listInvites()
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch(() => {
        if (!cancelled) setInvites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  const copyLink = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => useNotificationStore.getState().success('Invite link copied'),
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

  const handleRevokeInvite = useCallback(async (url: string) => {
    const token = inviteToken(url);
    try {
      await webClient.revokeInvite(token);
      setInvites((prev) => prev.filter((i) => inviteToken(i.url) !== token));
    } catch (err) {
      useNotificationStore
        .getState()
        .error(err instanceof Error ? err.message : 'Could not revoke the invite');
    }
  }, []);

  const handleRemoveMember = useCallback(
    async (member: WorkspaceMember) => {
      const ok = await confirmDialog({
        title: `Remove ${member.displayName}?`,
        message: 'They lose access to this workspace and every document shared with them in it.',
        details: 'They keep any local copies already on their device. You can re-invite them later.',
        confirmLabel: 'Remove member',
        danger: true,
      });
      if (!ok) return;
      try {
        await webClient.removeMember(member.userId);
        onRosterChange(roster.filter((m) => m.userId !== member.userId));
      } catch (err) {
        useNotificationStore
          .getState()
          .error(err instanceof Error ? err.message : 'Could not remove the member');
      }
    },
    [roster, onRosterChange],
  );

  if (roster.length === 0) {
    return <p className="access-panel__hint">No member directory for this workspace.</p>;
  }

  return (
    <div className="access-rung__content">
      <ul className="access-people">
        {roster.map((m) => (
          <li key={m.userId} className="access-person">
            <InitialsAvatar name={m.displayName} />
            <span className="access-person__id">
              <span className="access-person__name">
                {m.displayName}
                {m.userId === currentUserId ? (
                  <span className="access-person__you">You</span>
                ) : null}
              </span>
              {m.email ? <span className="access-person__sub">{m.email}</span> : null}
            </span>
            <RoleBadge role={m.role as BadgeRole} />
            {isOwner && m.role !== 'owner' && m.userId !== currentUserId ? (
              <button
                type="button"
                className="access-icon-btn access-icon-btn--danger"
                onClick={() => void handleRemoveMember(m)}
                title={`Remove ${m.displayName}`}
                aria-label={`Remove ${m.displayName}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {/* The load-bearing sentence: membership alone grants nothing on a
          document, so nobody assumes adding someone here shares their work. */}
      <p className="access-panel__hint">
        Owners and admins can manage every document here. Everyone else needs to
        be added to a document before they can open it.
      </p>

      {isOwner ? (
        <div className="access-invites">
          <div className="access-invites__create">
            <RichSelect
              value={inviteRole}
              onChange={setInviteRole}
              items={INVITE_ROLE_ITEMS}
              ariaLabel="Invite role"
              minWidth={120}
            />
            <button
              type="button"
              className="access-panel__btn"
              onClick={() => void handleCreateInvite()}
              disabled={creating}
            >
              {creating ? (
                <Loader2 size={14} className="access-panel__spin" aria-hidden="true" />
              ) : (
                <UserPlus size={14} aria-hidden="true" />
              )}
              Create invite link
            </button>
          </div>

          {invites.length > 0 ? (
            <ul className="access-invites__list">
              {invites.map((inv) => (
                <li key={inv.id} className="access-invite">
                  <Link2 size={14} className="access-invite__icon" aria-hidden="true" />
                  <span className="access-invite__url" title={inv.url}>
                    {inv.url}
                  </span>
                  <RoleBadge role={inv.role as BadgeRole} />
                  <button
                    type="button"
                    className="access-panel__btn access-panel__btn--compact"
                    onClick={() => copyLink(inv.url)}
                  >
                    <Copy size={14} aria-hidden="true" /> Copy
                  </button>
                  <button
                    type="button"
                    className="access-icon-btn access-icon-btn--danger"
                    onClick={() => void handleRevokeInvite(inv.url)}
                    title="Revoke invite"
                    aria-label="Revoke invite"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The opaque token is the last PATH segment of the invite URL. Parsed via the
 * URL API so a query string or fragment (`/invite/<tok>?x=1#y`) can't bleed into
 * the token — a naive split yields `<tok>?x=1` and the revoke silently misses.
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

export default WorkspaceRung;
