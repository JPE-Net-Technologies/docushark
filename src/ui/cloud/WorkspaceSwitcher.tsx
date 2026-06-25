/**
 * Workspace switcher (JP-370).
 *
 * Lists the workspaces the signed-in user belongs to and lets them switch the
 * single active connection between them (one live WS at a time). Only renders
 * when the user is in more than one workspace — a single-workspace user has
 * nothing to switch. The active workspace is derived reactively from the live relay token.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { webClient, type WorkspaceSummary } from '../../api/webClient';
import { switchWorkspace } from '../../services/switchWorkspace';
import { workspaceIdFromRelayToken } from '../../api/relayTokenUser';
import { DEFAULT_WORKSPACE_ID } from '../../store/activeWorkspace';
import { useConnectionStore } from '../../store/connectionStore';
import { useNotificationStore } from '../../store/notificationStore';

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  // Reactive: re-derives when a switch swaps the token.
  const token = useConnectionStore((s) => s.token);
  const activeId = workspaceIdFromRelayToken(token) ?? DEFAULT_WORKSPACE_ID;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWorkspaces(await webClient.listWorkspaces());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSwitch = useCallback(async (ws: WorkspaceSummary) => {
    if (ws.id === activeId || switchingId) return;
    setSwitchingId(ws.id);
    try {
      await switchWorkspace(ws.id);
      useNotificationStore.getState().success(`Switched to ${ws.name}`);
    } catch (err) {
      useNotificationStore
        .getState()
        .error(err instanceof Error ? err.message : `Could not switch to ${ws.name}`);
    } finally {
      setSwitchingId(null);
    }
  }, [activeId, switchingId]);

  // Nothing to switch between (or still loading the list) → render nothing.
  if (loading || error || workspaces.length < 2) return null;

  return (
    <div className="cloud-connect__switcher">
      <div className="cloud-connect__members-header">
        <h4>Workspaces ({workspaces.length})</h4>
        <button type="button" className="cloud-connect__icon-btn" onClick={() => void load()} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      <ul className="cloud-connect__switcher-list">
        {workspaces.map((ws) => {
          const isActive = ws.id === activeId;
          return (
            <li key={ws.id}>
              <button
                type="button"
                className={`cloud-connect__switcher-item${isActive ? ' cloud-connect__switcher-item--active' : ''}`}
                onClick={() => void handleSwitch(ws)}
                disabled={isActive || switchingId !== null}
                aria-current={isActive}
              >
                <span className="cloud-connect__switcher-name">{ws.name}</span>
                <span className="cloud-connect__switcher-role">{ws.role}</span>
                {switchingId === ws.id ? (
                  <Loader2 size={14} className="cloud-connect__spin" />
                ) : isActive ? (
                  <Check size={14} className="cloud-connect__switcher-check" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default WorkspaceSwitcher;
