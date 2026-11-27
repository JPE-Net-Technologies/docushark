---
title: Make it yours
description: Layouts and panels, themes and the rest of Appearance, style profiles for reusable shape styles, every setting at a glance, and DocuShark on a phone.
---

# Make it yours

How much is on screen, how DocuShark looks, and how your diagrams are styled are yours to choose. This page covers layouts, appearance, style profiles and the rest of **Settings** (the button at the top right), then DocuShark on a phone. These choices belong to you on this device; they never change a document for anyone else.

## Layouts {#layouts}

A layout decides how much tooling surrounds your work. The four are levels, not modes for different people: switch whenever the work changes.

| Layout | What you get |
|---|---|
| **Relaxed** (the default) | Writing first, in a comfortable reading column, with the canvas one click away. |
| **Designer** | The canvas first, with your writing one click away. |
| **Technician** | Writing and canvas side by side; Properties flies out when you need it. |
| **Power** | Everything on screen at once, at the tightest spacing. |

**Switch** with the layout button at the top (it shows a preview of each), with `Ctrl+Shift+1` to `4`, or with **Switch to … layout** in the command palette. The same menu's **Panels** section shows or hides the **Document**, **Properties**, **Layers** and **Navigator** panels, which is the quickest way to bring back a panel you've hidden; the Navigator starts hidden in every layout.

