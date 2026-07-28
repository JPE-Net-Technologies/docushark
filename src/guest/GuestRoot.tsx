/**
 * Guest mount root (JP-464). Chosen over a bespoke viewer on purpose: `ready`
 * mounts the REAL editor — full canvas fidelity, layouts, prose — with the
 * `external` registry record holding every existing read-only guard closed.
 * A diagramming product whose shared artifact can't render diagrams would
 * defeat the feature.
 *
 * The terminal states mirror the server's uniform miss: `unavailable` says
 * nothing about WHY (revoked, never existed — deliberately
 * indistinguishable), while `error` is infra-shaped and retryable.
 */
import App from '../ui/App';
import { GuestBar } from './GuestBar';
import { useGuestStore } from './guestSession';
import './guest.css';

export function GuestRoot() {
  const phase = useGuestStore((s) => s.phase);
  const errorDetail = useGuestStore((s) => s.errorDetail);

  if (phase === 'loading') {
    return (
      <div className="guest-terminal">
        <div className="guest-terminal__card" role="status">
          <div className="guest-terminal__spinner" aria-hidden="true" />
          <h1>Opening document…</h1>
        </div>
      </div>
    );
  }

  if (phase === 'unavailable') {
    return (
      <div className="guest-terminal">
        <main className="guest-terminal__card">
          <h1>This document isn't available</h1>
          <p>The link may have been turned off by its owner, or it never existed.</p>
        </main>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="guest-terminal">
        <main className="guest-terminal__card">
          <h1>Something went wrong</h1>
          <p>{errorDetail}</p>
          <button
            type="button"
            className="guest-terminal__retry"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </main>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <GuestBar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <App authCallbackConsumed={false} />
      </div>
    </div>
  );
}

export default GuestRoot;
