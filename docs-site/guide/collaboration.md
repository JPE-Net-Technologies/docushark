# Collaboration

DocuShark supports real-time collaboration through **Protected Local mode**, allowing teams to work together on diagrams simultaneously.

## How It Works

Collaboration in DocuShark uses a peer-to-peer architecture:

1. One user **hosts** the session (runs the server)
2. Other users **connect** to the host via WebSocket
3. Changes sync in real-time using **CRDTs** (Conflict-free Replicated Data Types)

::: tip
CRDT-based sync means you'll never lose work due to conflicts. Even if two people edit the same shape simultaneously, changes merge automatically.
:::

## Hosting a Session

To share a document with collaborators:

1. **Open your document**

   Open the document you want to collaborate on.

2. **Start hosting**

   Go to **Settings → Collaboration** and configure the server port, then click **Start Server**.

3. **Configure access**

   Set up authentication — users will need a username and password to connect.

4. **Share the connection info**

   Share your IP address and port with your team. They'll enter it in their client connection panel.

::: warning
Hosting is only available in the **desktop application**. The web version can join sessions but cannot host them.
:::

## Joining a Session

To join someone else's session:

1. **Get the connection info**

   Obtain the host's IP address and port.

2. **Connect**

   Go to **Settings → Collaboration** and enter the host IP, port, username, and password in the client connection panel.

3. **Authenticate**

   Enter the credentials configured by the host.

## Collaboration Features

### Live Cursors

See where other collaborators are working:

- Each user's cursor appears with their name
- Cursor colors are automatically assigned
- Cursors fade when idle

### Selection Awareness

See what others have selected:

- Shapes selected by other users are highlighted with their color
- User name labels appear on remote selections

### Presence Indicators

The toolbar shows connected users:

- User avatars/initials with status
- Click to see full user list
- User colors match their cursor

### Real-time Sync

All changes sync in real-time:

- Shape creation, modification, deletion
- Property changes (colors, text, etc.)
- Page additions and modifications

## Offline Support

DocuShark works offline with automatic sync when reconnected.

### How Offline Mode Works

1. **Connection lost** - You can continue working normally
2. **Changes queued** - Your edits are saved locally in an offline queue
3. **Reconnection** - Changes automatically sync when connection returns
4. **Conflict resolution** - CRDTs merge changes without conflicts

### Offline Indicators

The status bar shows connection state:

- 🟢 **Connected** - Real-time sync active
- 🟡 **Reconnecting** - Attempting to reconnect (with retry count)
- 🔴 **Offline** - Working locally, changes will sync later

### Manual Reconnection

If automatic reconnection fails after several attempts:

1. Check your network connection
2. Verify the host is still running
3. Click **Reconnect** in the status bar
4. Or go to **Collaborate → Reconnect**

## Server Configuration

The host can configure server settings in **Settings → Collaboration**:

### Network Settings

| Setting | Description |
|---------|-------------|
| **Port** | WebSocket server port (default: 8080) |
| **Interface** | Network interface to bind (default: all) |
| **Max Connections** | Maximum concurrent users |

### Authentication

Enable JWT-based authentication:

1. Go to **Settings → Collaboration → Authentication**
2. Enable **Require Authentication**
3. Add users with usernames and passwords
4. Users must authenticate when connecting

### Access Control

Configure what connected users can do:

| Permission | Description |
|------------|-------------|
| **View** | Read-only access |
| **Edit** | Can modify shapes and pages |
| **Admin** | Full access including settings |

## Security Considerations

::: danger Network Security
Collaboration connections are **not encrypted by default**. For sensitive documents:

- Use on trusted networks only
- Consider VPN for remote collaboration
- Enable authentication
:::

### Best Practices

1. **Use authentication** for any non-local collaboration
2. **Limit connections** to known users
3. **Use private networks** when possible
4. **Save local backups** before major collaboration sessions

## Troubleshooting

### Cannot Connect

- Verify the connection URL is correct
- Check firewall allows the port (default: 8080)
- Ensure host and client are on the same network
- Try ping/telnet to verify network connectivity

### High Latency

- Check network bandwidth
- Reduce number of simultaneous connections
- Large documents may have slower initial sync

### Changes Not Syncing

- Check connection status in status bar
- Look for error notifications
- Try disconnecting and reconnecting
- Check host console for errors

### Duplicate Changes

If you see duplicate shapes or edits:

1. This is rare with CRDT sync
2. Try disconnecting and reconnecting
3. Check if multiple browser tabs are open
4. Report persistent issues with document export
