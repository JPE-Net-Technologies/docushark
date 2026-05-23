/**
 * Side-effect module that registers every shape type the app ships with
 * — core shapes plus the built-in libraries (ERD / UML class / UML
 * sequence / UML use-case / activity / flowchart) — synchronously at
 * module load.
 *
 * Imported first in `src/main.tsx` so that by the time any other module
 * (App's transitive imports, stores, the Engine, PropertyPanel, etc.)
 * reads from `shapeRegistry`, every built-in handler is already there.
 * This eliminates a race where documents loaded from localStorage /
 * IndexedDB referenced library shape types whose async loader had not
 * yet completed, throwing "No handler registered" and crashing the
 * canvas tree.
 *
 * User-authored custom libraries (loaded from IndexedDB) remain async
 * via `useShapeLibraryStore.loadCategory()` — they're not part of the
 * boot-time set.
 */

import './Rectangle';
import './Ellipse';
import './Line';
import './Text';
import './Connector';
import './Group';
import './FileShape';

import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import { flowchartShapes } from './library/flowchartShapes';
import { umlUseCaseShapes } from './library/umlUseCaseShapes';
import { erdShapes } from './library/erdShapes';
import { umlClassShapes } from './library/umlClassShapes';
import { sequenceDiagramShapes } from './library/sequenceDiagramShapes';
import { activityDiagramShapes } from './library/activityDiagramShapes';

useShapeLibraryStore.getState().registerShapes([
  ...flowchartShapes,
  ...umlUseCaseShapes,
  ...erdShapes,
  ...umlClassShapes,
  ...sequenceDiagramShapes,
  ...activityDiagramShapes,
]);
useShapeLibraryStore.setState({ isInitialized: true });
