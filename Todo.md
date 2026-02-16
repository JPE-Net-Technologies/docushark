# Development Todo List

<!--
!! IMPORTANT !!
  This document is tightly coupled with `roadmap.md` in the documentation site. Be sure to also update that tracker as you complete phases.
-->

---

## ⚠️ CRITICAL: Backwards Compatibility & Document Safety

**Since v1.0.0-beta.1 is released, all changes MUST be backwards-compatible.**

### Document Safety Requirements
- **Document format changes**: Must include migration code that automatically upgrades older documents
- **Never break existing documents**: Users rely on this tool for critical documentation
- **Test with real documents**: Before merging changes that touch persistence, document loading, or shape data
- **Serialization changes**: Add new fields as optional with sensible defaults; never remove or rename existing fields without migration

### Backwards Compatibility Rules
- **Store changes**: New fields must be optional or have defaults; never break existing localStorage/IndexedDB data
- **Protocol changes**: Maintain compatibility with existing clients; version the protocol if breaking changes are necessary
- **Shape registry**: New shape types are fine; changes to existing shape handlers must preserve rendering of old documents
- **Export formats**: JSON export must remain readable by older versions where possible

### When Breaking Changes Are Unavoidable
1. Implement automatic migration in the loading code
2. Add version field to track document format version
3. Test migration with documents from previous releases
4. Document the migration in release notes

---

---

## Implementation Phase Tracker

### Phase 1: Core Foundation - COMPLETE

- [x] Project setup with Bun, TypeScript, React, Zustand
- [x] Math utilities (Vec2, Mat3, Box, geometry) - 204 tests
- [x] Camera system with coordinate transforms - 58 tests
- [x] Input handler with normalized events - 41 tests
- [x] Renderer with DPI scaling and grid - 33 tests
- [x] React integration (CanvasContainer, App)

### Phase 2: Shape System - COMPLETE

- [x] Shape types and ShapeRegistry pattern
- [x] Rectangle, Ellipse, Line, Text shape handlers
- [x] Shape utilities (bounds, transforms) - 55 tests
- [x] DocumentStore with Immer - 37 tests
- [x] SessionStore for UI state - 37 tests
- [x] SpatialIndex (RBush) and HitTester - 48 tests

### Phase 3: Tools - COMPLETE

- [x] Tool architecture with BaseTool and ToolContext
- [x] ToolManager for tool registration and switching
- [x] PanTool, SelectTool, RectangleTool, EllipseTool, LineTool, TextTool
- [x] Selection with resize/rotation handles
- [x] Marquee selection

### Phase 4: Basic UI - COMPLETE

- [x] Toolbar with tool buttons and shortcuts
- [x] PropertyPanel for shape properties
- [x] Color palette for quick color selection
- [x] Resizable PropertyPanel

### Phase 5: Extended Features - COMPLETE

- [x] History system (undo/redo) - 14 tests
- [x] Keyboard shortcuts (Ctrl+Z, Ctrl+C/V, Delete, etc.)
- [x] Copy/paste with cascading offset
- [x] Connectors (shapes that attach to other shapes)
- [x] Inline text labels for Rectangle and Ellipse
- [x] Text wrapping in shape labels
- [x] Dark mode with system detection
- [x] Immersive controls (WASD/Arrow pan, Q/E zoom)

### Phase 6: Core Improvements - COMPLETE

#### Text Editing

- [x] Fix text inline editing (double-click to edit)
  - Improved double-click detection thresholds
  - Fixed TextEditor focus timing with requestAnimationFrame
  - Added dark mode support for text editing overlay

#### Alignment & Guides

- [x] Smart snapping to grid
  - Snap shapes to grid points during drag
  - Visual guides showing snap targets (pink dashed lines)
- [x] Smart alignment guides
  - Show guides when shapes align with others (center, edges)
  - Snap to nearby shape edges/centers
- [x] Alignment tools
  - Align selected shapes (left, center, right, top, middle, bottom)
  - Distribute selected shapes (horizontal, vertical)
  - AlignmentPanel component with visual icon buttons

#### Layer Management

- [x] Layer panel with z-order management
  - Visual list of all shapes in z-order
  - Drag to reorder
  - Lock/unlock individual shapes
  - Show/hide individual shapes
  - Bring to front / Send to back buttons

#### Style Profiles

- [x] Style profiles for reusable shape styles
  - Save current shape's style as a named profile
  - Profile stores: fill, stroke, strokeWidth, opacity, cornerRadius (if applicable)
  - Profile also stores: labelFontSize, labelColor for shapes with labels
  - Five built-in default profiles (Default Blue, Fresh Green, Warm Orange, Outline Only, Subtle Gray)
  - List saved profiles in PropertyPanel with color preview swatches
  - Apply profile to selected shape(s) with checkmark button
  - Delete custom profiles (defaults are protected)
  - Rename custom profiles via double-click
  - Persist custom profiles in localStorage
  - Ready for group application (future group feature)

#### Grouping

- [x] Group/ungroup shapes
  - Ctrl+G to group selected shapes
  - Ctrl+Shift+G to ungroup
  - Transform group as single unit
  - Select individual shapes within group

#### Export Features

- [x] Export to PNG
  - Export visible canvas area or selected shapes
  - High-DPI export option (1x, 2x, 3x scale)
  - Configurable background (color or transparent)
  - Configurable padding
- [x] Export to SVG
  - Convert shapes to SVG elements
  - Preserve colors, strokes, opacity
  - Support for all shape types including groups
- [x] Export UI
  - File menu in header with export options
  - Context menu "Export Selection..." option
  - Export dialog with format, scale, background, padding, filename options

#### UI Polish

- [x] Context menu (right-click)
  - Show relevant actions based on selection (cut, copy, paste, delete)
  - Display keyboard shortcuts next to each action (e.g., "Delete Del")
  - Shape-specific actions (bring to front, send to back, group, ungroup)
  - Tool-specific options when no selection
  - Styled to match dark/light theme

### Phase 7: Multi-Page & Persistence - COMPLETE

- [x] Multi-page documents
- [x] Offline-first with localStorage persistence
- [x] Auto-save functionality
- [x] Export/import document JSON
- [x] Local path for saving documents (optional)

### Phase 8: Rich Documentation - COMPLETE

- [x] RTF document editor (similar to Eraser.io)
  - Headings, paragraphs, bold, italic
  - Bullet lists and numbered lists
  - Code blocks with syntax highlighting
  - Tables
  - Embedded images
  - Embedded diagrams (link canvas content into documents)
  - Markdown import/export
  - Document outline/table of contents

### Phase 9: UI Improvements - COMPLETE

#### Enhanced Color Palette

- [x] Recent colors tracking (last 8 used, persisted to localStorage)
- [x] Custom color input with hex support
- [x] Color palette organized by color family (grayscale, warm, cool, accent)
- [x] Native color picker integration

#### Property Panel Redesign

- [x] Collapsible property sections with chevron headers
- [x] Section state persistence (remember expanded/collapsed)
- [x] Compact color input (inline picker + hex)
- [x] Default collapse Position/Size sections (less commonly edited)
- [x] More compact, vibrant styling

#### Unified Toolbar (Notion/Linear Style)

- [x] Single consolidated toolbar (~44px) replacing header + toolbar + page tabs
- [x] Compact tool buttons (32px) with hover tooltips showing shortcuts
- [x] Inline page tabs with horizontal scroll
- [x] Minimal, keyboard-first aesthetic

#### Status Bar

- [x] Camera position display (X, Y coordinates)
- [x] Zoom level with quick controls (-, +, Fit, 100%)
- [x] Shape count indicator
- [x] Current tool display

### Phase 9.5: IndexedDb Storage - COMPLETE

- [x] Implement an IndexedDb storage pattern for images and blobs
  - Content-addressed storage using SHA-256 hashing for automatic deduplication
  - Reference counting for safe garbage collection
  - BlobStorage class for IndexedDB CRUD operations
  - BlobGarbageCollector for cleaning up orphaned blobs
  - Tiptap image extension integration with blob:// URLs
  - ImageUploadButton component with automatic image validation and resizing
  - Storage Manager UI for viewing blobs and running garbage collection
  - Hybrid storage: localStorage for documents, IndexedDB for binary blobs
- [x] Plan for a local directory storage which allows documents to reside within their own directory
  - Architecture designed with pluggable BlobStorageBackend interface
  - Future support for File System Access API planned

### Phase 10: Advanced Diagramming - COMPLETE

- [x] Connector labels
  - Label text, font size, color, position along path
  - Background for readability
  - PropertyPanel section for connector label editing
- [x] Smart connectors with orthogonal routing
  - OrthogonalRouter for L-shaped and Z-shaped Manhattan paths
  - Waypoints for multi-segment polylines
  - Automatic path recalculation when shapes move
  - Routing mode selector in PropertyPanel (straight/orthogonal)
