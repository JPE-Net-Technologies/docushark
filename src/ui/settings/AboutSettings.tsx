/**
 * About settings tab (JP-327).
 *
 * Surfaces the build identity that was previously only embedded in archive ZIP
 * metadata: app semver, the short git SHA the build came from, build time, and
 * platform. When connected to a relay it also shows the relay's own version
 * (best-effort — a failed/blocked fetch degrades silently; the relay's
 * `/version` is unauthenticated, like `/health`).
 */

import { useEffect, useState } from 'react';
import { useConnectionStore } from '../../store/connectionStore';
import './AboutSettings.css';

const PLATFORM = __IS_TAURI__ ? 'Desktop (Tauri)' : 'Web (PWA)';

/** Map a relay WebSocket URL to its HTTP origin (ws→http, wss→https). */
function relayHttpOrigin(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return null;
  }
}

interface RelayVersion {
  version: string;
  commit?: string;
}

export function AboutSettings() {
  const status = useConnectionStore((s) => s.status);
  const hostUrl = useConnectionStore((s) => s.host?.url ?? null);
  const [relay, setRelay] = useState<RelayVersion | null>(null);

  const connected = status === 'authenticated' || status === 'connected';

  useEffect(() => {
    setRelay(null);
    if (!connected || !hostUrl) return;
    const origin = relayHttpOrigin(hostUrl);
    if (!origin) return;

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${origin}/version`, { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<RelayVersion>;
        if (typeof body.version === 'string') {
          const next: RelayVersion = { version: body.version };
          if (typeof body.commit === 'string') next.commit = body.commit;
          setRelay(next);
        }
      } catch {
        // Best-effort: offline, CORS, or an older relay without /version.
        // The app-only rows below still render.
      }
    })();
    return () => controller.abort();
  }, [connected, hostUrl]);

  return (
    <div className="about-settings">
      <h3 className="settings-section-title">About</h3>

      <div className="settings-group">
        <h4 className="settings-group-title">DocuShark</h4>
        <dl className="about-list">
          <AboutRow label="Version" value={__APP_VERSION__} mono />
          <AboutRow label="Commit" value={__GIT_SHA__} mono />
          <AboutRow label="Built" value={formatBuildTime(__BUILD_TIME__)} />
          <AboutRow label="Platform" value={PLATFORM} />
        </dl>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">Relay</h4>
        {relay ? (
          <dl className="about-list">
            <AboutRow label="Version" value={relay.version} mono />
            {relay.commit ? <AboutRow label="Commit" value={relay.commit} mono /> : null}
            <AboutRow label="Status" value="Connected" />
          </dl>
        ) : (
          <p className="settings-hint">
            {connected ? 'Relay version unavailable.' : 'Not connected to a relay.'}
          </p>
        )}
      </div>
    </div>
  );
}

function AboutRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="about-label">{label}</dt>
      <dd className={`about-value${mono ? ' about-value-mono' : ''}`}>{value}</dd>
    </>
  );
}

/** Render the ISO build timestamp in the user's locale; pass through if unparseable. */
function formatBuildTime(raw: string): string {
  if (!raw || raw === 'unknown') return 'unknown';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

export default AboutSettings;
