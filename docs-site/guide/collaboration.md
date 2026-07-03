---
title: Collaboration
description: Real-time collaboration in DocuShark — work together live in a shared workspace, with automatic conflict-free syncing.
---

# Collaboration

DocuShark supports real-time collaboration: when your document lives in a **workspace**, everyone editing it sees each other's changes live, with no manual saving or merging.

## What a workspace gives you

A workspace is where documents go to be shared — cloud storage, effortless real-time collaboration, sync across all your devices, and integrations as they arrive. Your **local documents stay local**; they never touch the network unless you move them into a workspace.

::: info Free workspaces
Free workspaces don't include every advanced collaboration feature — some are limited by the network and data demands of real-time sync at scale.
:::

## Connecting to a Workspace

Open the **Documents** screen (press `Cmd/Ctrl+Shift+O`, or use the Documents button). The simplest way to connect is:

1. Click **Sign in with DocuShark Cloud**.
2. Your browser opens to a verification page showing a short code — confirm it
   matches the code in the app, and authorize.
3. The app finishes connecting automatically. You'll see your signed-in identity
   and a **Disconnect** button.

Once signed in, opening a workspace document joins its live session. The status
bar shows whether you're connected and whether the current document is actively
syncing.

## Collaboration Features

### Live Cursors

See where other collaborators are working:

- Each user's cursor appears with their name
- Cursor colors are automatically assigned
- Cursors fade when idle

### Selection Awareness

See what others have selected:

- Shapes selected by other users are highlighted in their color
- User name labels appear on remote selections

### Presence Indicators

The toolbar shows who's connected:

- User avatars/initials with status
- Click to see the full participant list
- Each user's color matches their cursor

### Real-time Sync

All document changes sync live — shape creation, modification, and deletion; property changes; prose edits, pages, and structure. If two people edit the same thing at the same time, DocuShark merges the changes automatically — there's no "their version vs. yours" prompt to resolve.

## Offline Support

DocuShark is offline-first. Collaboration degrades gracefully when the network
drops.

### How Offline Mode Works

1. **Connection lost** — you keep working normally
2. **Changes queued** — your edits are stored locally in an offline queue
3. **Reconnection** — queued changes sync automatically when the connection
   returns
4. **Conflict resolution** — everything merges automatically, with nothing to resolve by hand

The offline queue is persisted locally, so pending changes survive an app
restart and replay once you're back online.

### Connection Indicators

The status bar shows the current connection state:

- **Connected** — real-time sync active
- **Reconnecting** — attempting to reconnect (with retry count)
- **Offline** — working locally, changes will sync later

### Manual Reconnection

If automatic reconnection doesn't recover:

1. Check your network connection
2. Confirm you're still signed in
3. Use the reconnect action in the status bar

## A Note on Authentication

You never give DocuShark a password to collaborate. Signing in obtains a
short-lived access token from your identity provider (DocuShark Cloud by
default) — DocuShark itself never stores passwords or mints its own
credentials. Sessions, multi-factor auth, and account management all live
with the identity provider.

## Troubleshooting

### Can't Connect

- Confirm you completed the browser sign-in step (the code must be authorized)
- Check your network connection
- If you're on a [self-hosted setup](../self-hosting/overview), verify it's running and reachable

### Changes Not Syncing

- Check the connection status in the status bar
- Confirm the document is actually in a workspace (local documents don't sync)
- Look for error notifications
- Try disconnecting and signing back in

### High Latency or Slow Initial Sync

- Large documents take longer to sync on first join
- Check your network bandwidth
- Subsequent edits sync incrementally and stay fast

## Under the hood

DocuShark's real-time sync is built on [Yjs](https://yjs.dev), an open-source
CRDT (Conflict-free Replicated Data Type) library — the reason edits merge
automatically instead of prompting you to resolve a conflict. DocuShark's
sync engine is open source too; see the
[DocuShark repository](https://github.com/JPE-Net-Technologies/docushark) if
you're curious how it fits together.