- [x] Custom icon library with IndexedDB storage
  - 30+ built-in SVG icons (arrows, shapes, symbols, tech, general)
  - SVG sanitization and validation
  - Content-addressed blob storage for custom icons
  - IconPicker component with category filtering and search
  - Upload custom SVG icons
- [x] Shape icons for Rectangle and Ellipse
  - Icon badge in top-left corner
  - Configurable size and padding
  - Icons rendered using cached HTMLImageElement for performance
  - StorageManager updated with Icons tab for management

### Phase 10.5: Shape Libraries - COMPLETE

- [x] Shape libraries (basics, flowcharts, UML barebones, and **eventually** stuff like BPMN, swimlanes, etc.)
  - _Concepts to keep in mind:_
    - Eventually in the far future, we will be linking shapes to code and using REAL UML classes that link to real classes
    - Layers will eventually be renamable (GroupShape.name already exists)
  - _Initial scope:_
    - Metadata-driven shape system for PropertyPanel extensibility
    - Flowchart shapes: Diamond, Terminator, Data, Document, Predefined Process, Manual Input, Preparation, Connector, Off-Page Connector
    - ShapePicker UI component for shape library selection

### Phase 10.6: UML Use-Case Diagrams - COMPLETE

- [x] UML use-case diagram shapes
  - Actor (stick figure with circle head and limbs)
  - Use Case (ellipse with label)
  - System Boundary (labeled rectangle container with title bar)
  - Include/Extend relationship indicators (arrow shapes for visual reference)
- [x] Fixed dark mode rendering for ShapePicker canvas previews

### Phase 10.7 User Expandable Shape Libraries - COMPLETE

- [x] Create a settings modal (feel free to add anything that belongs) that we will use in the future for various features
  - Tab-based settings modal infrastructure (SettingsModal.tsx)
  - Shape Libraries tab as initial implementation
- [x] Implement the ability to save and re-use shapes into a runtime shape library
  - ShapeLibraryManager UI for creating/renaming/deleting libraries
  - Users can create named libraries
  - Users can rename custom libraries
  - Users can export/import libraries as JSON
  - SaveToLibraryDialog accessible via context menu "Save to Library..."
  - CustomShapeTool for click-to-place behavior
  - Two-tier storage: Zustand (localStorage) for metadata, IndexedDB for shape data
  - Extensible store architecture for future usage

#### UI Fixes & Improvements

- [x] Implement draggable layer reordering throughout groups and nested groups
- [x] Fix group layer-order visibility issues; when I grouped a text and shape together with my text on top, the grouping moved my text to the bottom and went invisible even though it was above the shape within the layer-order
- [x] Shapes have no available icons in the property panel

### Phase 11: Advanced Shape Toolsets - COMPLETE

#### Phase 11.1: Property Panel Overhaul - COMPLETE

- [x] Icon picker dropdown is buried underneath property panel elements (messed-up-z-order)
  - Fixed using React Portal to render dropdown at document body level
  - Added position tracking and scroll/resize handling
- [x] Improve the property panel UX where possible including aesthetics
  - Updated PropertyPanel.css with modern styling (rounded borders, better spacing)
  - Improved PropertySection.css with card-like appearance
  - Added hover states, smooth transitions, and better scrollbar styling
  - Updated type badge with accent color
- [x] Plugin extensibility for panels
  - Created PanelExtensions.ts with registry pattern
  - PropertySectionExtension for custom panel sections
  - PropertyRendererExtension for custom property types
  - PanelActionExtension for header action buttons
  - Extensible architecture ready for future plugins
- [x] AMENDMENT: Shape label customizations: custom BG, ~~and draggable~~ offset labels from the default position on a shape.
  - Label background color property for Rectangle, Ellipse, LibraryShape, and Connector
  - Label offset X/Y properties for positioning labels away from center
  - PropertyPanel controls for all label styling options

#### Phase 11.2: Context Menu Upgrades - COMPLETE

- [x] Implement multi-option entries support (submenu on hover)
  - Created reusable Submenu component with hover delay
- [x] Add context menu entry: Change connector routing
- [x] Add context menu entry: Lock submenu
  - Lock Position, Lock Size, Lock All options
  - SelectTool respects lock properties

#### Phase 11.3: Layer Panel Upgrades - COMPLETE

