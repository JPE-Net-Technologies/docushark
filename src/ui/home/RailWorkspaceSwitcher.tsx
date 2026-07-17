/**
 * RailWorkspaceSwitcher (JP-444) — the identity block at the top of the
 * DocumentsHome navy rail. Shows the active workspace (initials avatar, name,
 * role · region meta) and opens a dropdown for switching between the user's
 * workspaces, managing the cloud connection, or opening the web account.
 *
 * Replaces the old sign-in pill. Reuses the same services as the connect
 * modal's switcher (`listWorkspaces` / `switchWorkspace` / `RoleBadge`); the
 * modal remains the connection-management surface, this is the fast path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Cloud,
  ExternalLink,
  HardDrive,
  Loader2,
  LogIn,
} from 'lucide-react';
import { webClient, type WorkspaceSummary } from '../../api/webClient';
import { switchWorkspace } from '../../services/switchWorkspace';
import { workspaceIdFromRelayToken } from '../../api/relayTokenUser';
import { DEFAULT_WORKSPACE_ID } from '../../store/activeWorkspace';
import { useConnectionStore } from '../../store/connectionStore';
import { useNotificationStore } from '../../store/notificationStore';
import { RoleBadge, type BadgeRole } from '../components/RoleBadge';
import { loadConnection, WORKSPACE_URL_BASE } from '../../api/relayConnection';
import { openCloudSignIn } from '../cloud/cloudSignInStore';
import { clampToViewport } from '../contextMenuUtils';

export interface RailWorkspaceSwitcherProps {
  signedIn: boolean;
  isConnectedToHost: boolean;
  /** Open the docushark-web account portal in the system browser. */
  onOpenWebAccount: () => void;
}

