---
title: Settings
description: DocuShark settings — appearance, theme, style profiles, backup, and editor preferences.
---

# Settings

Open settings with the **Settings** button in the toolbar. Settings opens as a
full-screen sheet over your document; **Close** (top right) or `Esc` returns you
to where you were.

Controls are grouped into **tiles**. Each tile leads with an icon, names one
setting, and carries its own control and help text — the same tiles you see in
the [layout menu](./layout-modes#switching-layouts), so the two work the same way.

Five tabs, down the left:

| Tab | What lives there |
|---|---|
| **General** | Shape defaults and display toggles |
| **Appearance** | Theme, writing, interface, and panel layout |
| **Style Profiles** | What a new style profile captures |
| **Backup & Restore** | Export and restore your data |
| **About** | Build identity for the app and the workspace it's connected to |

::: tip Where did Documents, Storage and Shape Libraries go?
They're first-class surfaces now, not settings tabs — you'll find them on
**Documents Home** rather than in this window.
:::

## General

| Setting | Options | Description |
|---------|---------|-------------|
| Default style profile | Dropdown | Style profile applied to new shapes |
| Static properties | On/Off | Show read-only properties (like ID) in the Property Panel |
| Hide default style profiles | On/Off | Show only your custom profiles in the Property Panel |
| Minimap | On/Off | Minimap overlay for navigating large canvases (experimental) |
| Auto-focus on layer click | On/Off | Pan the camera to a shape when you click it in the Layers panel |

**Reset settings** returns everything on this tab to its shipped value.

## Appearance

### Theme

| Setting | Options | Description |
|---------|---------|-------------|
| Base | System / Light / Dark | The light or dark foundation |
| Presets | Preset chips | Start from a preset, then fine-tune |
| Primary / CTA / Surface / Text | Color | Individual color slots. Unset slots read **Auto** and are derived for you |

Light and dark are customized **independently** — switch Base to edit the other
one. **Surprise me** generates a random but legible theme, and **Reset … theme**
returns the base you're editing to its default.

Color slots warn inline when a choice falls below a readable contrast ratio.

### Writing

| Setting | Options | Description |
|---------|---------|-------------|
| Prose background | Preset chips | The backdrop behind the writing area |
| Caret style | Bar / Block | The text cursor shape |
| Smooth writing | On/Off | Glide the caret between positions. Off automatically when motion is reduced |
| Rounded tables | On/Off | Off gives square, grid-style tables |
| Caret color | Color | Defaults to the theme text color |
| Spellcheck | Custom / System / Off | Custom uses DocuShark's dictionary and "Add to dictionary"; System uses your browser or OS checker. Only one runs at a time |

### Interface

| Setting | Options | Description |
|---------|---------|-------------|
| Interface size | 90–125% | Scales the whole interface. The canvas and your diagrams are not affected |
| Grid opacity | 0–100% | How visible the canvas grid is; 0 hides it |
| Density | Compact / Normal / Spacious | Compact fits more on screen; Spacious gives larger targets |
| Motion | System / Reduced / Full | System follows your device's accessibility setting |
| Glass chrome | On/Off | Translucent, blurred panels. Off is flat and opaque — lighter to render |
| Mobile preview | On/Off | Experimental small-screen layout. See [Mobile preview](./mobile-preview) |
| DocuShark title bar | On/Off | Desktop app only. Replaces your system title bar; restarts to apply |

Interface size and Grid opacity are drag tiles — drag anywhere on the tile, or
focus it and use the arrow keys.

### Layout

The panel-arrangement editor is embedded here: per-layout dock positions for
each panel, and a reset. See **[Layout modes](./layout-modes)**.

**Reset appearance** returns theme, motion, density, interface size and layout
customization to their defaults.

## Style Profiles

What gets captured when you create a new style profile from a shape.

| Setting | Options | Description |
|---------|---------|-------------|
| Icon style | On/Off | Icon ID, size and padding |
| Label style | On/Off | Label font size, color, background and offset |

These apply to **new** profiles only — existing profiles keep the properties
they were saved with.

## Backup & Restore

Export your documents, style profiles and preferences to a single archive, and
restore from one. See **[Export & import](./export-import)** for the full workflow.

## About

Build identity for the running app — version, commit, build time and platform —
and, when you're connected to a workspace, the same for its server.

## Related settings elsewhere

Some things that feel like settings live closer to where you use them:

- **Connecting to a workspace** — Documents Home, in the Cloud panel. See
  [Collaboration](./collaboration).
- **Storage usage and cleanup** — Documents Home. The storage ring breaks usage
  into Documents, Files and Configuration; select it for the full breakdown.
- **Default connector routing** — remembered from your last choice in the canvas
  toolbar's connector dropdown, rather than set here.
- **PDF export options** (page size, orientation, DPI, page numbers, cover page)
  — chosen in the export dialog at export time. See [Export & import](./export-import).
