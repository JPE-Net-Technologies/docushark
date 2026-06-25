# Cloud provider icons

This tool includes official service icons for AWS, Azure, and Google Cloud.
Icons are used **solely for architectural diagrams and technical documentation**,
in accordance with each provider's permitted-use guidelines.
All trademarks and rights remain with their respective owners.

The `aws/`, `azure/`, and `gcp/` sets and their `*-manifest.json` files are
generated from the raw vendor drops by `scripts/prepare-icons.ts` and committed
here so they ship with the build (the editor's icon picker fetches them at
runtime, and `scripts/gen-icon-catalog.ts` reads the manifests for the relay's
MCP `list_icons` catalog).
