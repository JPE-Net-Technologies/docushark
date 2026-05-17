// MUST be first: populates `shapeRegistry` with every built-in shape
// (core + library) before any module that reads from it — including
// App's transitive imports, stores hydrating from localStorage, and
// the Engine. Re-ordering this below `App` re-introduces the v2 blank-
// canvas bug where ERD/UML shapes throw "No handler registered."
import './shapes/registerBuiltInShapes';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App';
import { migrateLocalStorageKeys, dropLegacyRelayCacheDb } from './migrations/relayRename';
import './index.css';

// Run synchronous localStorage rename before any store hydrates. The IDB
// drop is async and fire-and-forget; the cache rebuilds organically
// from the relay on first reconnect.
migrateLocalStorageKeys();
void dropLegacyRelayCacheDb();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
