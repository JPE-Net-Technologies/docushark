// MUST be first: populates `shapeRegistry` with every built-in shape
// (core + library) before any module that reads from it — including
// App's transitive imports, stores hydrating from localStorage, and
// the Engine. Re-ordering this below `App` re-introduces the v2 blank-
// canvas bug where ERD/UML shapes throw "No handler registered."
import './shapes/registerBuiltInShapes';
// Register import adapters (Excalidraw, …) so file-drop / paste / the Import
// command can recognize and parse diagram files.
import './shapes/import/registerImportAdapters';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App';
import GuestRoot from './guest/GuestRoot';
import { bootGuestSession, guestTokenFromLocation } from './guest/guestSession';
import { registerPwa } from './pwa/registerPwa';
import { initInstallPrompt } from './pwa/installPrompt';
import { handleAuthCallbackIfPresent } from './api/authCallback';
import './index.css';
// Adaptive motion budget (JP-101): also boots adaptiveBudget's device sampling
// + reduced-motion root attribute via the CSS module's sibling import below.
import './ui/adaptive-motion.css';
import './platform/adaptiveBudget';
// Mirror the persisted appearance prefs (accent + motion) onto the document at
// boot, before first paint — see applyAppearance (Abstraction A).
import './ui/appearance/applyAppearance';

function mountApp(authCallbackConsumed: boolean): void {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Root element not found');
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App authCallbackConsumed={authCallbackConsumed} />
    </React.StrictMode>
  );

  // Register the service worker. No-op in the Tauri build, where the PWA plugin
  // is disabled and `registerSW` is a stub.
  registerPwa();

  // Offer a one-time "Install DocuShark" hint when the browser reports the app
  // as installable. No-op in the Tauri build and once installed/dismissed.
  initInstallPrompt();
}

/** Mount the guest (share-link) view: hydrate from the share API, then render
 *  the read-only editor behind the guest bar. No session machinery runs. */
function mountGuest(token: string): void {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Root element not found');
  }
  const reactRoot = ReactDOM.createRoot(root);
  const render = () =>
    reactRoot.render(
      <React.StrictMode>
        <GuestRoot />
      </React.StrictMode>
    );
  render();
  void bootGuestSession(token);
  // The PWA still registers its SW on this route — an installed app serves
  // `/d/` navigations from the shell, and the client route (this code) must
  // exist there too.
  registerPwa();
}

// JP-464: a `/d/<token>` navigation is a GUEST view — published-document
// reading with no session. It branches before any auth machinery: no handoff
// interception, no boot auto-sign-in, no last-document restore.
const guestToken = guestTokenFromLocation(window.location.pathname);
if (guestToken) {
  mountGuest(guestToken);
} else {
  // Intercept the PWA web one-click handoff (`/auth/callback?handoff_code=…`)
  // before mounting: consume the code, connect the relay, then mount. A no-op on
  // every other route (and in the Tauri build). The boolean it resolves with
  // (`true` = it signed in on this load) is threaded to App so boot auto-sign-in
  // doesn't double-connect on the callback route.
  void handleAuthCallbackIfPresent().then(mountApp);
}