**Write · Split · Canvas** at the top of Relaxed changes what fills the window: your writing alone, writing and canvas side by side, or the canvas. `Ctrl+Shift+\` cycles them. In a narrow window, Split shows one at a time.

The layout applies to the whole app, not one document, and changes you make to one layout stay with it. To arrange each layout's panels, choose **Customize layout…** at the bottom of the layout menu, which opens **Settings → Appearance → Layout**: for every layout, which panels show, which side each docks on, and which stay pinned open. You can also right-click a panel's header to move it to the other side, hide it or pin it. **Reading width** there sets how wide the writing column grows: **Normal** suits a laptop, **Wide** a large display.

## Appearance {#appearance}

![Settings → Appearance: Base (System, Light or Dark), presets including Surprise me, the Primary, Call-to-action, Surface and Text colours, and below them the prose backdrops and caret style.](/screenshots/settings-appearance.png)

**Settings → Appearance** changes the app around your work. Your diagrams keep their own colours, so they look the same in the light and dark themes.

**Theme.** Choose a **Base**: **System** (following your device), **Light** or **Dark**. Light and dark are edited separately; switch the base to edit the other. Start from a preset (**Default**, **Ocean**, **Forest**, **Plum** or **Ember**), or **Surprise me** for a random theme that stays readable, then set the **Primary**, **Call-to-action**, **Surface** and **Text** colours. A colour that would be hard to read shows a **Low contrast** warning. **Reset** returns the base you're editing to its default.

**Writing:**

- **Prose background:** the backdrop behind your writing (**Default**, **Flat**, **Glow** or **Aurora**), in your theme's colours.
- **Caret:** a thin **Bar** or a **Block**; **Smooth writing** glides it between positions as you type; and its colour.
- **Rounded tables:** off gives square, grid-style tables.
- **Formatting on selection:** the small bar beside selected text.
- **Spellcheck:** **Custom** (DocuShark's dictionary, with **Add to dictionary**), **System** (your browser's or computer's) or **Off**.

**Interface:**

- **Interface size** scales menus and panels from 90% to 125%, without changing the canvas or your diagrams.
- **Grid opacity** sets how visible the canvas grid is.
- **Interface font:** **System** (your computer's own, the default) or **Inter**. A document's own font is chosen in the ribbon ([Write](./write#document-font)).
- **Density:** **Compact**, **Normal** or **Spacious**.
- **Motion:** **System** follows your device's accessibility setting; **Reduced** and **Full** override it.
- **Glass chrome:** translucent panels; off is flat, and lighter to draw.
- **Mobile preview:** see [On a phone](#phone).
- **DocuShark title bar** (desktop app only): replaces your system's window title bar; the app restarts to apply it.

**Reset appearance**, at the bottom, returns the theme, motion, density, size and layouts to their defaults.

## Style profiles {#style-profiles}

A style profile is a style kit. It remembers how each kind of shape should look, such as rectangles, connectors and swimlanes, so one click gives a whole selection a consistent look and every document can share it.

- **Save one:** style a shape the way you want, open **Style** at the top of Properties, and press **+**. Give it a name you'll recognize, such as your team or product.
- **Apply one:** select shapes, open **Style**, rest on a profile to preview it on the canvas, and choose it. Type to search; `Enter` applies the first match. The [selection bar](./draw#style) offers the profiles you used last.
- **See what's changed:** a shape remembers its profile. Change something afterwards and the **Style** row counts it, as in "Default Blue · 2 changes", with a dot beside each changed property. The arrow at the end of a changed row puts that property back, and the one beside **Style** resets them all. Editing a profile doesn't restyle shapes that use it: they show the difference as changes, and a reset picks up the new values.
- **Manage one:** right-click it in the Style list for **Rename**, **Update with Current** (from the selected shape), **Delete**, **Sync to workspace** and **Open in Studio**.

**On every device.** A profile starts on the device you made it on. Signed in, right-click it and choose **Sync to workspace**: it gets a small cloud mark and appears wherever you sign in to that workspace, and editing it updates it for everyone there. Use **Refresh** in the list to pull other people's changes; profiles update when you ask, so they never change under you mid-edit. **Stop syncing** takes it back to just you, on this device, and removes it from the workspace for everyone, so DocuShark asks first. Nothing is ever synced without you choosing it. Synced profiles count towards your workspace's storage, under **Configuration**, though even a thousand of them is a fraction of a megabyte.

**The Studio** shows what a profile actually does. Right-click a profile and choose **Open in Studio**: each row is a set of shapes that style alike, drawn as they'd look, with every style they can take listed as **Saved** (the profile sets it, so applying the profile changes it) or **Inherited** (the profile leaves it to the shape). The header sums it up, as in *Tuned for 3 of 10 shape sets*. To take a style out of a profile, rest on it and choose the eraser; fill, outline, outline width and opacity always stay. Built-in profiles open read-only.

**Defaults.** **Settings → General → Default style profile** styles every new shape. **Hide default style profiles**, on the same tab, lists only your own. **Settings → Style Profiles** chooses whether a new profile captures icon and label styles as well; profiles you've already made keep what they were saved with.

## Settings at a glance {#settings}

Settings opens over your document; **Close** or `Esc` puts it away. Its tabs:

| Tab | What's there |
|---|---|
| **General** | The default style profile for new shapes, and switches for read-only properties in Properties, hiding the built-in style profiles, the [selection bar](./draw#style), the minimap, and moving the view to a shape you click in Layers. **Reset settings** restores this tab. |
| **Appearance** | [Theme, writing, interface and layouts](#appearance). |
| **Style Profiles** | What a new [style profile](#style-profiles) captures. |
| **Backup & Restore** | Save all your documents, profiles and preferences to one file, and restore from it. See [Export and import](./export-import#backup). |
| **About** | The app's version and build, and your workspace's when you're signed in. |

A few things that feel like settings live where you use them: signing in to a workspace and your storage are in **Documents**; the style new connectors start with is the arrow beside the **Connector** tool; and PDF page size, orientation and the rest are chosen when you export.

## On a phone {#phone}

DocuShark has an early, experimental layout for phones and other small touch screens. It's good for quick edits and reading documents on the go, though not yet a full replacement for a computer.

**Turn it on** from the prompt that appears the first time you open DocuShark on a small touch screen (**Not now** asks again next time), or with **Settings → Appearance → Mobile preview**. Turning it off there keeps the desktop layout, even on a phone, until you turn it back on. Resizing a desktop browser never triggers it.

- **Your library** fits a narrow screen either way. Each document's **⋯** is always showing, with the actions a mouse finds on the row (**Move to Cloud**, **Move to personal**, **Move to Trash**). To pick several documents, choose **Select** from one document's menu, then tap the others. Your collections, Trash and storage are in the menu at the top left.
- **The top bar** is icons only: **Documents**, the document's name, **Write** and **Canvas**, the layout, **Tools** and **Settings**. On a phone, **Tools** also holds these docs and the command palette.
- **Writing:** a bar above the keyboard has **Undo** and **Redo**, the text style, bold, italic, underline and strikethrough, lists (with **Indent** and **Outdent**) and **Link**; swipe it sideways for more, and **Format** at its end opens everything else, table tools included. Type `/` for the insert menu. On a misspelled word, the bar offers corrections; on an image, **Replace image…** and **Remove image**.
- **Diagrams:** tap a shape to select it and drag it to move it. **Properties** rises over the lower part of the screen with the shape still in view, and follows as you tap other shapes; **Done** puts it away.
- Menus open as sheets from the bottom of the screen; tap outside one, or swipe it down, to close it.

Expect some panels to feel tighter than on a computer.
