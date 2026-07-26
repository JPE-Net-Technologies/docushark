/**
 * Access panel (JP-456) — one place to answer "who can open this, and why?".
 *
 * Replaces two disconnected surfaces: `WorkspaceMembersSection` (members +
 * invites, buried inside the Cloud **sign-in** modal) and
 * `DocumentPermissionsDialog` (per-document shares, its own modal in a different
 * visual language, which dead-ended by telling you to go find the other one).
 *
 * **The structure is the inheritance chain.** Read top to bottom:
 *
 *     Workspace     → who is in it, and who that makes an owner of everything
 *     Collection    → placeholder; collections don't carry grants yet
 *     This document → the owner plus explicitly shared people
 *
 * That shape is chosen because it makes provenance legible without knowing the
 * data model, and because a future access policy is simply another rung that
 * grants. It is drawn from the relay's rules (`relay/src/server/permissions.rs`
 * `get_user_permission`), which are what actually gate access:
 *
 *   1. document owner            → owner
 *   2. workspace owner / admin   → owner on EVERY document (real inheritance)
 *   3. an explicit share         → edit or view
 *   4. otherwise                 → no access
 *
 * Note step 4: plain workspace membership grants **nothing** on a document. The
 * copy here says so, because the editor's own `getEffectivePermission` currently
 * disagrees with the relay and falls through to `viewer` — tracked separately;
 * this panel deliberately describes the enforced behaviour, not the client bug.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { ModalShell } from '../components/ModalShell';
import { webClient, type WorkspaceMember } from '../../api/webClient';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { useAccessPanelStore, type AccessScope } from './accessPanelStore';
import { WorkspaceRung } from './WorkspaceRung';
import { DocumentRung } from './DocumentRung';
import type { RemoteDocument } from '../../types/DocumentRegistry';
import './AccessPanel.css';

export interface AccessPanelProps {
  scope: AccessScope;
  documentId: string | null;
  onClose: () => void;
}

/**
 * One rung of the ladder. `granting` lights the node — a visual claim that this
 * level actually confers access, so the empty Collection rung reads as a slot
 * rather than as something broken.
 */
interface RungProps {
  name: string;
  summary: string;
  granting: boolean;
  muted?: boolean;
  children?: React.ReactNode;
}

function Rung({ name, summary, granting, muted = false, children }: RungProps) {
  return (
    <li className={`access-rung${muted ? ' access-rung--muted' : ''}`}>
      <div className="access-rung__spine" aria-hidden="true">
        <span className={`access-rung__node${granting ? ' access-rung__node--on' : ''}`} />
      </div>
      <div className="access-rung__body">
        <div className="access-rung__head">
          <h3 className="access-rung__name">{name}</h3>
          <span className="access-rung__summary">{summary}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

export function AccessPanel({ scope, documentId, onClose }: AccessPanelProps) {
  const entries = useDocumentRegistry((s) => s.entries);
  const record = documentId ? entries[documentId]?.record : undefined;
  const remote = record && record.type === 'remote' ? (record as RemoteDocument) : undefined;

  const [roster, setRoster] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);

  // One roster fetch for the whole panel — both rungs read it, so fetching per
  // rung would double the control-plane round-trip on every open.
  const loadRoster = useCallback(async () => {
    setLoading(true);
    setRosterError(null);
    try {
      setRoster(await webClient.getWorkspaceMembers());
    } catch (err) {
      setRoster([]);
      setRosterError(err instanceof Error ? err.message : 'Could not load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const me = useMemo(() => roster.find((m) => m.role === 'owner'), [roster]);
  // Only `owner` — `WorkspaceRole` is owner | member | viewer. The relay also
  // honours a legacy `admin` role, but the control plane never issues one, so
  // treating it as a live case here would be dead code.
  const owners = useMemo(() => roster.filter((m) => m.role === 'owner'), [roster]);

  // Document scope needs a document; a non-relay (local) doc has no sharing
  // model at all, so say so rather than rendering an inert rung.
  const showDocumentRung = scope === 'document' && documentId !== null;

  const subtitle = showDocumentRung ? (record?.name ?? 'Document') : undefined;

  return (
    <ModalShell
      title="Access"
      subtitle={subtitle}
      onClose={onClose}
      className="access-panel"
    >
      {loading ? (
        <p className="access-panel__loading" role="status">
          <Loader2 size={14} className="access-panel__spin" aria-hidden="true" /> Loading access…
        </p>
      ) : rosterError ? (
        <div className="access-panel__notice" role="alert">
          <p>Couldn’t load workspace members ({rosterError}).</p>
          <p className="access-panel__hint">
            A self-hosted or offline workspace has no member directory. Document
            sharing still works below.
          </p>
          <button type="button" className="access-panel__btn" onClick={() => void loadRoster()}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : null}

      <ol className="access-ladder">
        <Rung
          name="Workspace"
          summary={
            owners.length > 0
              ? `${roster.length} ${roster.length === 1 ? 'member' : 'members'} · ${owners.length} with full access`
              : `${roster.length} ${roster.length === 1 ? 'member' : 'members'}`
          }
          granting
        >
          <WorkspaceRung roster={roster} currentUserId={me?.userId} onRosterChange={setRoster} />
        </Rung>

        <Rung
          name="Collection"
          summary={showDocumentRung ? 'Collections don’t grant access yet' : 'Not available yet'}
          granting={false}
          muted
        />

        {showDocumentRung ? (
          <Rung
            name="This document"
            summary={
              remote
                ? `${remote.ownerName || 'Someone'} owns it`
                : 'Only workspace documents can be shared'
            }
            granting={!!remote}
          >
            {remote ? (
              <DocumentRung documentId={documentId!} record={remote} roster={roster} />
            ) : (
              <p className="access-panel__hint">
                This document is on this device only. Move it to the workspace to
                share it with people.
              </p>
            )}
          </Rung>
        ) : null}
      </ol>
    </ModalShell>
  );
}

/** Portal host — mount once at the app root, beside `<CloudSignInHost/>`. */
export function AccessPanelHost() {
  const isOpen = useAccessPanelStore((s) => s.isOpen);
  const scope = useAccessPanelStore((s) => s.scope);
  const documentId = useAccessPanelStore((s) => s.documentId);
  const close = useAccessPanelStore((s) => s.close);

  if (!isOpen) return null;
  return <AccessPanel scope={scope} documentId={documentId} onClose={close} />;
}

export default AccessPanel;