- [x] Color layers/groups (layers inherit colors of a group if they don't have a color, ensure inherited colors lose their inheritance when moved out of a group, and remember group->group inheritance)
  - Added `layerColor` property to GroupShape
  - Color badge displayed in LayerPanel with inheritance from parent groups
  - "Set Color" submenu in context menu with preset colors
  - Inherited colors shown with reduced opacity
- [x] Rename layers/groups
  - Polished existing rename UX: auto-select text on focus
  - Validates non-empty names before saving
- [x] Creating layer views (dropdown selector for filtered subsets of layers)
  - LayerViewStore for persistent view storage
  - LayerViewManager modal for creating/editing/deleting views
  - Regex pattern matching against shape types, group names, and labels
  - Manual additions via "Add to View" context menu submenu
  - View selector dropdown in LayerPanel header
- [x] Show a compact line with a preview of a shape's label-text
  - Displays truncated label/text content below shape type
  - Works for Rectangle, Ellipse, Text, Connector, and LibraryShape

#### Phase 11.4: Common Settings - COMPLETE

- Implemented 'Common Settings' area in the settings modal which contains the following:
  - [x] Default connector type (default orthogonal) - ConnectorTool reads from settingsStore
  - [x] Default shape style profile - Dropdown in GeneralSettings
  - [x] Show static properties in the property panel (default enabled) - Setting stored in settingsStore
  - [x] Hide default style profiles - StyleProfilePanel and GeneralSettings dropdown respect this setting
  - [x] Theme preference (System/Light/Dark) moved to General Settings
- [x] Move the storage manager into a settings section and delete the tools toolbar entry
  - Storage Manager embedded as StorageSettings tab in SettingsModal
  - Removed Tools menu from UnifiedToolbar
- [x] Move File menu into Settings modal as Documents tab
  - DocumentsSettings component with New, Save, Import/Export, document list
  - Removed File dropdown from UnifiedToolbar
- [x] Full-size "Settings" button in toolbar (replaces icon-only buttons)
  - Consolidated Settings button with icon + text
  - Removed separate theme toggle (now in Settings > General)
- [x] Add a small 'Rebuild' button which recalculates all connector routes
  - documentStore.rebuildAllConnectorRoutes() function added
  - Rebuild button in UnifiedToolbar
- [x] Garbage collection protects icons by default
  - BlobGarbageCollector skips SVG files unless `includeIcons: true` option
  - Storage Manager shows "Icon" tag and "Protected" badge for SVG blobs
- Added 'Style Profile' settings area in SettingsModal with:
  - [x] Save Icon Style to Style Profile (on by default)
  - [x] Save Label Style to Style Profile (on by default)

#### Phase 11.5: Advanced Group Style Properties - COMPLETE

- Implemented the following properties for groups:
  - [x] Background Color, and Background-Pattern Support (solid, stripes, hazard stripes, linear/radial gradients)
    - PatternPicker component with visual previews
    - Configurable pattern colors, angle, and spacing
    - Background padding and corner radius options
  - [x] Labels (with manual offset translation capability)
    - 9-grid label position picker (center, top, top-left, etc.)
    - Label font size, color, and background
    - Offset X/Y fine-tuning with reset button
  - [x] Border styling properties
    - Border color, width, and corner radius
    - BorderStylePicker with solid, dashed, dotted, dash-dot patterns
  - [x] BONUS FEATURE: Shadows and glow effects
    - ShadowEditor with offset, blur, and color controls
    - Preset options: Drop Shadow, Soft Shadow, Glow, Subtle Glow
- Two-pass group rendering (background/border before children, label on top)
- Hit testing updated to include background area for styled groups

### Phase 12: Advanced Export - COMPLETE

- [x] Customizable PDF document export
  - Export rich text document content to PDF
  - DPI/Quality settings (Standard 72dpi, High 150dpi, Print 300dpi)
  - Page size options (A4, Letter, A3, Tabloid) with portrait/landscape orientation
  - Configurable margins and page numbers
  - Cover page with custom logo from blob storage, title, version/revision, author, date, and description
  - LogoPicker component for selecting logos from IndexedDB storage
  - PDFExportStore for persisting export preferences
  - Tiptap JSON content parsing with support for headings, paragraphs, lists, code blocks, blockquotes, images, and horizontal rules
- [x] Multi-page PDF export (all rich text pages + all canvas diagram pages)
- [x] Full rich text rendering: text color, highlights, inline code, sub/superscript, text alignment, task lists, tables with colspan/rowspan, LaTeX math (KaTeX → PNG)
- [x] PDFNodeRendererRegistry — extensible registry pattern (like ShapeRegistry) so new Tiptap extensions auto-surface missing PDF renderers via `warnUnhandledNodes()`
- [x] CSS color parsing for `rgb()`, `rgba()`, named colors (not just hex)
- [x] Centralized `PDF_STYLE` config for all rendering constants

### Phase 12.2: Embeddable Diagram Groups - COMPLETE

- [x] Implement an embeddable diagram system into the tiptap editor that allows users to:
  - Open the context menu and add a group to the rich text document at the cursor
  - Custom Tiptap node extension for embedded groups (EmbeddedGroupExtension.ts)
  - React component for rendering group previews (EmbeddedGroupComponent.tsx)
  - Context menu in document editor to select from available groups
  - PDF export support for embedded group nodes
  - Maximum width/height constraints with aspect ratio preservation
  - Refresh button to re-render group after canvas changes

### Phase 13: Diagram Patterns - COMPLETE

- [x] ERD Shape Library (Crow's Foot)
  - Entity, Weak Entity, Relationship, Attribute, Key Attribute shapes
  - Cardinality indicators: One, Many, Zero-One, Zero-Many, One-Many
  - 10 shapes total with proper anchors and hit testing
- [x] UML Class Diagram Shape Library
  - Class (3-compartment), Interface, Abstract Class, Enum, Package, Note shapes
  - Relationship indicators: Association, Aggregation, Composition, Inheritance, Realization, Dependency
  - 12 shapes total with proper anchors and hit testing
- [x] Misc. Feature: Add/Remove shapes from groups via context menu
  - "Add to Group" submenu lists available groups (with cycle detection)
  - "Remove from Group" option for shapes inside groups
  - Uses existing moveShapeInHierarchy() store method

### Phase 14: Collaboration, Simple Auth, and UI Improvements

#### Architecture Overview

The Diagrammer desktop app (packaged via **Tauri**) operates in two modes:

- **Offline (Default)**: Personal documents stored locally, no network features
- **Protected Local**: Host exposes Team Documents storage; clients connect over network (LAN, VPN, or tunneled via Cloudflare/similar)

**Host-Client Model:**

- Host runs Diagrammer in Protected Local mode, acts as single source of truth for Team Documents
- Clients authenticate via host's login page and receive **JWT session tokens**
- CRDT (Yjs/yrs recommended due to existing Tiptap integration) negotiates real-time changes
- Team Documents are decoupled from Personal Documents; any document can be moved to Team Documents
- Future: targeted plugins may only work on Team Documents or Personal Documents

**Ownership & Permissions Model:**

- **Roles**: Admin and User (future: extensible role system as permission interfaces)
- **Documents**: Owned by SYSTEM, controlled by ADMINS
  - Admins can restrict: document creation, modifications, deletions
- **Groups**: Can have ownership; owner MAY add restrictions:
  - Ownership editing locks (prevent others from changing ownership)
  - User-selective editing (restrict which users can edit)
  - Default: allow-all (no restrictions unless owner adds them)
- **Style Profiles**: Can have ownership; owner can lock profiles to prevent modification
- **Admins**: Can supersede any owner by unlocking objects; control who can save default export settings
- **Session Validation**: JWT tokens validated server-side; reject mutations from invalid/expired tokens

**Technical Decisions:**

- **Desktop Runtime**: Tauri (Rust backend, React frontend)
- **Auth Tokens**: JWT (HS256 initially, extensible to RS256/OAuth later)
- **Credential Storage**: bcrypt-hashed passwords (decoupled for future identity provider integration)
- **Real-time Sync**: WebSocket transport, CRDT for conflict resolution
- **CRDT Library**: Yjs (client) / yrs (Rust server) - leverages existing Tiptap Y.js ecosystem

#### Phase 14.Pre: Tauri Migration - COMPLETE

##### Project Setup - COMPLETE

- [x] Initialize Tauri alongside existing Vite configuration
  - `src-tauri/` directory with Cargo.toml and tauri.conf.json
  - Preserve existing `bun run dev` workflow during migration
  - Configure Tauri to use Vite dev server in development mode
- [x] Configure build pipeline
  - Development: Tauri wraps Vite dev server
  - Production: Tauri bundles Vite build output
  - Cross-platform builds (Windows, macOS, Linux)

##### Rust Backend Scaffolding - COMPLETE

- [x] Core Tauri application structure
  - Main entry point with window configuration
  - App state management for server mode toggle
- [x] IPC bridge between React frontend and Rust backend
  - Tauri command definitions for frontend→backend calls
  - TypeScript bindings in src/tauri/commands.ts
- [x] WebSocket server foundation (for Protected Local mode)
  - Tokio async runtime with Axum for HTTP/WebSocket handling
  - Server lifecycle management (start/stop/status)
  - Broadcast channel for real-time message distribution
  - Server starts only when Protected Local mode enabled
- [x] File system access layer
  - Tauri fs plugin configured with capabilities
  - Read/write operations via Tauri fs API

##### Storage Backend Abstraction - COMPLETE

- [x] Create pluggable storage interface
  - `StorageBackend` TypeScript interface for document persistence
  - `LocalStorageBackend`: localStorage for Personal Documents
  - `FileSystemBackend`: Tauri fs API for Team Documents
  - `StorageFactory`: Backend selection based on mode
- [x] Storage module exports via src/storage/index.ts

##### Development Workflow - COMPLETE

- [x] Update package.json scripts
  - `bun run dev` - Vite only (web development, no Tauri)
  - `bun run tauri:dev` - Full Tauri development mode
  - `bun run tauri:build` - Production build
- [x] Documentation for Tauri development setup
  - Rust toolchain requirements documented in CLAUDE.md
  - Taskfile.yml added for task automation

#### Phase 14.0: Collaboration Infrastructure - COMPLETE

- [x] CRDT integration for real-time collaboration on Team Documents
  - YjsDocument wrapper for Y.Map-based shape sync
  - SyncProvider for WebSocket transport with auto-reconnect
  - collaborationStore for managing sync state and sessions
  - useCollaborationSync hook for bidirectional sync with documentStore
  - Conflict resolution via Yjs CRDT protocol
- [x] Presence indicators (who's viewing which page)
  - PresenceIndicators component showing active collaborators
  - User avatars with color coding and initials
- [x] Collaborative cursors (show other users' cursor positions)
  - CollaborativeCursors overlay component
  - Real-time cursor rendering with user labels
- [x] Network transport layer (WebSocket via Tauri backend)
  - Yjs sync protocol implementation
  - Awareness protocol for presence

#### Phase 14.1 Collaboration Overhaul

**Design Decisions (User-Approved):**

- Offline editing: Editable - queue changes locally, sync/merge when reconnected
- Conflict resolution: Auto-merge via CRDT for shapes, last-write-wins for metadata
- Permissions: Owner/Editor/Viewer (3-tier model)
- Migration: Not needed (no end users, can break existing data structures)

##### Phase 14.1.1: Unified Connection Layer - COMPLETE

- [x] Create document type definitions (`src/types/DocumentRegistry.ts`)
  - Discriminated unions for local/remote/cached documents
  - Permission types (owner/editor/viewer)
  - Sync state types (synced/syncing/pending/error)
  - Type guards and conversion helpers
- [x] Create connectionStore (`src/store/connectionStore.ts`)
  - Centralized WebSocket connection state
  - Connection status, auth state, reconnection tracking
  - Selector hooks for UI components
- [x] Create UnifiedSyncProvider (`src/collaboration/UnifiedSyncProvider.ts`)
  - Single WebSocket replacing separate SyncProvider + DocumentSyncProvider
  - CRDT sync via Yjs (MESSAGE_SYNC, MESSAGE_AWARENESS)
  - Document operations (list, get, save, delete)
  - Authentication (token or credentials)
  - Auto-reconnection with exponential backoff
- [x] Add protocol message routing helpers (`src/collaboration/protocol.ts`)
  - `getMessageChannel()`, `isCRDTMessage()`, `isAuthMessage()`
  - `getMessageTypeName()` for debugging
- [x] Update collaborationStore to use UnifiedSyncProvider
- [x] Update teamDocumentStore with `setProviderFromUnified()` method
  - DocumentProvider interface for compatibility with both provider types
- [x] Update collaboration/index.ts exports

##### Phase 14.1.2: Document Registry Pattern - COMPLETE

- [x] Create documentRegistry store (`src/store/documentRegistry.ts`)
  - Unified document state for local/remote/cached using discriminated union types
  - Entries indexed by ID with record metadata and optional document content
  - Filter capabilities for document list (by type, host, search query)
  - Sync state management for remote documents
  - Local/Remote/Cached document type tracking
  - Persistence with Zustand persist middleware
- [x] Update persistenceStore to delegate to registry
  - Registers local documents on save/load/import
  - Sets active document and caches content
  - Removes documents from registry on delete
  - Migration of existing documents on initialization
- [x] Update teamDocumentStore to integrate with registry
  - Registers remote documents when fetched from host
  - Updates sync state on save operations
  - Handles document events (created/updated/deleted)
  - Caches document content in registry

##### Phase 14.1.3: Offline-First with Sync Queue - COMPLETE

- [x] Create OfflineQueue (`src/collaboration/OfflineQueue.ts`)
  - Queue save/delete operations when offline
  - Last-write-wins deduplication per document
  - Sorted processing by timestamp (oldest first)
  - Retry logic with configurable max retries
  - Change notification system for UI updates
  - Serialization/deserialization for persistence
- [x] Create SyncQueueStorage (`src/storage/SyncQueueStorage.ts`)
  - IndexedDB persistence for durability across sessions
  - Indexes for efficient queries by document/host
  - Batch operations for performance
  - Clear by host functionality
- [x] Create SyncStateManager (`src/collaboration/SyncStateManager.ts`)
  - Coordinates OfflineQueue, storage, and connection state
  - Auto-loads persisted queue on initialization
  - Auto-processes queue on reconnection
  - Updates documentRegistry sync states
  - Handles disconnection (converts remote docs to cached)
  - Persists queue changes automatically

##### Phase 14.1.4: Presence System Overhaul - COMPLETE

- [x] Create presenceStore (`src/store/presenceStore.ts`)
  - Dedicated store for real-time presence management
  - Stores remote users with cursor/selection state
  - Stale cursor detection and cleanup
  - Optimized selectors for rendering
- [x] Create CollaborativeCursor component
  - Updated existing component to use presenceStore
  - Improved stale cursor filtering
  - Better bounds checking for off-screen cursors
- [x] Create SelectionHighlight component (`src/ui/SelectionHighlight.tsx`)
  - Renders colored borders around shapes selected by other users
  - Shows user name labels on selections
  - Uses shapeRegistry for accurate bounds calculation
- [x] Update Renderer for presence overlays
  - Added SelectionHighlight to CanvasContainer
  - Pass container dimensions to presence components
  - Integrated presenceStore with collaborationStore

##### Phase 14.1.5: Access Control Implementation - COMPLETE

- [x] Create permissions.rs (`src-tauri/src/server/permissions.rs`)
- [x] Add permission middleware to server handlers
- [x] Add permission error codes to protocol

##### Phase 14.1.6: UI Consolidation - COMPLETE

- [x] Create DocumentBrowser component (replaces DocumentsSettings + TeamDocumentsManager)
- [x] Create DocumentCard component
- [x] Create SyncStatusBadge component

#### Phase 14.2: UX Improvements

##### Phase 14.2.1: UX Improvements - Chunk 1 (Large)

- [x] Make the canvas not-focused effect more friendly; the red border is annoying; consider a light blue top-border or similar
- [x] Minimap for large canvases; add a toggle for this in the settings
- [x] Context menu for style profiles clips overflows outside of window viewport
- [x] Add border radius for group-labels
- [x] Select dropdown is pure white and gray (tested in dark mode)
- [x] Checkboxes have weird pallettes; especially in dark mode

##### Phase 14.2.1: UX Improvements - Chunk 1.5 (Large)

- [x] Settings overhaul; do a complete settings modal overhaul, re-organizing areas, and creating a more intuitive, vibrant, and fluid menu.
- [x] Documents area doesn't update with UI (won't register a document name-change until a few component renders)
- [x] Add document management settings & info for cached/disconnected team documents ()
- [x] Move all document lists to a Documents area in the settings (remove any document management from the collaboration area); showing a section for remote documents, and a section for local documents and adding every-form of management into the dedicated documents area
- [x] Add a cool animation for authenticating clients

##### Known Issues

- **Minimap**: Experimental feature with known bugs (navigation, rendering). Marked as experimental in settings.
- **PDF Export: "þÿ" encoding artifacts** _(Critical)_: PDF exports render `þÿ` (UTF-16 BOM bytes `0xFE 0xFF`) as literal text in various contexts — bullet points, merged table cells, brackets, and other special characters. Root cause: jsPDF's standard fonts (helvetica, courier) only support WinAnsiEncoding (Latin-1/CP1252). Unicode characters outside this range are misinterpreted as raw bytes. Fix requires embedding a custom Unicode-capable TrueType font via jsPDF's font converter tool. See [GitHub Issue #4](https://github.com/QR-Madness/diagrammer/issues/4) for tracking.

##### Phase 14.2.2: UX Improvements - Chunk 2 (Medium)

- [x] Smart-alignment for shape resize
- [x] Return focus to canvas when the layer panel is collapsed
- [x] Remove focus from the canvas when working in the rich text editor
- [x] Ensure FPS counter is disabled in release builds
- [x] Allow LaTeX equations for shape text by prepending `=` (completed in Phase 14.3)

##### Phase 14.2.3: UX Improvements - Chunk 3 (Medium)

- [x] Implement a button to snap to a layer item instead of doing it on-layer-click (but add this option in the settings to enable the auto-snap again)
- [x] Cool Saving/Saved icon & animation
- [x] Add a small-search button on the style profiles action bar (with the view mode) which opens a search bar to filter style profiles, also add a clear filter button when the style profile filter is active

##### Phase 14.2.4: UX Improvements - Chunk 4 (Small)

- [x] Translate selected items using arrow keys
- [x] Add a test regex button to layer view creator to get a results-preview
- [x] First-time setup authentication page has misleading placeholder text (reduce contrast for placeholders), and make this page more vibrant like an onboarding page.

##### Phase 14.2.5: Protocol & Backend Testing - COMPLETE

- [x] TypeScript protocol unit tests (mock WebSocket, test UnifiedSyncProvider message encoding/decoding)
  - 47 protocol tests: message encoding/decoding, error code helpers, channel classification, round-trip validation
  - 42 UnifiedSyncProvider tests: connection lifecycle, token/credentials auth, document CRUD operations, events, awareness
  - Fixed bug: MESSAGE_DOC_SHARE and MESSAGE_DOC_TRANSFER responses weren't being handled

#### Phase 14.3: Rich Document Editor Upgrades (Large) - COMPLETE

- [x] Tiptap Tables (insert, add/delete rows/cols, resizable columns)
- [x] LaTeX Equation Support (both rich text and shape text with `=` prefix)
  - Inline math: `$...$` or ∑ button
  - Block math: `$$...$$` or ∫ button (multiline textarea, Ctrl+Enter to insert)
  - Shape text: prefix label with `=` for LaTeX
- [x] Image resizing handles (8 handles with aspect ratio lock)
- [x] Deeper headings (H1-H6 with appropriate styling)
- [x] Interactive Task Lists (nested, with checkboxes)
- [x] Additional tweaks: Math input modal, table controls in toolbar

##### Phase 14.3.1: Rich Text Editor Enhancements - COMPLETE

- [x] Table style controls (header row/column toggle, merge/split cells)
- [x] Themed text level dropdown (dark mode support with styled arrow)
- [x] Block equation textarea (multiline with Ctrl+Enter to insert)
- [x] Text formatting extensions:
  - Underline (Ctrl+U)
  - Strikethrough
  - Subscript
  - Superscript
- [x] Color tools:
  - Text color picker with 40-color palette
  - Highlight color picker with 12-color palette
  - Click-outside-to-close behavior
- [x] Search & Replace panel:
  - Case-sensitive toggle
  - Regex support
  - Replace single / Replace all
  - Keyboard shortcuts (Ctrl+F search, Ctrl+H replace)

##### Phase 14.3.2: Rich Text Editor Phase 2 - COMPLETE

- [x] Block quotes:
  - Enabled in StarterKit
  - Toolbar button with quote icon
  - Styled with left border and background
- [x] Text alignment:
  - TextAlign extension (left, center, right, justify)
  - Alignment buttons in toolbar with icons
  - Applied to headings and paragraphs
- [x] Table options:
  - Cell background color picker (40-color palette)
  - Text alignment uses same TextAlign extension
- [x] Enhanced context menu:
  - Format submenu: bold, italic, underline, strike, code, subscript, superscript, clear formatting
  - Heading submenu: paragraph, H1-H6
  - List submenu: bullet, numbered, task
  - Table submenu: insert/delete rows/cols, header toggles, merge/split, delete table
- [x] Multi-page support:
  - Tab bar with horizontal scrollable tabs
  - Create/delete pages with context menu
  - Inline rename (double-click)
  - Tab color picker
  - Drag reorder tabs
  - Page content persistence on switch

##### Phase 14.3.3: Fixes and Enhancements - COMPLETE

- [x] Tab color persistence:
  - Added `richTextPages` field to DiagramDocument type
  - Integrated with persistenceStore save/load
  - Pages persist across sessions
- [x] Entity attribute padding:
  - Horizontal padding (attributePaddingHorizontal)
  - Vertical padding (attributePaddingVertical)
  - Property panel controls for ERD entity shapes
  - Separator lines use horizontal padding for consistent inset
- [x] Style profiles for all shapes:
  - Extended StyleProfileProperties with fontSize, fontFamily, arrows, lineStyle, group properties
  - Shape-type-aware property mapping (SHAPE_CATEGORIES)
  - getApplicablePropertyNames() utility for UI hints
  - Works for: rectangle, ellipse, line, text, connector, group, all library shapes
- [x] Icons/images over host connection:
  - AssetBundler.ts for bundling/extracting assets
  - bundleDocumentWithAssets() embeds blob:// as base64 data URLs
  - extractAssetsFromBundle() converts back to local blob storage
  - Integrated into teamDocumentStore saveToHost/loadTeamDocument

### Phase 14.9: AI Insights Improvements Checklist

This phase contains improvement recommendations from AI assistants to prepare for v1.0 release.

#### Phase 14.9.2 (Copilot Opus)

##### Error Handling & Resilience

- [x] **Centralized error notification system**
  - Silent failures in async operations (sync, storage, export) only log to console.
  - Create toast/notification system for user-facing error feedback.
  - Distinguish between transient (retry-able) and permanent (user action needed) errors.

- [ ] **Sync operation rollback mechanism**
  - `SelectTool.ts` has TODO: "Revert any in-progress changes" with no implementation.
  - Implement operation rollback for failed multi-step operations.
  - Ensure partial failures don't leave document in inconsistent state.

- [x] **Exponential backoff for WebSocket reconnection**
  - `UnifiedSyncProvider` reconnection logic could hammer server on failures.
  - Implement adaptive backoff: 1s → 2s → 4s → 8s → max 30s.
  - Add jitter to prevent thundering herd on server restart.

- [x] **Storage quota monitoring and prevention**
  - Currently throws `QuotaExceededError` reactively on save failure.
  - Proactively monitor storage usage and warn before quota exceeded.
  - Implement cleanup suggestions when approaching limits.

##### Testing Coverage

- [ ] **Store layer test coverage**
  - `documentStore.ts` - Complex shape manipulation logic untested.
  - `connectionStore.ts` - Connection state transitions tested (26 tests).
  - `teamDocumentStore.ts` - Permission logic and sync flow untested.
  - `persistenceStore.ts` - Document lifecycle operations need coverage.

- [x] **Collaboration layer test coverage**
  - `SyncStateManager.ts` - Queue processing and error recovery tested (24 tests).
  - `OfflineQueue.ts` - Queue persistence, operations, and retry logic tested (35 tests).
  - `collaborationStore.ts` - Session management and sync operations tested (29 tests).
  - `UnifiedSyncProvider.ts` - Connection state machine tested.
  - `protocol.ts` - Message encoding/decoding and size validation tested (59+ tests).

- [ ] **Edge case test scenarios**
  - Connection loss during active sync operations.
  - Offline queue overflow (100+ pending operations).
  - Concurrent edits on same shape from multiple clients.
  - Shape deletion while connector references it.
  - Group nesting cycle detection.

##### Data Integrity & Storage

- [x] **Atomic file system operations**
  - Created `AtomicFileWriter` utility with write-to-temp-then-rename pattern.
  - Updated `FileSystemBackend` to use atomic writes.
  - Added temp file cleanup on initialization and recovery on load.

- [x] **Document transfer atomicity**
  - Created `DocumentTransferService` with two-phase commit pattern.
  - Implemented prepare → execute → commit/rollback workflow.
  - Added crash recovery via localStorage persistence.
  - 24 tests covering transfer, rollback, and recovery scenarios.

- [x] **Document import validation**
  - `importJSON()` doesn't validate document structure before processing.
  - Add schema validation for imported documents.
  - Graceful handling of malformed or incompatible versions.

- [x] **Soft delete and document recovery**
  - Deleting documents is currently permanent with no recovery.
  - Implement trash/recycle bin with configurable retention.
  - Allow recovery of recently deleted documents.

##### Connector & Shape Reliability

- [x] **Anchor validation and error recovery**
  - `getConnectorStartPoint/EndPoint()` returns fallback position silently if shape not found.
  - Add warning indicators for disconnected connectors.
  - Provide UI to reconnect orphaned connector endpoints.

- [x] **Group nesting cycle detection**
  - No cycle detection when nesting groups.
  - Could create infinite hierarchies that crash rendering.
  - Validate group membership before allowing nesting.

- [x] **Typed anchor positions**
  - `AnchorPosition` is untyped string, prone to typos.
  - Create enum or const type for valid anchor positions.
  - Add validation at connector creation time.

##### Export Improvements

- [x] **Unknown shape type fallback rendering**
  - Export fails silently if `shapeRegistry.getHandler()` returns undefined.
  - Render placeholder box with shape type label for unknown types.
  - Log warning for unrenderable shapes.

- [x] **Canvas resource cleanup**
  - Export operations don't clean up canvas resources on error.
  - Implement proper cleanup in all code paths.
  - Prevent memory leaks during batch exports.

##### State Management Improvements

- [x] **Document version tracking** (partial - core infrastructure complete)
  - Added serverVersion field to Document type.
  - Created VersionConflict utilities with optimistic locking (23 tests).
  - Updated protocol, UnifiedSyncProvider, and teamDocumentStore with version support.
  - TODO: Conflict resolution UI and persistenceStore integration.

- [x] **Offline team document access**
  - Created `TeamDocumentCache` with IndexedDB persistence (17 tests).
  - Team documents loaded while online are cached for offline access.
  - `loadTeamDocument` checks cache tiers: memory → registry → IndexedDB.
  - LRU eviction (max 50 entries, 50MB) prevents unbounded growth.
  - Cache automatically updates on save and clears on delete.
  - Added "Available Offline" indicator (📴) in document list for team docs.
  - Implemented cache warmup on app start (preloads IndexedDB into memory).
  - Added stale cache refresh on reconnect (compares modifiedAt timestamps).

- [x] **Cache invalidation strategy**
  - Created `DocumentCacheManager` with TTL-based invalidation.
  - Added window focus/visibility refresh with throttling.
  - Implemented LRU eviction when max entries exceeded.
  - Added event subscription for cache monitoring.
  - 37 tests covering TTL, invalidation, eviction, and events.

- [x] **Request deduplication and debouncing**
  - Multiple store subscribers can trigger simultaneous saves.
  - Deduplicate identical in-flight requests.
  - Debounce rapid successive operations (typing, dragging).

- [x] **Token expiration handling**
  - `isTokenValid()` doesn't trigger automatic re-authentication.
  - Proactively refresh tokens before expiration.
  - Queue operations during re-authentication flow.

##### Protocol & Security

- [x] **Message size validation**
  - WebSocket protocol lacks max message size validation.
  - Add bounds checking to prevent DoS from malformed messages.
  - Implement message size limits with configurable thresholds.

- [x] **WebSocket subscription cleanup**
  - `disconnect()` clears pending requests but may leak subscriptions.
  - Audit and ensure all event listeners are removed on disconnect.
  - Add connection lifecycle logging for debugging.

### Phase 15: Version 1.0

#### Phase 15.1: Documentation Site with Starlight (Astro)

**Architecture Decision**: Use Starlight (Astro-based SSG) for unified documentation that serves both GitHub Pages and local help. Starlight provides built-in dark theme, search, and fast static output.

##### Setup & Configuration

- [x] Initialize Starlight site in `/docs-site/` directory
  - Astro + Starlight with Bun as package manager
  - Configure `astro.config.mjs` with site metadata and navigation
- [x] Configure custom dark theme
  - Customize CSS variables to match Diagrammer's color palette
  - Ensure theme toggle works seamlessly
- [x] Set up content structure in `/docs-site/src/content/docs/`
  - Getting Started guide
  - Features overview (canvas, collaboration, export, etc.)
  - Keyboard shortcuts reference
  - Shape libraries documentation
  - Settings & configuration

##### Content Migration

- [x] Migrate completed Todo.md phases into `/docs-site/src/content/docs/roadmap.md`
  - Format as release history/changelog
  - Leave future phases in Todo.md for planning
- [x] Create initial documentation pages
  - Installation & setup
  - Quick start tutorial
  - Feature guides (one per major feature area)

##### GitHub Pages Deployment

- [x] Configure GitHub Actions workflow for docs deployment
  - Build Starlight site on push to main
  - Deploy to GitHub Pages (`gh-pages` branch or `/docs` folder)
- [x] Transform README.md into professional repo homepage
  - Build status badges
  - Feature highlights with screenshots
  - Links to live documentation site
  - Quick install instructions

##### Local Help Integration

- [x] Add "Help" menu/button in Diagrammer UI
  - Opens documentation in system browser (simplest approach)
  - F1 keyboard shortcut added
- [x] Configure Tauri to bundle built docs
  - Include docs-site/dist in Tauri resources
  - Added tauri-plugin-opener for opening docs
  - Rust command `open_docs` serves bundled or falls back to online
  - TypeScript wrapper in `src/tauri/commands.ts`

#### Phase 15.2: Release Build

- [x] Create `.github/workflows/release.yml` — manual dispatch release workflow
  - `workflow_dispatch` trigger with version input and pre-release toggle
  - Semver validation gate
  - Test gate (typecheck + vitest + cargo test)
  - Auto-bump versions in `package.json`, `tauri.conf.json`, `Cargo.toml`
  - Cross-platform Tauri build (Linux: `.deb` + `.AppImage`, Windows: `.exe` + `.msi`)
  - Creates git tag `v{version}` and GitHub Release with auto-generated release notes

#### Phase 15.3: Release Pipeline (v.1.0.0-beta.1)

- [x] Workflow for GitHub releases (CI/CD pipeline)
- [x] Finalize UI polish and documentation (create release notes, update changelog, ensure all features are documented
      in README)
- [x] Commit, and await pre-release manual testing (human testing) before creating a release.

### Phase 16: Engine Improvements [v1.0.1‑beta.1]

Performance and reliability improvements deferred from Phase 14.9.

#### Data Integrity & Storage

- [x] **Blob garbage collector performance** _(Medium: ~4-6 hours)_
  - Orphan detection iterates all documents: O(n*m) complexity.
  - Implement incremental GC with reference counting.
  - Add GC progress indicator for large document stores.

- [x] **Document version tracking UI** _(Medium: ~4-6 hours)_ (infrastructure complete in 14.9.2)
  - Add conflict resolution UI (merge/overwrite/reload options).
  - Add "document changed externally" notification.
  - Integrate version tracking into persistenceStore for local docs.

#### Export Improvements

- [x] **Group-aware selection export** _(Small: ~2-3 hours)_
  - Partial selections within groups not handled correctly.
  - Either export entire group or individual selected members.
  - Add option to flatten groups on export.

#### Developer Tooling

- [x] **Release artifact checksums** _(Small: ~1-2 hours)_
  - Generate SHA-256 checksums for all release binaries (.dmg, .msi, .AppImage, .deb, .rpm).
  - Upload `checksums-sha256.txt` alongside artifacts in GitHub Releases.
  - Allows users to verify download integrity with `sha256sum -c checksums-sha256.txt`.

- [x] **Tool state machine tests** _(Medium: ~4-6 hours)_
  - `ToolManager.ts` tool switching and state transitions untested.
  - Add unit tests for tool lifecycle (activate, deactivate, transitions).
  - Test edge cases: rapid tool switches, tool switch during operation.

- [ ] **Integration test harness** _(Large: ~12-16 hours)_ → Deferred to Phase 16.9

- [x] **Export functionality tests** _(Medium: ~3-4 hours)_
  - PNG/SVG export with various shape types.
  - Selection-based export with partial group selections.
  - Export with missing shape handlers (graceful degradation).

### Phase 16.5: AI Recommendations (Claude Opus) [v1.1.0‑beta.1]

Improvement recommendations from Claude Opus to prepare for v1.0 release.

#### Performance & Optimization

- [ ] **Dirty region tracking for canvas rendering**
  - Currently the entire canvas is redrawn on each frame. Implement a dirty region system that tracks which areas need redrawing.
  - Track bounding boxes of modified shapes and only repaint affected regions.
  - Potential 2-5x performance improvement for large canvases with localized edits.

- [ ] **Shape render caching with OffscreenCanvas**
  - Cache complex shapes (groups with many children, shapes with shadows/patterns) to OffscreenCanvas.
  - Invalidate cache only when shape properties change.
  - Particularly beneficial for groups with background patterns and shadow effects.

- [ ] **Virtual scrolling for LayerPanel**
  - LayerPanel renders all shapes in the DOM, which degrades with 100+ shapes.
  - Implement windowed rendering (react-window or custom) to only render visible items.
  - Include smooth scroll position restoration when collapsing/expanding groups.

- [x] **Lazy loading for shape libraries**
  - Load flowchart/UML/ERD shape handlers on-demand rather than at startup.
  - Use dynamic imports with loading states in ShapePicker.
  - Reduces initial bundle size and memory footprint.

- [x] **Spatial index incremental updates**
  - Currently rebuilds entire RBush index on shape changes. Implement incremental insert/remove/update.
  - Track which shapes changed and update only those entries.
  - Critical for smooth performance during drag operations on large canvases.

#### User Experience

- [x] **Quick action palette (Cmd/Ctrl+K)**
  - Fuzzy-searchable command palette for all actions: tools, alignment, export, settings, etc.
  - Include recent commands and context-aware suggestions.
  - Similar to VS Code's command palette or Linear's Cmd+K.

- [x] **Keyboard shortcut reference panel**
  - Accessible via `?` key or Help menu.
  - Categorized list of all shortcuts with search/filter.
  - Consider printable cheat sheet export.

- [x] **Shape search in canvas**
  - Ctrl+F to search shapes by label text, type, or custom properties.
  - Highlight matches and provide navigation (next/previous).
  - Integrate with existing layer view filtering.

- [x] **Zoom to fit selection** _(Already implemented: `Camera.zoomToFit()` + `zoomToFitAnimated()`)_
  - Button/shortcut to zoom and pan camera to frame selected shapes with padding.
  - Also add "Zoom to fit all" for entire document.
  - Smooth animated transition rather than instant jump.

- [x] **Smooth pan/zoom animations**
  - Add easing to camera transitions (zoom to fit, minimap navigation, etc.).
  - Use requestAnimationFrame-based interpolation.
  - Configurable animation duration in settings.

- [x] **Multi-select property editing improvements**
  - When multiple shapes selected, show "Mixed" for differing values.
  - Allow editing to apply to all selected shapes.
  - Show count of selected shapes in PropertyPanel header.

- [x] **Drag-and-drop shape creation**
  - Drag shapes from ShapePicker directly onto canvas (not just click-to-place).
  - Show ghost preview during drag.
  - More intuitive than current tool selection workflow.

- [x] **Touch/tablet gesture refinements**
  - Two-finger pinch zoom with proper anchor point.
  - Three-finger pan gesture.
  - Apple Pencil pressure sensitivity for line width (future).

#### Stability & Quality

- [x] **React error boundaries for crash recovery**
  - Wrap major UI sections (PropertyPanel, LayerPanel, DocumentEditor) in error boundaries.
  - Display user-friendly error message with "Reload" option.
  - Log errors to console with stack trace for debugging.

- [ ] **Performance regression benchmarks**
  - Automated benchmark: render 1000/5000/10000 shapes, measure FPS.
  - Track metrics over time to catch regressions.
  - Alert if performance drops below threshold.

- [ ] **Accessibility audit and improvements**
  - ARIA labels for all interactive elements.
  - Keyboard navigation through all panels and menus.
  - High contrast mode support.
  - Screen reader announcements for state changes.

- [x] **Graceful WebSocket reconnection feedback**
  - Clear UI indication when connection is lost/reconnecting.
  - Queue indicator showing pending changes.
  - Manual "Retry" button after max reconnection attempts.

#### Developer Experience

- [x] **Debug overlay improvements**
  - Toggle-able overlay showing: spatial index bounds, hit test regions, render stats.
  - Shape inspector: click shape to see all properties in dev panel.
  - Accessible via settings or keyboard shortcut (Ctrl+Shift+D).

- [ ] **Shape handler development template**
  - CLI command or template to scaffold new shape handlers.
  - Include all required handler methods with TypeScript stubs.
  - Auto-register in ShapeRegistry.

- [x] **Plugin development documentation**
  - Document PanelExtensions registry API.
  - Example plugins: custom shape library, property panel section, export format.
  - Guidelines for state management and lifecycle.

#### Quality-of-Life Improvements

- [ ] **Template gallery**
  - Starter templates: Flowchart, Org Chart, ERD, Network Diagram, Wireframe.
  - New document dialog with template selection.
  - Allow users to save documents as custom templates.

- [x] **Duplicate page functionality** _(Already implemented: `pageStore.duplicatePage()`)_
  - Right-click page tab → "Duplicate Page".
  - Deep-clone all shapes with new IDs.
  - Useful for iterating on diagram variations.

- [x] **Shape locking visual indicator**
  - Show lock icon overlay on locked shapes in canvas.
  - Different indicators for position-locked vs fully-locked.
  - Makes lock state discoverable without checking PropertyPanel.

- [ ] **Undo/redo improvements**
  - Show action description in tooltip ("Undo: Move Rectangle").
  - Consider branching undo history for complex workflows.
  - Keyboard shortcut for redo: Ctrl+Y in addition to Ctrl+Shift+Z.

### Phase 16.6: Icon System Improvements [v1.1.0‑beta.2]

Expand and enhance the icon system with large tech icon libraries and flexible styling options.

#### Bug Fixes

- [x] **Icon style not saving to style profiles**
  - Setting "Save Icon Style to Style Profile" in Settings > Style Profile doesn't work.
  - Icon-related properties (iconId, iconSize, iconPadding) are not persisted when saving a style profile.
  - Fix StyleProfileProperties type and save/apply logic to include icon properties.

#### Icon Styles & Placement

- [ ] **Icon placement modes**
  - Current: Inside placement (icon badge in top-left corner).
  - Add new modes: badge overlay (with adjustable background), centered icon, icon-only (no shape background).
  - Badge mode: configurable background color, shape (circle, rounded-rect, square), and padding.
  - PropertyPanel dropdown for selecting icon placement mode.

- [ ] **Icon badge backgrounds**
  - Solid color backgrounds for icon badges.
  - Optional border/outline for badges.
  - Transparency/opacity control.

#### Tech Icon Library Expansion

- [ ] **Large tech icon library with lazy loading**
  - AWS architecture icons (compute, storage, database, networking, etc.).
  - Azure architecture icons.
  - Google Cloud Platform icons.
  - Kubernetes, Docker, and container ecosystem icons.
  - Programming language and framework icons.
  - Database icons (PostgreSQL, MySQL, MongoDB, Redis, etc.).
  - Use SVG sprite sheets or individual lazy-loaded SVGs to minimize bundle size.
  - Organize into searchable categories in IconPicker.

- [ ] **Icon library loading optimization**
  - Load icon categories on-demand (not at startup).
  - Implement icon search across all categories without loading full sets.
  - Cache loaded icons in memory with LRU eviction.
  - Show loading skeleton while icons are fetched.

### Phase 16.7: Application Backup & Recovery [v1.1.0‑beta.2]

Comprehensive backup system for transferring and recovering all application data.

#### Backup System

- [ ] **Full application backup export**
  - Export all local documents as a single archive (.diagrammer-backup or .zip).
  - Include all blob storage (images, icons, embedded files).
  - Include style profiles, color palettes, and custom shape libraries.
  - Include application settings and preferences.
  - Progress indicator for large backups.

- [ ] **Backup import/restore**
  - Import backup archive and restore all data.
  - Option to merge with existing data or replace entirely.
  - Conflict resolution UI for duplicate documents/profiles.
  - Validation of backup integrity before restore.

- [ ] **Selective backup options**
  - Choose which data to include: documents, blobs, settings, libraries.
  - Per-document export with dependencies (all referenced blobs included).
  - Export selected documents only.

- [ ] **Backup UI in Settings**
  - Backup/Restore tab in Settings modal.
  - Last backup timestamp display.
  - Backup size estimation before export.
  - Restore preview showing what will be imported.

### Phase 16.9: Deferred Improvements [v1.1.0‑beta.2]

Tasks deferred from Phase 16.

#### Connector & Shape Improvements

- [ ] **Lazy connector route rebuilding** _(Large: ~8-12 hours)_
  - `rebuildAllConnectorRoutes()` rebuilds ALL connectors on any change.
  - Implement incremental updates for only affected connectors.
  - Cache connector routes and invalidate on shape changes.

#### Developer Tooling

- [ ] **Integration test harness** _(Large: ~12-16 hours)_
  - No end-to-end tests for collaborative workflows.
  - Create test utilities for multi-client scenarios.
  - Add CI job for integration test suite.

### Phase 17: Embedded Files [RELEASE v1.2.0‑beta.1]

File embedding system for PDFs, spreadsheets, and other assets. Uses reference-based architecture with lazy loading to maintain canvas performance.

#### Architecture Decisions

- **Modal viewer pattern**: Content viewed in modal, not in-place rendered on canvas (preserves 60fps target)
- **Thumbnail on canvas**: Cached preview thumbnail + file icon/name displayed as shape
- **Reference-based storage**: Shapes hold `blobRef` (SHA-256 hash), actual files in BlobStorage
- **Lazy loading tiers**: Off-screen (nothing) → On-screen (thumbnail) → Modal open (full content)
- **Separate blob sync**: HTTP endpoints for large files, WebSocket for shape metadata only

#### Phase 17.1: Core Infrastructure

- [ ] **FileShape type definition** (`src/types/FileShape.ts`)
  - Extends BaseShape with: `blobRef`, `fileName`, `mimeType`, `fileSize`
  - Preview metadata: `thumbnail` (base64), `pageCount`, `dimensions`
  - Supported categories: `pdf`, `spreadsheet`, `generic`

- [ ] **File shape handlers** (`src/shapes/files/`)
  - `BaseFileHandler.ts` — Common: bounds, selection, download action
  - `PdfHandler.ts` — PDF icon, page count badge, thumbnail render
  - `SpreadsheetHandler.ts` — Table icon, row/column count badge
  - `GenericFileHandler.ts` — File type icon + filename fallback
  - Register all handlers in ShapeRegistry

- [ ] **Thumbnail generation service** (`src/services/ThumbnailGenerator.ts`)
  - Web Worker for non-blocking generation
  - PDF: Render page 1 at ~400px width via pdf.js → JPEG blob
  - XLSX/CSV: Generate mini-table preview or use generic icon
  - Store thumbnail in shape's `preview.thumbnail` field

#### Phase 17.2: Content Viewer Modal

- [ ] **FileViewerModal component** (`src/ui/FileViewerModal.tsx`)
  - Full-screen modal with close button, download, replace actions
  - File type detection and appropriate viewer dispatch

- [ ] **PDF viewer** (`src/ui/viewers/PdfViewer.tsx`)
  - pdf.js integration for rendering
  - Page navigation (prev/next, page number input)
  - Zoom controls
  - Lazy page loading (render visible pages only)
  - BONUS: Cache the viewer's position in the document upon close

- [ ] **Spreadsheet viewer** (`src/ui/viewers/SpreadsheetViewer.tsx`)
  - SheetJS (xlsx) for parsing XLSX/CSV
  - Table rendering with virtual scrolling for large datasets
  - Sheet tabs for multi-sheet workbooks
  - Basic cell formatting preservation

- [ ] **Generic file viewer** (`src/ui/viewers/GenericFileViewer.tsx`)
  - File icon, name, size, type display
  - Download button
  - "No preview available" message

#### Phase 17.3: File Import Flow

- [ ] **File drop/upload handling**
  - Drag-and-drop files onto canvas
  - File picker via toolbar or context menu
  - Validate file types and size limits

- [ ] **Import pipeline**
  - Store file in BlobStorage (content-addressed)
  - Generate thumbnail (async, Web Worker)
  - Create FileShape at drop position
  - Update spatial index

#### Phase 17.4: Storage Manager Integration

- [ ] **Files tab in Storage Manager**
  - List all embedded files with: name, type, size, reference count
  - Preview thumbnails where available
  - Show which documents reference each file
  - Orphan detection (files with no shape references)
  - Delete/replace individual files

- [ ] **Storage references checker extension**
  - Update `BlobGarbageCollector` to scan FileShape `blobRef` fields
  - Protect files referenced by any document
  - Handle thumbnail blobs if stored separately

#### Phase 17.5: Collaboration Support

- [ ] **HTTP blob endpoints** (Rust backend)
  - `POST /api/blobs/:hash` — Upload blob with hash verification
  - `GET /api/blobs/:hash` — Download blob by hash
  - `HEAD /api/blobs/:hash` — Check blob existence
  - Chunked upload/download for large files (>10MB)
  - Authentication via JWT token header

- [ ] **Blob sync protocol**
  - On shape sync, client checks if blob exists locally
  - If missing, fetch via HTTP endpoint
  - Progress indicator for large file downloads
  - Retry logic with exponential backoff

- [ ] **AssetBundler extension**
  - Update `bundleDocumentWithAssets()` to include file blobs
  - Handle large files (consider compression or external references)

#### Phase 17.6: Polish & Edge Cases

- [ ] **File replacement flow**
  - Replace file contents while keeping shape position/size
  - Regenerate thumbnail
  - Update all references atomically

- [ ] **Error handling**
  - Corrupt file detection on import
  - Missing blob recovery (prompt to re-upload)
  - Unsupported file type graceful fallback

- [ ] **Memory management**
  - Unload full PDF/spreadsheet content when modal closes
  - LRU cache for recently viewed file content
  - Thumbnail-only mode for low-memory situations

### Phase 18: Advanced Diagram Patterns [RELEASE v1.3.0‑beta.1]

- [ ] Sequence diagram patterns
- [ ] Activity diagram patterns + Swimlane customization

#### Phase 18.1: Sticky Notes

- [ ] **StickyNote shape type** (`src/shapes/StickyNote.ts`)
  - Postit-like appearance with folded corner effect
  - Configurable background color (default yellow palette: yellow, pink, blue, green, orange)
  - Rich text content support (bold, italic, bullet lists)
  - Auto-resize based on content or fixed size with overflow handling
  - Drop shadow for "lifted paper" effect

- [ ] **Anchor modes**
  - **Canvas mode** (default): Note exists in world space, moves with pan/zoom like other shapes
  - **Screen mode**: Note anchored to viewport corner (top-left, top-right, bottom-left, bottom-right)
  - Screen-anchored notes persist across pages and zoom levels
  - Toggle anchor mode via context menu or PropertyPanel

- [ ] **StickyNoteTool** (`src/tools/StickyNoteTool.ts`)
  - Click-to-place with default size
  - Drag-to-size for custom dimensions
  - Immediate inline editing on creation

- [ ] **PropertyPanel integration**
  - Color picker with sticky note palette
  - Anchor mode toggle (canvas/screen + corner selector for screen mode)
  - Font size and alignment controls
  - Transparency/opacity slider

- [ ] **Screen-anchored note rendering**
  - Render after main canvas in screen space (not affected by camera transform)
  - Maintain position relative to viewport on resize
  - Z-order always above canvas content
  - Draggable within viewport bounds

- [ ] **Persistence**
  - Canvas notes: stored in document like other shapes
  - Screen notes: stored in document metadata with viewport-relative positions
  - Export: include canvas notes in PNG/SVG; exclude or optionally include screen notes

### Future: Auto-Update

- [ ] Implement a feature which can scan the GitHub repo for updates and check if a new version exists
- [ ] Implement a feature to update the application **without** user commands or manual download+installation

### Future: Publisher Module

- [ ] Implement a 'Publisher' module to implement the following requirements:
  - [ ] Create publish configurations to manage the publisher's export locations
  - [ ] Run a publish configuration to export various types of media (e.g. PDF, SVG, JSON) to a single, or multiple configured paths on the computer.
  - Keep it extensible to support exporting to cloud locations in the future.

### Future: Document Cloud Providers

- [ ] Implement support

### Future: Comprehensive Local Help System

- [ ] Implement a local help documentation system with integrated search and navigation
- [ ] Create a comprehensive help guide for the application

### Future: Advanced Themes

- [ ] Implement Advanced Themes

### Future: Cross-Platform Memory Profiling

Comprehensive memory analysis across Windows, Linux (WebKitGTK), and macOS to identify platform-specific behaviors and potential leaks.

- [ ] **Baseline memory profiling**
  - Document normal memory usage per platform (WebView2 vs WebKitGTK vs WKWebView)
  - Establish acceptable memory ranges for idle, active editing, and heavy usage
  - Track memory over extended sessions (8+ hours)

- [ ] **Leak detection suite**
  - Create reproducible test scenarios (create/delete pages, add/remove shapes, image upload/delete)
  - Heap snapshot comparison before/after operations
  - Identify retained objects (ProseMirror state, detached DOM, blob URLs)

- [ ] **Platform-specific investigation**
  - WebKitGTK memory characteristics on Linux (PopOS, Ubuntu, etc.)
  - AppArmor/sandboxing impact on memory reporting
  - Garbage collection timing differences

- [ ] **Cleanup improvements** (if leaks found)
  - Revoke blob object URLs when no longer needed
  - Clear ProseMirror transaction history on page switch
  - Ensure proper React component unmount cleanup

### Future: Canvas Code Integration with Git

- [ ] Implement a composable VCS pattern which allows interfacing with Git for version control and file usage, and
      others in the future
- [ ] Implement file(s) linking to a shape which can be viewed in the property panel
- [ ] Integrate with existing Git integration for version control (save changes to Git repo; default directory is
      /docs/diagrammer.json)
- [ ] Feat: Spawn a VS Code instance with access to Git repo

### Future: AI Model Integration

#### Architecture: Semantic Abstraction Layer

AI should reason about **relationships and entities**, not coordinates. The app handles spatial layout.

**AI Output Schema** (no X/Y coordinates):
```typescript
interface AIGraphOutput {
  diagram_type: 'flowchart' | 'erd' | 'class-diagram' | 'sequence' | 'network';
  nodes: Array<{
    id: string;
    type: string;          // maps to shape type
    label: string;
    attributes?: string[]; // for ERD entities, class members, etc.
  }>;
  edges: Array<{
    from: string;          // node id
    to: string;            // node id
    label?: string;
    cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-many';
  }>;
  layout_hint?: 'hierarchical' | 'force-directed' | 'grid' | 'radial';
}
```

**Near-Node Placement** (for incremental edits):
```typescript
interface PlacementHint {
  near: string;                              // existing shape ID or label
  direction: 'above' | 'below' | 'left' | 'right' | 'auto';
  offset?: 'compact' | 'normal' | 'spacious';
}
```

**Layout Engine** converts semantic graph → positioned shapes:
- Hierarchical (dagre): flowcharts, org charts, trees
- Force-directed (d3-force): ERDs, network diagrams
- Near-node resolver: incremental additions with overlap avoidance

#### Deliverables

- [ ] **Layout Engine** (`src/services/LayoutEngine.ts`)
  - dagre integration for hierarchical layouts
  - d3-force integration for force-directed layouts
  - Near-node placement resolver
  - Overlap avoidance with existing shapes
  - Diagram type → layout strategy mapping

- [ ] **AI Service** (`src/services/AIService.ts`)
  - Provider abstraction (Claude, OpenAI, Ollama)
  - System prompt with diagram domain context
  - Structured output schema validation
  - Tool call execution pipeline

- [ ] **AI Assistant Panel** (`src/ui/AIAssistantPanel.tsx`)
  - Text input for natural language requests
  - "Generate Diagram" from description
  - "Improve Selection" for existing shapes
  - "Explain Diagram" for documentation
  - Provider selection in settings

- [ ] **Schema Validator** (`src/services/AISchemaValidator.ts`)
  - Validate node types against shape libraries
  - Map diagram_type to appropriate shapes
  - Graceful fallback for unknown types

- [ ] Implement AI-powered diagram analysis
- [ ] Generate insights and suggested edits

### Future: Enterprise Edition (Paid)

A commercially licensed tier targeting teams and organizations, built on top of the free open-source core.

#### Scalable Collaboration Server
- [ ] Replace single-host Tauri WebSocket server with a dedicated, horizontally scalable collaboration server
- [ ] Implement a room/session broker that distributes document sessions across server instances
- [ ] Add connection pooling, backpressure, and graceful degradation under load
- [ ] Support configurable persistence backends (PostgreSQL, Redis, S3) for CRDT state
- [ ] Provide Docker / Kubernetes deployment manifests and Helm chart

#### Cloud Storage Connectors
- [ ] Implement a storage provider abstraction layer (local FS, S3, Azure Blob, GCS)
- [ ] Add OAuth-based linking for Google Drive, OneDrive, Dropbox
- [ ] Support read/write of diagrams directly from cloud storage
- [ ] Implement cross-provider sync and conflict resolution

#### Enterprise Plugin System
- [ ] Webhook plugin — outbound event notifications (document created/updated/deleted, user joined/left)
- [ ] Audit log plugin — structured, queryable logs of all document and user events
- [ ] SSO/SAML plugin — integrate with corporate identity providers (Okta, Azure AD, etc.)
- [ ] RBAC plugin — role-based access control for documents, pages, and team workspaces
- [ ] Data retention plugin — configurable retention policies and automated purging

#### Security & Compliance
- [ ] End-to-end encryption for document content in transit and at rest
- [ ] Per-document encryption key management (envelope encryption)
- [ ] Signed export artifacts (PDF, SVG) with tamper-evident checksums
- [ ] SOC 2 / GDPR compliance documentation and data handling controls

#### Advanced Observability
- [ ] Structured server logging with configurable verbosity (JSON, stdout, syslog)
- [ ] Prometheus metrics endpoint (connections, sync latency, document ops/sec)
- [ ] OpenTelemetry tracing for request lifecycle visibility
- [ ] Admin dashboard for server health, active sessions, and storage usage

---

## Testing Notes

- Mark tasks with [x] when completed
- Update this file as new tasks are discovered
- Each task should be small enough to complete in one session
- Test each component before moving to the next phase
- Total tests: 1045 passing (32 test files)

## Test Coverage by Module

| Module                           | Tests   |
| -------------------------------- | ------- |
| Math (Vec2, Mat3, Box, geometry) | 204     |
| Camera                           | 58      |
| InputHandler                     | 41      |
| Renderer                         | 33      |
| SpatialIndex                     | 24      |
| HitTester                        | 24      |
| DocumentStore                    | 37      |
| SessionStore                     | 37      |
| PageStore                        | 32      |
| HistoryStore                     | 19      |
| Rectangle                        | 21      |
| Ellipse                          | 25      |
| Line                             | 23      |
| Shape transforms                 | 31      |
| Shape bounds                     | 24      |
| Collaboration (protocol, sync)   | 200+    |
| Storage (cache, trash, versions) | 80+     |
| connectionStore                  | 26      |
|                                  |         |
| **Total**                        | **1045**|

