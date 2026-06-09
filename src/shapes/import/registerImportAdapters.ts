/**
 * Boot-time registration of import adapters (mirrors registerBuiltInShapes).
 * Side-effect module: imported once from main.tsx. Guarded so HMR re-imports
 * don't throw on duplicate registration.
 */

import { registerImportAdapter, getImportAdapter } from './ImportAdapter';
import { excalidrawAdapter } from './adapters/excalidrawAdapter';
import { drawioAdapter } from './adapters/drawioAdapter';

if (!getImportAdapter(excalidrawAdapter.id)) {
  registerImportAdapter(excalidrawAdapter);
}
if (!getImportAdapter(drawioAdapter.id)) {
  registerImportAdapter(drawioAdapter);
}
