---
title: Share and collaborate
description: Workspaces, editing together live, sharing a document and inviting people, and connecting an AI agent that writes into your documents.
---

# Share and collaborate

Put a document in a workspace and you can share it, edit it with other people at the same time, and let an AI agent work on it with you. Local documents stay on your device and never touch the network unless you move them.

## Workspaces {#workspaces}

A workspace keeps your documents in the cloud and in step across every device you use. Sharing, live editing and AI agents all work on workspace documents.

**Sign in.** In **Documents**, click **Sign in with DocuShark Cloud**, or **Sign in to sync** at the top left. A browser tab opens on a page showing a short code: check it matches the one in DocuShark, and approve. DocuShark connects on its own, and the top left then shows your workspace.

While you're signed in, **New** creates documents in your workspace. To move an existing document in, open the **⋯** menu on its card and choose **Move to Cloud**; **Move to personal** brings one back to this device. A moved document keeps its tags but leaves its collection behind ([Organize](./organize#collections-and-tags)).

## Edit together {#edit-together}

Open a workspace document and you join everyone else who has it open:

- Changes appear as people make them: shapes, text, pages, everything.
- You see each person's pointer with their name, and what they've selected, in their colour.
- The people in the document appear at the top of the window.

Edits merge on their own, even when two people change the same thing at once, so there's never a "their version or yours" choice to make. **Undo** takes back only your own changes.

**When the connection drops,** keep working. Your changes wait on this device, even if you close the app, and sync when the connection returns. The status bar shows **Connected**, **Reconnecting** or **Offline**; for documents you need on a trip, see [Offline](./organize#offline).

If changes aren't syncing, check the status bar, make sure the document is in your workspace (local documents don't sync), and if all else fails, sign out and back in. A large document takes a moment to arrive the first time you open it; after that, changes are quick.

## Share a document {#share-a-document}

**Documents are private by default.** Being in a workspace doesn't let someone see a document; it has to be shared with them first. The exception is workspace owners, who can manage every document in the workspace.

Open the access panel with **Manage access** from a document card's **⋯** menu, or by clicking the people on a document's row. Then, if you own the document:

1. Pick a person from your workspace, and choose **Can view** or **Can edit**.
2. Click **Add**. Change or remove anyone's access in the same list.
3. Click **Save**. Nothing changes until you do, and the button counts your pending changes.

You can share only with people already in your workspace, so [invite them](#invite) first. Someone who has left the workspace is marked **former member**, so you can clear their access.

The panel reads top to bottom in the order access works: the **workspace** (its owners can manage everything), the **collection** (which grants nothing yet), and **this document** (its owner, and anyone it's shared with). Each person is labelled **via workspace** or **shared directly**.

- **Shared with me**, on the left of Documents while you're signed in, lists other people's documents you can open.
- **Make owner** hands a document to someone who can already edit it. You become an editor; it can't be undone, so DocuShark asks first.

## Invite people {#invite}

The **Workspace** section of the access panel lists everyone in your workspace and their role. As the workspace's owner, you can:

- **Create an invite link** for a **Member**, who can edit documents shared with them, or a **Viewer**, who can only read, even on a document shared with them to edit. Anyone with the link can join until it expires or you revoke it.
- **Copy** or **revoke** a pending invite.
- **Remove a member.** They lose access to the workspace and everything shared with them, though copies already on their device stay there. Unsaved changes they had made to a shared document go to their **Trash**, where they can restore them as a personal copy. You can invite them again later.

## Connect an AI agent {#connect-an-ai-agent}

DocuShark speaks [MCP](https://modelcontextprotocol.io), the open standard for connecting AI agents to tools. Connect the agent you already use, such as Claude, ChatGPT or Cursor, and ask it to *draft an architecture RFC with a system diagram* or *turn these notes into an outlined document*: it writes straight into a DocuShark document, diagrams, references and all.

**1. Get your endpoint.** Pick your workspace's location for the address to give your agent:

<RegionSelector />

It's the location you chose when you created your workspace; Toronto (`yyz`) is the default.

**2. Add it to your agent** as a remote, or custom, MCP server. The first time the agent connects, DocuShark asks you to sign in to your workspace, with no token to copy. That's also the only way that works for claude.ai on the web. Clients configured with JSON, such as Cursor, follow this shape, with your endpoint as the URL:

```json
{
  "mcpServers": {
    "docushark": {
      "url": "https://yyz.relay.docushark.app/mcp"
    }
  }
}
```

A script without a browser can send a token instead, as an `Authorization: Bearer <your-token>` header. Signing in is simpler whenever you can use it.

**3. Check it works.** Ask your agent: *"Create a DocuShark document called Hello with a short intro paragraph."* Then open [DocuShark](https://app.docushark.app): the document is there. DocuShark's tools appear in your agent with a `docushark_` prefix, such as `docushark_create_document`.

Agents write to your workspace documents. They can read your local documents for context, but never change them. Ready-made recipes for common jobs, such as an architecture RFC, a diagram from a description, or notes into a structured document, load on their own in Claude; for other agents, paste a recipe into the system prompt. See [AI agents and recipes](/developer/mcp-agent-recipes) for the recipes and every tool.
