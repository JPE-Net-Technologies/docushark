# DocuShark Agent Recipes

A curated set of **recipes** that drive the DocuShark [MCP server](../relay/docs/mcp/README.md)
to author real documents — prose + diagrams — from a plain-language ask. Each recipe
is a repeatable workflow an AI agent follows using the DocuShark MCP tools.

These work with **any MCP-capable agent** — the recipe content is provider-agnostic
because [MCP](https://modelcontextprotocol.io) is the universal layer; only *how you
load the recipe* and *how you connect* differ between Claude and OpenAI. See
**[CONNECTING.md](./CONNECTING.md)** for the per-client setup.

## The recipes

| Recipe | Use it when you want to… |
|---|---|
| [architecture-rfc](./architecture-rfc/SKILL.md) | Author an architecture/design RFC with a system diagram. |
| [document-codebase-module](./document-codebase-module/SKILL.md) | Document a code module: prose walkthrough + a component diagram. |
| [diagram-from-description](./diagram-from-description/SKILL.md) | Turn a described system/sequence into a clean, auto-laid-out diagram. |
| [meeting-notes-to-doc](./meeting-notes-to-doc/SKILL.md) | Turn raw notes into a structured, outlined document. |

## Two ways to use a recipe

Every recipe is a `SKILL.md` — YAML frontmatter (`name`, `description`) + a
provider-agnostic instruction body.

- **Claude (Code / Desktop):** drop the recipe folder into your skills directory
  (e.g. `~/.claude/skills/`) and Claude auto-loads it when the `description` matches
  the task.
- **OpenAI (ChatGPT Custom GPT, a Project, or the Responses/Agents SDK):** copy the
  body (everything below the frontmatter) into the GPT's *Instructions* / the
  Project's custom instructions / a system (developer) message.

Either way, your agent must first be **connected to a DocuShark relay's MCP
endpoint** — see [CONNECTING.md](./CONNECTING.md).

## How the recipes are built

They target the live tool surface documented in
[`relay/docs/mcp/README.md`](../relay/docs/mcp/README.md) (the authoritative
reference) and exercised by [`relay/scripts/mcp-smoke.sh`](../relay/scripts/mcp-smoke.sh).
Two things worth knowing up front:

- **Writes target *team* documents.** Local (renderer-owned) documents are
  read-only over MCP, so a recipe creates and owns its own document.
- **Styling is inline.** DocuShark's saved *style profiles* are a client-side
  feature and aren't exposed over MCP — recipes set colors inline per shape (or
  use `"AUTO"` for contrast-aware colors) and otherwise lean on sensible defaults.
