# HISTORY — MCPServerLaBelleVie

Canonical public repo: [`McCANNParis/MCPServerLaBelleVie`](https://github.com/McCANNParis/MCPServerLaBelleVie)

Private deployment (not this tree): [`McCANNParis/MCP_server_LBV_Vercel`](https://github.com/McCANNParis/MCP_server_LBV_Vercel)

This file is append-only. Do not rewrite past entries. Do not move git tag `freeze-2026-08-11`.

Checkout the frozen public snapshot: `git checkout freeze-2026-08-11`

## freeze-2026-08-11

- **Git tag:** `freeze-2026-08-11` (do not move)
- **GitHub Release:** https://github.com/McCANNParis/MCPServerLaBelleVie/releases/tag/freeze-2026-08-11
- **Commit:** `c417318` (*Release: drop nightly integration schedule (dev → main)*)
- **Public `dev` at freeze:** `12f227f` (tag `freeze-2026-08-11-dev`)
- **Meaning:** public `main` / `dev` were a full copy of the private repo; no further private commits were published after this date.
- **Stack:** Node ≥20, Next 15, `@modelcontextprotocol/sdk` v1, mcp-handler v1, zod 3, vitest 2, 16 tools, route `app/[transport]/route.ts`
- **GitHub slug at freeze:** `McCANNParis/MCP_server_labellevie` (renamed to `MCPServerLaBelleVie`; old URL redirects)

## sync-2026-08-27

- **Git tag:** `v0.2.0` (created on public `main` after CI)
- **Private source:** `MCP_server_LBV_Vercel` `dev` `0f0ac5b` / `main` `17ed1a6`
- **Delta vs freeze-2026-08-11:**
  - 20 tools (HTML parsers for recent orders / usuals; `get_order_products`; `list_favorites` / `add_to_favorites` / `remove_from_favorites`)
  - Node 24, Next 16, MCP SDK v2 (split `@modelcontextprotocol/client` + `server`), mcp-handler v2, zod 4, vitest 3
  - route `app/mcp/route.ts`
  - self-host README (placeholder deployment URL)
  - file-backed session store for KV-less local `next dev` (public issue #13)
  - GitHub Dependabot (npm + Actions, `target-branch: dev`, **5-day** `cooldown.default-days`; npm 11.6 does not honour `min-release-age` in project `.npmrc`) + auto-merge for patches / dev-minors

## cursor-automations-overflow-2026-08-27

- Overflow trigger is a **Cursor Automation** (weekly Monday on `dev`), not a GitHub Action and not `@cursor/sdk`.
- Public PR #19 (SDK launcher: `.github/workflows/deps-cursor-agent.yml` + `scripts/run-deps-automation.mjs`) was closed unmerged. No `CURSOR_API_KEY` on this repo.
- Prompt remains `.cursor/automations/deps-security.md` (Dependabot still owns weekly version PRs).
