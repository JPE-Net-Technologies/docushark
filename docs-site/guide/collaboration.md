# Collaboration

DocuShark supports real-time collaboration: when your document is connected to a
**relay**, everyone editing it sees each other's changes live, with no manual
saving or merging.

## How It Works

Collaboration is powered by a **relay** — a server that all collaborators connect
to over a WebSocket:

1. Each collaborator's editor connects to the relay.
2. The relay holds the **authoritative copy** of the document and streams changes
   to everyone in real time.
3. Edits merge automatically using **CRDTs** (Conflict-free Replicated Data
   Types, via [Yjs](https://yjs.dev)).

::: tip
CRDT-based sync means you'll never lose work to a conflict. If two people edit the
same shape at the same time, the changes merge deterministically — no "their
version vs. yours" prompt.
:::

Your **local documents stay local** — they never touch the network. A document
only collaborates once it lives on a relay.

## Connecting to a Relay

Open **Settings → Relay**. The simplest way to connect is:

1. Click **Sign in with DocuShark Cloud**.
2. Your browser opens to a verification page showing a short code — confirm it
   matches the code in the app, and authorize.
3. The app finishes connecting automatically. You'll see your signed-in identity
   and a **Disconnect** button.

Once signed in, opening a relay-hosted document joins its live session. The status
bar shows whether you're connected and whether the current document is actively
syncing.

::: tip Advanced: your own relay
DocuShark's relay is open source. If you want to run your own (for a fully
self-managed setup), point the **Relay URL** field at it instead — the default for
a local relay is `http://localhost:9876`. Running a relay is an operator task with
its own setup; see the relay's
[README](https://github.com/JPE-Net-Technologies/docushark/blob/master/relay/README.md)
in the repository. For most people, signing in is the quickest path.
:::

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

All document changes sync live:

- Shape creation, modification, deletion
- Property changes (colors, text, etc.)
- Prose edits, pages, and structure

## Offline Support

DocuShark is offline-first. Collaboration degrades gracefully when the network
drops.

### How Offline Mode Works

1. **Connection lost** — you keep working normally
2. **Changes queued** — your edits are stored locally in an offline queue
3. **Reconnection** — queued changes sync automatically when the connection
   returns
4. **Conflict resolution** — CRDTs merge everything without conflicts

The offline queue is persisted to **IndexedDB**, so pending changes survive an app
restart and replay once you're back online.

### Connection Indicators

The status bar shows the current connection state:

- **Connected** — real-time sync active
- **Reconnecting** — attempting to reconnect (with retry count)
- **Offline** — working locally, changes will sync later

### Manual Reconnection

If automatic reconnection doesn't recover:

1. Check your network connection
2. Confirm you're still signed in (**Settings → Relay**)
3. Use the reconnect action in the status bar

## A Note on Authentication

You never give DocuShark a password to collaborate. Signing in obtains a
short-lived access token from the identity provider (DocuShark Cloud by default),
and the relay simply **validates** that token — it never stores passwords or mints
its own credentials. Sessions, multi-factor auth, and account management all live
with the identity provider.

::: info Private document networks
Dedicated, privately-hosted relays for a team or organization — set up for you
rather than self-run — are planned for the future. Today, sign in to collaborate,
or run your own relay if you need full control now.
:::

## Troubleshooting

### Can't Connect

- Confirm you completed the browser sign-in step (the code must be authorized)
- Check that the **Relay URL** in Settings is reachable from your network
- If you're on a custom/self-hosted relay, verify it's running and that its auth
  (OIDC issuer) is configured

### Changes Not Syncing

- Check the connection status in the status bar
- Confirm the document is a relay-hosted document (local documents don't sync)
- Look for error notifications
- Try disconnecting and signing back in

### High Latency or Slow Initial Sync

- Large documents take longer to sync on first join
- Check your network bandwidth
- Subsequent edits sync incrementally and stay fast
