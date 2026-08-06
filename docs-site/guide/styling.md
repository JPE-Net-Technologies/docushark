---
title: Styling & Themes
description: Style shapes individually with the properties panel, save reusable style profiles, and switch app-wide themes.
---

# Styling & Themes

DocuShark gives you flexible control over how your diagrams look — from individual shape styles to app-wide themes.

## Themes

Switch between **Dark**, **Light**, and **System** — and build your own colour
theme — in **Settings → Appearance**.

The theme affects the entire application — toolbar, panels, canvas background, and the grid. Your diagrams themselves use the colors you choose, so they look the same regardless of theme. For the full theme builder (custom colours, presets, density, and more), see [Appearance & Customization](/guide/appearance).

## Shape Styling

Every shape has styling properties you can adjust in the Property Panel:

| Property | What It Controls |
|----------|-----------------|
| **Fill** | Background color and opacity |
| **Stroke** | Border color, width, and style (solid, dashed, dotted) |
| **Shadow** | Drop shadow color, blur, and offset |
| **Opacity** | Overall shape transparency |
| **Text** | Font, size, color, alignment |

Select a shape and tweak these in the Property Panel on the right side of the screen.

## Style Profiles — your branding kit

Think of a style profile less as a "saved preset" and more as a **branding kit**: it remembers how a shape type should look — fill, stroke, font, shadow, icon treatment — so a whole document (or every document you make) can share one consistent visual identity instead of you restyling shapes by hand every time.

### Saving a Style Profile

1. Style a shape exactly how you want it (fill, stroke, font, shadow, etc.)
2. Right-click the shape → **Save Style**
3. Give your profile a name — something like your team or product name works well, since this is the kit you'll reuse everywhere

### Applying a Style Profile

1. Select one or more shapes
2. Open the **Style** dropdown in the Property Panel
3. Choose a saved profile — all the styling applies instantly

Because a profile can remember per-shape-type styling, applying the same kit across a mixed selection (rectangles, connectors, text) gives you one cohesive look in a single click, instead of restyling each shape type separately.

### Managing Profiles

Go to **Settings → Style Profiles** to:

- View your saved profiles
- Delete profiles you no longer need
- Toggle **Hide Default Style Profiles** to hide the 5 built-in profiles
- Control whether icon and label settings are included when saving profiles

### Using your profiles on more than one device

A style profile starts out on the device you made it on. When you're signed in
to a workspace you can share one across every device you use:

1. Right-click the profile in the Style Profiles panel
2. Choose **Sync to workspace**

A synced profile shows a small cloud marker, and appears automatically the next
time you sign in to that workspace somewhere else. Editing a synced profile
updates it for everyone in the workspace.

To pull down changes someone else made, use **Refresh** in the panel header.
Profiles refresh when you ask them to rather than continuously — your styles are
a working set, and having them change underneath you mid-edit would be worse
than a button.

**Stop syncing** moves a profile back to being yours alone. It stays on the
device you're using and is removed from the workspace, so other people lose
their copy — you'll be asked to confirm.

::: tip Profiles you haven't synced stay put
Existing profiles are never uploaded automatically, including when you sign in
for the first time. Syncing is always something you choose.
:::

### How profiles count toward storage

Synced profiles are stored in your workspace, so they count toward its storage
allowance under **Configuration** — shown as its own line alongside Documents
and Files in the storage meter.

In practice this is a rounding error: a profile holds a few dozen style values,
so a thousand of them is a fraction of a megabyte. The line exists so nothing in
your workspace is unaccounted for, not because styling is expected to compete
with your documents for space.

## Color Palettes

DocuShark maintains a color palette that remembers your recently used colors. When you pick a fill or stroke color, you'll see:

- A set of preset colors
- Your recent colors from the current session

This makes it easy to maintain a consistent color scheme across your diagram.

## Default Styles

Set default styling for new shapes so you don't have to restyle every shape you create:

1. Go to **Settings → General → Default Shape Style Profile**
2. Select a style profile from the dropdown
3. All new shapes you create will use that profile's styling

You can also set the **Default Connector Type** (Orthogonal or Straight) in the same settings area.

## Tips

- **Batch styling**: Select multiple shapes with Shift+Click, then change a property — it applies to all selected shapes
- **Consistency**: Create style profiles early in your project for a consistent look
- **Dark mode diagrams**: If your diagram will be viewed on both light and dark backgrounds, avoid very dark fills — use medium tones instead
