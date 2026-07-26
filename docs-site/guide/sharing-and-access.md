---
title: Sharing & Workspace Access
description: Share a cloud document with specific workspace members, transfer ownership, and manage who belongs to your workspace.
---

# Sharing & Workspace Access

Once a document lives in a workspace (see [Collaboration](./collaboration)), you control exactly who can see and edit it — both at the document level and at the workspace level.

## The access panel

Everything to do with access lives in one panel. Open it with **Manage access** from a document's menu, by clicking the **People** avatars on a document's row, or from **Manage access** in the Cloud panel for the workspace as a whole.

The panel reads top to bottom as a chain, because that's how access actually works:

| Level | What it grants |
| --- | --- |
| **Workspace** | Owners can manage every document in the workspace |
| **Collection** | Nothing yet — collections don't carry access of their own |
| **This document** | Its owner, plus anyone it's been shared with directly |

Each person is labelled with where their access comes from — **via workspace** for someone who has it by being a workspace owner, **shared directly** for someone you added to this document. Being a workspace member is *not* by itself access to a document: people need to be added to a document before they can open it.

## Sharing a document

Only a document's **owner** can change who can open it. In the **This document** section of the access panel:

1. Pick a person from your workspace and choose **Can view** or **Can edit**
2. Click **Add** — they appear in the list straight away
3. Change or remove anyone's access from the same list
4. Click **Save** — nothing changes until you do, and the button tells you how many changes are pending

You can only share with people already in your workspace — invite them first (see below) if they're not listed. If someone was given access and has since left the workspace, they're flagged as a **former member** so you can clear the stale grant.

### Finding documents shared with you

The Documents home sidebar has a **Shared with me** filter (shown while you're signed in to a workspace): it lists the workspace documents owned by someone else that you can see. Each row's **People** column tells you at a glance who owns a document and who else is on it.

### Transferring ownership

From the same panel you can hand a document off entirely: choose **Make owner** next to someone who can already edit it. This is permanent — you become an editor rather than the owner — and DocuShark asks you to confirm first.

## Workspace members and invites

The **Workspace** section of the access panel lists everyone in the workspace and their role. If you're the workspace **owner**, you can also:

- **Create an invite link** — choose a role (**Member**, who can edit shared documents, or **Viewer**, read-only) and generate a shareable link. Anyone with the link can join until it expires or you revoke it.
- **Copy or revoke** any pending invite
- **Remove a member** — they lose access to the workspace and everything shared with them, though anything already downloaded to their device stays put. You can always re-invite them later.

## See also

- [Collaboration](./collaboration) — live editing, presence, and connecting to a workspace
- [Offline & Sync](./offline-and-sync) — what happens to shared documents when you're not connected
