# La Belle Vie — Grocery MCP server

An [MCP](https://modelcontextprotocol.io) server (plus an optional thin `lbv` CLI) that lets an AI
agent do the groceries on [labellevie.com](https://www.labellevie.com) — search the catalog, fill the
basket, reorder past shops, check delivery coverage and slots, and assemble a **ready-to-pay
summary**. It is built on the private JSON API the website itself uses (backend: Deleev).

> **Payment is never automated.** Every flow stops at a ready-to-pay basket and hands you a summary
> plus the `labellevie.com/panier` link. There is deliberately **no tool that places or pays for an
> order**, and no card data is ever handled. You review and pay yourself on the site.

## How it works

```
Claude / agent ──MCP (Streamable HTTP + bearer)──┐
                                                  ├─▶ Vercel: MCP server  (/mcp)
lbv CLI (thin MCP client) ──MCP (bearer)──────────┘        mcp-handler + withMcpAuth
                                                           tool handlers ─▶ src/lbv/* core
                                                                    │
                                                   credentials in Vercel env,
                                                   cookie-jar session in Vercel KV
                                                                    ▼
                                              labellevie.com  +  search.deleev.com
```

Both the agent and the CLI speak MCP to the **same** deployed server. Your La Belle Vie login lives
only in the server's environment (Vercel env vars); the session cookie jar is cached in Vercel KV and
auto-refreshed. The client-facing La Belle Vie logic is written once in `src/lbv/*` and both surfaces
are thin.

## Tools

| Tool | Auth | What it does |
|---|---|---|
| `search_products(query, page?, perPage?)` | — | Search the catalog (id, name, price, unit, stock, sale) |
| `view_cart()` | — | Show the current basket |
| `add_to_cart(productId, quantity?)` | — | Add a product |
| `remove_from_cart(productId, quantity?)` | — | Remove / reduce a product |
| `empty_cart()` | — | Empty the basket |
| `check_postal_coverage(postalCode)` | — | Is a postcode served + fees |
| `get_delivery_slots(postalCode)` | — | Available delivery windows + fees |
| `verify_promo(code)` | login | Validate a promo code |
| `list_recent_orders()` | login | Recent orders (reorder sources) |
| `list_usual_products()` | login | Most-ordered products |
| `reorder(orderId)` | login | Add every product from a past order into the basket |
| `prepare_checkout(postalCode, slotKey?)` | — | Ready-to-pay summary (totals, coverage, recommended slot, stock check, basket URL). **Does NOT pay.** |

## Use it from an agent

Add the deployed endpoint (with the bearer token) to your MCP client.

**Claude Code:**

```bash
claude mcp add --transport http labellevie https://<your-deployment>.vercel.app/mcp \
  --header "Authorization: Bearer $LBV_API_TOKEN"
```

**Generic MCP JSON config:**

```jsonc
{
  "mcpServers": {
    "labellevie": {
      "type": "http",
      "url": "https://<your-deployment>.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <LBV_API_TOKEN>" }
    }
  }
}
```

## Use it from the CLI

The `lbv` CLI is a thin MCP client — it holds no secrets beyond the bearer token and talks to the same
server.

```bash
npm run build:cli          # produces dist/cli.js (the `lbv` bin)

export LBV_MCP_URL="https://<your-deployment>.vercel.app/mcp"
export LBV_API_TOKEN="…"

lbv search "banane bio" --perPage 5
lbv add 49135 2
lbv cart
lbv slots 75011
lbv reorder 123456
lbv checkout 75011            # ready-to-pay summary; never pays
lbv <command> --json         # print the structured JSON result instead of text
lbv --help
```

## Local development

```bash
npm install
npm run dev                  # Next.js dev server → http://localhost:3000/mcp

# Inspect the tools interactively:
npx @modelcontextprotocol/inspector      # point it at http://localhost:3000/mcp + your bearer

# Or drive it with the CLI against local dev:
LBV_MCP_URL=http://localhost:3000/mcp LBV_API_TOKEN=dev-token lbv search "lait"
```

Health check (no auth): `GET /api/health` reports liveness and whether credentials / KV are
configured (it never returns secrets).

## Environment variables

Set these in the **Vercel project** (and locally in `.env.local` for `verify-auth` / integration
tests — `.env.local` is gitignored):

| Variable | Purpose |
|---|---|
| `LBV_EMAIL`, `LBV_PASSWORD` | Your La Belle Vie login (server-side only) |
| `LBV_API_TOKEN` | Bearer token checked by the server; also given to the agent / CLI |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel KV (session cookie cache). Falls back to in-memory if unset. |
| `REDIS_URL` | Optional — backs `mcp-handler` SSE resumability |
| `LBV_MCP_URL` | CLI only — the server URL (default `http://localhost:3000/mcp`) |

See [`.env.example`](./.env.example).

### Verify auth

Before deploying, confirm the login handshake works with your credentials:

```bash
# put LBV_EMAIL / LBV_PASSWORD in .env.local first
npm run verify-auth
```

This performs the real login + an authenticated `GET /api/fullprofile`. Your password is read
locally and sent only to labellevie.com — never printed or committed.

## Testing

```bash
npm run lint                 # ESLint (flat config)
npm run typecheck            # tsc --noEmit
npm test                     # unit + contract tests (mocked, no secrets, no network)
npm run test:integration     # opt-in live tests — needs LBV_LIVE=1 + LBV_EMAIL/LBV_PASSWORD
```

- **Unit** (`tests/unit`): request builders + response parsers grounded in captured API fixtures,
  the CSRF login handshake + auto re-login, and the session store.
- **Contract** (`tests/contract`): starts the MCP server in-process and asserts the exact tool set,
  each tool's input schema, and — as a guardrail regression — that **no payment/order-placing tool is
  exposed**.
- **Integration** (`tests/integration`): read-only / self-reverting live calls (search, coverage,
  slots, and an add→view→remove cart round-trip that restores the basket). Never touches payment.
  Skipped unless `LBV_LIVE=1`.

## CI/CD & branches

- **`main`** = production (protected), **`dev`** = staging. Flow: feature branch → PR → `dev` → PR →
  `main`.
- **`.github/workflows/ci.yml`** (push/PR to `dev` & `main`): install → lint → typecheck → test →
  build. Fully mocked, no secrets — this is the merge gate.
- **`.github/workflows/integration.yml`** (manual + nightly): runs the live tests with the repo
  secrets `LBV_EMAIL` / `LBV_PASSWORD`. Kept off the PR path so a flaky external API never blocks a
  merge.

### Deploy (Vercel)

Deployment uses Vercel's native Git integration (one-time setup):

1. Import this repo into a Vercel project.
2. Set the environment variables above (`LBV_EMAIL`, `LBV_PASSWORD`, `LBV_API_TOKEN`, KV).
3. Add a Vercel KV (Upstash Redis) store to the project.
4. Push `dev` → **Preview** deploy; PR `dev` → `main` → **Production** deploy.

Add the same `LBV_EMAIL` / `LBV_PASSWORD` as **GitHub Actions secrets** to enable the integration
workflow.

## Notes & limitations

- This automates **your own** account through the app's private, undocumented API. Keep it to
  personal use and gently rate-limited. Undocumented endpoints can change without notice; `/api/health`
  helps flag breakage early.
- Payment is out of scope by design — the tool stops at a ready basket and you complete payment.
