// MUST be first: populates `shapeRegistry` with every built-in shape
// (core + library) before any module that reads from it — including
// App's transitive imports, stores hydrating from localStorage, and
// the Engine. Re-ordering this below `App` re-introduces the v2 blank-
// canvas bug where ERD/UML shapes throw "No handler registered."
import './shapes/registerBuiltInShapes';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App';
import { registerPwa } from './pwa/registerPwa';
import { handleAuthCallbackIfPresent } from './api/authCallback';
import './index.css';
// Adaptive motion budget (JP-101): also boots adaptiveBudget's device sampling
// + reduced-motion root attribute via the CSS module's sibling import below.
import './ui/adaptive-motion.css';
import './platform/adaptiveBudget';

function mountApp(): void {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Root element not found');
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // Register the service worker. No-op in the Tauri build, where the PWA plugin
  // is disabled and `registerSW` is a stub.
  registerPwa();
}

// JP-100: intercept the PWA web OAuth callback before mounting. Inert (resolves
// false immediately) until the docushark-web bridge flips AUTH_CALLBACK_ENABLED.
void handleAuthCallbackIfPresent().then(mountApp);