/** Two-letter initials for the avatar tile ("Acme Docs" → "AD"). */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function RailWorkspaceSwitcher({
  signedIn,
  isConnectedToHost,
  onOpenWebAccount,
}: RailWorkspaceSwitcherProps) {
  const [wsName, setWsName] = useState<string | null>(null);
  const [wsSlug, setWsSlug] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Active workspace derived reactively from the live relay token, so a
  // switch (which swaps the token) re-highlights without a refetch.
  const token = useConnectionStore((s) => s.token);
  const activeId = workspaceIdFromRelayToken(token) ?? DEFAULT_WORKSPACE_ID;

  // Workspace display identity from the persisted connection record — same
  // source the connect modal shows. Keyed on `signedIn` (not a status) so a
  // REST-only sign-in still refreshes it.
  useEffect(() => {
    let cancelled = false;
    void loadConnection().then((c) => {
      if (cancelled) return;
      setWsName(c?.workspaceName ?? null);
      setWsSlug(c?.workspaceSlug ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // The user's workspace roster — feeds both the meta line (role · region for
  // the active entry) and the dropdown list. Best-effort: a failed fetch just
  // leaves the roster empty (meta falls back to the slug).
  const loadWorkspaces = useCallback(async () => {
    if (!signedIn) {
      setWorkspaces([]);
      return;
    }
    try {
      setWorkspaces(await webClient.listWorkspaces());
    } catch {
      setWorkspaces([]);
    }
  }, [signedIn]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const active = workspaces.find((w) => w.id === activeId);

  // Position the dropdown under the trigger in viewport space (the surface
  // clips overflow, so the menu is fixed-position + clamped). Re-clamps on
  // size change: the roster loads async, growing the menu after first paint.
  useEffect(() => {
    const el = menuRef.current;
    const anchor = triggerRef.current;
    if (!open || !el || !anchor) {
      setMenuPos(null);
      return undefined;
    }
    const reclamp = () => {
      const a = anchor.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      setMenuPos(clampToViewport(a.left, a.bottom + 6, m.width, m.height));
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, workspaces.length]);

  // Refresh the roster on open so the list reflects invites/renames; close on
  // outside press or Escape.
  useEffect(() => {
    if (!open) return undefined;
    void loadWorkspaces();
    const onPress = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, loadWorkspaces]);

  const handleSwitch = useCallback(
    async (ws: WorkspaceSummary) => {
      if (ws.id === activeId || switchingId) return;
      setSwitchingId(ws.id);
      try {
        await switchWorkspace(ws.id);
        useNotificationStore.getState().success(`Switched to ${ws.name}`);
        setOpen(false);
      } catch (err) {
        useNotificationStore
          .getState()
          .error(err instanceof Error ? err.message : `Could not switch to ${ws.name}`);
      } finally {
        setSwitchingId(null);
      }
    },
    [activeId, switchingId]
  );

  const name = signedIn ? (wsName ?? 'Cloud workspace') : 'Local workspace';
  const meta = signedIn
    ? active
      ? `${active.role} · ${active.region}`
      : wsSlug
        ? `${WORKSPACE_URL_BASE}/${wsSlug}`
        : isConnectedToHost
          ? 'Connected'
          : 'Signed in'
    : 'Sign in to sync';

  return (
    <>
      <button
        ref={triggerRef}
        className="dh-switch"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={signedIn ? 'Switch workspace' : 'Sign in to DocuShark Cloud'}
      >
        <span className={`dh-switch-avatar${signedIn ? '' : ' dh-switch-avatar--local'}`}>
          {signedIn ? workspaceInitials(name) : <HardDrive size={16} aria-hidden="true" />}
        </span>
        <span className="dh-switch-info">
          <span className="dh-switch-name">{name}</span>
          <span className="dh-switch-meta">{meta}</span>
        </span>
        <ChevronDown size={15} className="dh-switch-chev" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="dh-swmenu"
          role="menu"
          style={
            menuPos
              ? { left: menuPos.x, top: menuPos.y }
              : { left: 14, top: 64, visibility: 'hidden' }
          }
        >
          {signedIn && workspaces.length > 0 && (
            <>
              <div className="dh-swmenu-sect">Workspaces</div>
              {workspaces.map((ws) => {
                const isActive = ws.id === activeId;
                return (
                  <button
                    key={ws.id}
                    className={`dh-swmenu-item${isActive ? ' dh-swmenu-item--active' : ''}`}
                    role="menuitem"
                    onClick={() => void handleSwitch(ws)}
                    disabled={isActive || switchingId !== null}
                    aria-current={isActive}
                  >
                    <span className="dh-swmenu-ws-avatar">{workspaceInitials(ws.name)}</span>
                    <span className="dh-swmenu-ws-info">
                      <span className="dh-swmenu-ws-name">{ws.name}</span>
                      <span className="dh-swmenu-ws-region">{ws.region}</span>
                    </span>
                    <RoleBadge role={ws.role as BadgeRole} />
                    {switchingId === ws.id ? (
                      <Loader2 size={14} className="dh-swmenu-spin" aria-hidden="true" />
                    ) : isActive ? (
                      <Check size={14} className="dh-swmenu-check" aria-hidden="true" />
                    ) : (
                      <span className="dh-swmenu-slot" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
              <div className="dh-swmenu-sep" aria-hidden="true" />
            </>
          )}

          <button
            className="dh-swmenu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openCloudSignIn();
            }}
          >
            {signedIn ? (
              <Cloud size={15} aria-hidden="true" />
            ) : (
              <LogIn size={15} aria-hidden="true" />
            )}
            <span className="dh-swmenu-label">
              {signedIn ? 'Manage cloud connection' : 'Sign in to DocuShark Cloud'}
            </span>
          </button>
          <button
            className="dh-swmenu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenWebAccount();
            }}
          >
            <ExternalLink size={15} aria-hidden="true" />
            <span className="dh-swmenu-label">Open web account</span>
          </button>
        </div>
      )}
    </>
  );
}

export default RailWorkspaceSwitcher;
