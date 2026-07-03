---
title: Settings
description: DocuShark settings — appearance, theme, collaboration server, storage, and editor preferences.
---

# Settings

Access settings via the **Settings** button in the toolbar.

## General

| Setting | Options | Description |
|---------|---------|-------------|
| Theme | System / Light / Dark | Color theme for the application |
| Default Shape Style Profile | Dropdown | Style profile applied to new shapes |
| Default Connector Type | Orthogonal / Straight | Default routing for new connectors |
| Show Static Properties | On/Off | Show read-only properties in Property Panel |
| Hide Default Style Profiles | On/Off | Hide the 5 built-in profiles from the Style Profile list |

### Style Profile Settings

| Setting | Options | Description |
|---------|---------|-------------|
| Save Icon Style to Profile | On/Off | Include icon settings when saving a style profile |
| Save Label Style to Profile | On/Off | Include label settings when saving a style profile |

## Canvas

### Minimap

| Setting | Options | Description |
|---------|---------|-------------|
| Show Minimap | On/Off | Display minimap overlay on canvas (experimental) |

### Layer Panel

| Setting | Options | Description |
|---------|---------|-------------|
| Snap to Layer on Click | On/Off | Automatically pan to a shape when clicking it in the Layer Panel |

## Documents

The Documents section of settings provides document management:

- **Create** new documents
- **Import/Export** documents as JSON
- View and manage **local documents**
- View and manage **remote/cached team documents** (when collaboration is active)
- **Delete** documents (sent to trash with configurable retention)

## Shape Libraries

Manage custom shape libraries:

- **Create** new libraries
- **Rename** and **delete** custom libraries
- **Export** libraries as JSON for sharing
- **Import** libraries from JSON files

Built-in libraries (Basic, Flowchart, UML, ERD) cannot be deleted.

## Storage

View and manage stored data:

- **Blob storage**: View stored images and icons with metadata
- **Garbage collection**: Clean up orphaned blobs (icons are protected by default)
- Storage usage statistics

## Workspace (Collaboration)

Connecting to a workspace happens from **Documents Home**, not this Settings window — look for the Cloud panel. From there you can sign in with DocuShark Cloud, see your signed-in identity, and disconnect.

For how collaboration works and how to connect, see
**[Collaboration](./collaboration)**.

## PDF Export

Configure PDF export defaults:

| Setting | Options | Description |
|---------|---------|-------------|
| Page Size | A4, Letter, A3, Tabloid | Document page size |
| Orientation | Portrait / Landscape | Page orientation |
| DPI | Standard (72), High (150), Print (300) | Render quality |
| Page Numbers | On/Off | Include page numbers |
| Cover Page | On/Off | Include a cover page with logo, title, author, etc. |
