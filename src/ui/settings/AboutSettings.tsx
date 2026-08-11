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
import { Clock, GitCommitHorizontal, Monitor, Package, Radio, Tag } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { StatusTile, TileGroup } from '../tiles/Tile';
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

      <TileGroup title="DocuShark" icon={Package}>
        <StatusTile icon={Tag} label="Version" value={__APP_VERSION__} className="about-mono" />
        <StatusTile
          icon={GitCommitHorizontal}
          label="Commit"
          value={__GIT_SHA__}
          className="about-mono"
        />
        <StatusTile icon={Clock} label="Built" value={formatBuildTime(__BUILD_TIME__)} />
        <StatusTile icon={Monitor} label="Platform" value={PLATFORM} />
      </TileGroup>

      <TileGroup title="Relay" icon={Radio}>
        {relay ? (
          <>
            <StatusTile icon={Tag} label="Version" value={relay.version} className="about-mono" />
            {relay.commit ? (
              <StatusTile
                icon={GitCommitHorizontal}
                label="Commit"
                value={relay.commit}
                className="about-mono"
              />
            ) : null}
            <StatusTile icon={Radio} label="Status" value="Connected" />
          </>
        ) : (
          <StatusTile
            icon={Radio}
            label="Status"
            value={connected ? 'Unavailable' : 'Not connected'}
            hint={
              connected
                ? 'Connected, but this relay did not report a version.'
                : 'Connect to a workspace to see its relay build.'
            }
          />
        )}
      </TileGroup>
    </div>
  );
}

/** Render the ISO build timestamp in the user's locale; pass through if unparseable. */
function formatBuildTime(raw: string): string {
  if (!raw || raw === 'unknown') return 'unknown';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

export default AboutSettings;
