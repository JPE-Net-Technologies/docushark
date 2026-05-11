/**
 * MCP (Model Context Protocol) Settings panel.
 *
 * Surfaces the embedded MCP HTTP server's status, port, and bearer token
 * so the user can register Diagrammer as an MCP source in clients like
 * Claude Code. Tokens can be copied, regenerated, or replaced with a
 * user-supplied value (handy for syncing the same token across machines).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  isTauri,
  mcpStatus,
  mcpGetToken,
  mcpRegenerateToken,
  mcpSetToken,
  mcpStart,
  mcpStop,
  mcpGetLocalAccess,
  mcpSetLocalAccess,
  mcpMirrorLocalDocument,
  type McpStatus,
  MCP_TOKEN_MIN_LEN,
  MCP_TOKEN_MAX_LEN,
  MCP_TOKEN_PATTERN,
} from '../../tauri/commands';
import { usePersistenceStore } from '../../store/persistenceStore';
import { STORAGE_KEYS } from '../../types/Document';
import './McpSettings.css';

type Banner = { kind: 'info' | 'error'; text: string } | null;

function validateToken(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return 'Token cannot be empty.';
  if (trimmed.length < MCP_TOKEN_MIN_LEN)
    return `Token is too short (need at least ${MCP_TOKEN_MIN_LEN} characters, got ${trimmed.length}).`;
  if (trimmed.length > MCP_TOKEN_MAX_LEN)
    return `Token is too long (max ${MCP_TOKEN_MAX_LEN} characters).`;
  if (!MCP_TOKEN_PATTERN.test(trimmed))
    return "Token may only contain letters, digits, '-', and '_'.";
  return null;
}

export function McpSettings() {
  const tauri = isTauri();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState<string>('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const draftError = editing ? validateToken(draft) : null;

  const [localAccess, setLocalAccess] = useState(true);

  const refresh = useCallback(async () => {
    if (!tauri) return;
    try {
      const [s, t, la] = await Promise.all([
        mcpStatus(),
        mcpGetToken(),
        mcpGetLocalAccess(),
      ]);
      setStatus(s);
      setToken(t);
      setLocalAccess(la);
    } catch (e) {
      setBanner({ kind: 'error', text: `Failed to load MCP state: ${String(e)}` });
    }
  }, [tauri]);

  const handleToggleLocalAccess = useCallback(async () => {
    setBusy(true);
    try {
      const next = await mcpSetLocalAccess(!localAccess);
      setLocalAccess(next);
      setBanner({
        kind: 'info',
        text: next
          ? 'Local document access enabled.'
          : 'Local document access disabled. Mirror cleared.',
      });
    } catch (e) {
      setBanner({ kind: 'error', text: `Toggle failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [localAccess]);

  const handleSyncNow = useCallback(async () => {
    setBusy(true);
    let n = 0;
    try {
      const docs = usePersistenceStore.getState().documents;
      for (const meta of Object.values(docs)) {
        const raw = localStorage.getItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${meta.id}`);
        if (!raw) continue;
        try {
          await mcpMirrorLocalDocument(JSON.parse(raw));
          n += 1;
        } catch {
          // mcpMirrorLocalDocument already logs; skip per-doc failures.
        }
      }
      setBanner({ kind: 'info', text: `Synced ${n} local document${n === 1 ? '' : 's'} to MCP.` });
    } catch (e) {
      setBanner({ kind: 'error', text: `Sync failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(token);
      setBanner({ kind: 'info', text: 'Token copied to clipboard.' });
    } catch (e) {
      setBanner({ kind: 'error', text: `Copy failed: ${String(e)}` });
    }
  }, [token]);

  const handleRegenerate = useCallback(async () => {
    if (!confirm('Regenerate the MCP token? Any client using the old token will need to be updated.')) {
      return;
    }
    setBusy(true);
    try {
      const fresh = await mcpRegenerateToken();
      setToken(fresh);
      setBanner({ kind: 'info', text: 'Token regenerated.' });
    } catch (e) {
      setBanner({ kind: 'error', text: `Regenerate failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSaveManual = useCallback(async () => {
    const err = validateToken(draft);
    if (err) {
      setBanner({ kind: 'error', text: err });
      return;
    }
    setBusy(true);
    try {
      const stored = await mcpSetToken(draft);
      setToken(stored);
      setEditing(false);
      setDraft('');
      setBanner({ kind: 'info', text: 'Token saved.' });
    } catch (e) {
      setBanner({ kind: 'error', text: `Save failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const handleToggleServer = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    try {
      if (status.running) {
        await mcpStop();
        setBanner({ kind: 'info', text: 'MCP server stopped.' });
      } else {
        await mcpStart();
        setBanner({ kind: 'info', text: 'MCP server started.' });
      }
      await refresh();
    } catch (e) {
      setBanner({ kind: 'error', text: `Server toggle failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [status, refresh]);

  if (!tauri) {
    return (
      <div className="mcp-settings">
        <h3>MCP Server</h3>
        <div className="settings-notice">
          The MCP server runs inside the desktop app and is not available in the web build.
        </div>
      </div>
    );
  }

  const endpoint = status?.running ? `http://${status.address}/mcp` : '—';
  const exampleCmd = status?.running && token
    ? `claude mcp add diagrammer --transport http ${endpoint} --header "Authorization: Bearer ${token}"`
    : null;

  return (
    <div className="mcp-settings">
      <h3>MCP Server</h3>
      <p className="mcp-blurb">
        Lets external MCP clients (e.g. Claude Code) read your documents and draft shapes
        on team documents. Runs locally on <code>127.0.0.1</code> and requires the bearer
        token below.
      </p>
      <p className="mcp-blurb mcp-safety">
        <strong>Safety model.</strong> Local (personal) documents are always
        read-only via MCP — they cannot be modified, renamed, or deleted by any MCP client,
        even one with the token. Team documents are designed for safe concurrent writing,
        including from MCP, and are the only path for AI-assisted drafting.
      </p>

      {banner && (
        <div className={`mcp-banner mcp-banner-${banner.kind}`} onClick={() => setBanner(null)}>
          {banner.text}
        </div>
      )}

      <div className="mcp-row">
        <div className="mcp-label">Status</div>
        <div className="mcp-value">
          <span className={`mcp-dot ${status?.running ? 'on' : 'off'}`} />
          {status?.running ? `Running on ${status.address}` : 'Stopped'}
          <button
            type="button"
            className="mcp-btn mcp-btn-secondary"
            onClick={handleToggleServer}
            disabled={busy || !status}
          >
            {status?.running ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      <div className="mcp-row">
        <div className="mcp-label">Endpoint</div>
        <div className="mcp-value">
          <code>{endpoint}</code>
        </div>
      </div>

      <div className="mcp-row mcp-row-token">
        <div className="mcp-label">Token</div>
        <div className="mcp-value mcp-token-value">
          <input
            type={tokenVisible ? 'text' : 'password'}
            className="mcp-token-input"
            value={token}
            readOnly
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="mcp-btn mcp-btn-secondary"
            onClick={() => setTokenVisible((v) => !v)}
          >
            {tokenVisible ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            className="mcp-btn mcp-btn-secondary"
            onClick={handleCopy}
            disabled={!token}
          >
            Copy
          </button>
          <button
            type="button"
            className="mcp-btn mcp-btn-secondary"
            onClick={handleRegenerate}
            disabled={busy}
          >
            Regenerate
          </button>
          {!editing ? (
            <button
              type="button"
              className="mcp-btn mcp-btn-secondary"
              onClick={() => {
                setEditing(true);
                setDraft('');
              }}
            >
              Set manually…
            </button>
          ) : null}
        </div>
      </div>

      {editing && (
        <div className="mcp-manual">
          <label htmlFor="mcp-manual-input" className="mcp-manual-label">
            Paste a token to use across machines ({MCP_TOKEN_MIN_LEN}–{MCP_TOKEN_MAX_LEN} chars,
            URL-safe characters only):
          </label>
          <input
            id="mcp-manual-input"
            className="mcp-token-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. AbCdEf0123456789_-..."
            autoFocus
          />
          {draftError && <div className="mcp-manual-error">{draftError}</div>}
          <div className="mcp-manual-actions">
            <button
              type="button"
              className="mcp-btn"
              onClick={handleSaveManual}
              disabled={busy || draftError !== null}
            >
              Save
            </button>
            <button
              type="button"
              className="mcp-btn mcp-btn-secondary"
              onClick={() => {
                setEditing(false);
                setDraft('');
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mcp-row">
        <div className="mcp-label">Local document access</div>
        <div className="mcp-value">
          <label className="mcp-switch">
            <input
              type="checkbox"
              checked={localAccess}
              onChange={handleToggleLocalAccess}
              disabled={busy}
            />
            <span>{localAccess ? 'Enabled' : 'Disabled'}</span>
          </label>
          <button
            type="button"
            className="mcp-btn mcp-btn-secondary"
            onClick={handleSyncNow}
            disabled={busy || !localAccess}
            title="Push current local documents to the MCP mirror now"
          >
            Sync now
          </button>
        </div>
      </div>
      <p className="mcp-blurb mcp-hint">
        When enabled, MCP clients can <em>read</em> your local documents alongside team
        documents. Writes are never permitted on local documents — that's an enforced
        guarantee, not a default. To let an MCP client draft changes, work in a team document.
      </p>

      {exampleCmd && (
        <div className="mcp-row mcp-row-stacked">
          <div className="mcp-label">Register in Claude Code</div>
          <pre className="mcp-code-block">{exampleCmd}</pre>
        </div>
      )}
    </div>
  );
}

export default McpSettings;
