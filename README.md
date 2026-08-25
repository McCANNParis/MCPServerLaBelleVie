# La Belle Vie — Grocery MCP server

An [MCP](https://modelcontextprotocol.io) server (plus an optional thin `lbv` CLI) that lets an AI
agent do the groceries on [labellevie.com](https://www.labellevie.com) — search the catalog, fill the
basket, reorder past shops, check delivery coverage and slots, and assemble a **ready-to-pay
summary**. It is built on the private JSON API the website itself uses (backend: Deleev). This repo
is a **blueprint for a remote MCP server** for La Belle Vie: deploy it as-is on Vercel, or swap the
`src/lbv/*` client layer to bring another service to your agent.

> **Payment is never automated.** Every flow stops at a ready-to-pay basket and hands you a summary
> plus the `labellevie.com/panier` link. There is deliberately **no tool that places or pays for an
> order**, and no card data is ever handled. You review and pay yourself on the site.

## How it works

```
Claude connector ──MCP (OAuth via Descope, email OTP)──┐
                                                        ├─▶ Vercel: MCP server  (/mcp)
lbv CLI / agent ──MCP (static bearer LBV_API_TOKEN)─────┘        mcp-handler + withMcpAuth
                                                                 tool handlers ─▶ src/lbv/* core
                                                                          │
                                                    per-caller connection in Vercel KV:
                                                    AES-encrypted LBV login + cookie jar
                                                    (connected once via /connect/<code>)
                                                                          ▼
                                                    labellevie.com  +  search.deleev.com
```

Both the agent and the CLI speak MCP to the **same** deployed server. Your La Belle Vie login is
**not** a server env var: each caller connects their own account once through a one-time browser
link (`connect_account`). The server verifies the login against labellevie.com, then stores the
session cookie jar plus the credentials encrypted with AES-256-GCM (`LBV_CRED_KEY`) in Vercel KV so
it can transparently re-login when the cookie expires. The client-facing La Belle Vie logic is
written once in `src/lbv/*` and both surfaces are thin.

## Tools

| Tool | Auth | What it does |
|---|---|---|
| `search_products(query, page?, perPage?, categoryId?)` | — | Search the catalog (id, name, price, unit, stock, sale, categories); `categoryId` keeps only products in that category or its subcategories |
| `browse_categories(parentId?, query?)` | — | Explore the taxonomy: no args → top-level aisles; `parentId` → subcategories; `query` → find categories by name |
| `view_cart()` | — | Show the current basket |
| `add_to_cart(productId, quantity?)` | — | Add a product |
| `remove_from_cart(productId, quantity?)` | — | Remove / reduce a product |
| `empty_cart()` | — | Empty the basket |
| `check_postal_coverage(postalCode)` | — | Is a postcode served + fees |
| `get_delivery_slots(postalCode)` | — | Available delivery windows + fees |
| `verify_promo(code)` | connect | Validate a promo code |
| `list_recent_orders()` | connect | Recent orders: id, date, product count — feed `get_order_products` or `reorder` |
| `get_order_products(orderId)` | connect | Every product of a past order with quantity, current price, unit and availability |
| `list_usual_products()` | connect | Most-ordered products with price, unit and aisle |
| `reorder(orderId)` | connect | Add every product from a past order into the basket |
| `list_favorites(listId?)` | connect | The account's favorites lists (the site's "listes favoris") with their products |
| `add_to_favorites(productId, listId?, listName?)` | connect | Add a product to a favorites list; `listName` finds or creates the list, no list at all → "Mes favoris" |
| `remove_from_favorites(productId, listId?)` | connect | Remove a product from one list, or from every list it is on |
| `prepare_checkout(postalCode, slotKey?)` | — | Ready-to-pay summary (totals, coverage, recommended slot, stock check, basket URL). **Does NOT pay.** |
| `connect_account()` | — | One-time secure browser link to connect **your** LBV account — the password never passes through the chat |
| `connection_status()` | — | Show whether (and which) LBV account is connected |
| `disconnect_account()` | — | Disconnect and delete the stored encrypted credentials + session |

`connect` = needs a connected account (see [Connect your account](#connect-your-account)).

### How the agent should shop

Keyword search alone can conflate meanings — `search_products("banane")` returns fresh bananas
**and** banana-flavored candy. When a query is ambiguous (or you want to explore an aisle you don't
know the French keywords for), call `browse_categories` first: no arguments lists the store's
top-level aisles, `parentId` drills into one, `query` finds a category by name. Then pass the
category id as `categoryId` to `search_products` to keep only products in that category (or any of
its subcategories). The search gateway paginates **before** this filter, so a filtered page reports
`filteredCount`/`scannedCount` and can legitimately come back empty — try the next page or a
broader category.

**Recurring purchases.** Three sources feed a basket of things the user buys regularly:
`list_usual_products` (the site's most-ordered products), `list_recent_orders` →
`get_order_products` (what a past order contained, with today's price and availability) and
`list_favorites` (the user's own lists). Each returns product ids to pass to `add_to_cart`;
`reorder` takes a whole past order in one call, and `add_to_favorites` / `remove_from_favorites`
curate the lists for next time. Products flagged `available: false` have been withdrawn or are out
of stock — skip them or search for a replacement.

## Connect your account

Tools marked `connect` act on **your** La Belle Vie account. Instead of a shared login in server
env vars, each caller connects their own account once:

1. Ask the agent to run `connect_account` (CLI: `lbv connect`). It returns a link like
   `https://<server>/connect/<code>` — valid 10 minutes, single use, bound to your verified (OAuth
   or static-token) identity.
2. Open the link and enter your labellevie.com email + password on that page. The credentials go
   from your browser to this server to labellevie.com — **never through the chat or the model**.
3. On success the server keeps the authenticated cookie jar plus your credentials encrypted with
   AES-256-GCM (`LBV_CRED_KEY`) in KV, so it can silently re-login when the session cookie expires.
   The connection lives 90 days past its last use (rolling), i.e. effectively until you disconnect.

`connection_status` shows what is connected; `disconnect_account` deletes the stored credentials
and session. A wrong password can be retried up to 5 times per link; an expired or used link shows
a clear page telling you to ask the agent for a fresh one. Static-bearer (CLI) callers share one
connection; each OAuth user gets their own isolated connection.

## Use it from an agent

Two independent auth paths hit the same `/mcp` endpoint: **OAuth** (Descope, for Claude
Desktop/claude.ai connectors) and a **static bearer token** (for the CLI and any MCP client that
supports headers).

**Claude Desktop / claude.ai (OAuth custom connector):**

1. Settings → Connectors → **Add custom connector** → URL `https://mcp-server-labellevie.vercel.app/mcp`.
2. Click **Connect** — a Descope sign-in opens. Enter the allow-listed email and the one-time code
   it receives.
3. Approve the consent screen; the tools appear.

Sign-in is by **email one-time code** and access is restricted server-side to a single allow-listed
address (`LBV_ALLOWED_EMAIL`): any other account — even one that completes the Descope flow — is
rejected with a 401. Self-registration is blocked in Descope besides.

**Claude Code:**

```bash
claude mcp add --transport http labellevie https://mcp-server-labellevie.vercel.app/mcp \
  --header "Authorization: Bearer $LBV_API_TOKEN"
```

**Generic MCP JSON config:**

```jsonc
{
  "mcpServers": {
    "labellevie": {
      "type": "http",
      "url": "https://mcp-server-labellevie.vercel.app/mcp",
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

export LBV_MCP_URL="https://mcp-server-labellevie.vercel.app/mcp"
export LBV_API_TOKEN="…"

lbv search "banane bio" --perPage 5
lbv categories                     # top-level aisles
lbv categories 74                  # subcategories of category 74
lbv categories --find fromage      # find categories by name
lbv search banane --category 74    # keyword search filtered to a category
lbv add 49135 2
lbv cart
lbv slots 75011
lbv connect                   # one-time browser link to connect your LBV account
lbv status                    # which account is connected
lbv orders                    # recent orders: id, date, product count
lbv order 123456              # products of one past order, with availability
lbv usuals                    # most-ordered products
lbv reorder 123456            # add a whole past order into the basket
lbv favorites                 # favorites lists + their products
lbv favorite 49135 --list "Courses de la semaine"   # add to a list (created if missing)
lbv unfavorite 49135          # remove from every favorites list
lbv checkout 75011            # ready-to-pay summary; never pays
lbv disconnect                # delete the stored credentials + session
lbv <command> --json         # print the structured JSON result instead of text
lbv --help
```

## Local development

**Requires Node 24+** (`engines.node: ">=24"`) — the same version CI and the Vercel runtime use.
The stack is Next 16 (App Router), `mcp-handler` v2, MCP SDK v2 and zod 4.

```bash
npm install
npm run dev                  # Next.js dev server → http://localhost:3000/mcp

# Inspect the tools interactively:
npx @modelcontextprotocol/inspector      # point it at http://localhost:3000/mcp + your bearer

# Or drive it with the CLI against local dev:
LBV_MCP_URL=http://localhost:3000/mcp LBV_API_TOKEN=dev-token lbv search "lait"
```

Health check (no auth): `GET /api/health` reports liveness and whether the bearer token / OAuth /
KV / `LBV_CRED_KEY` are configured, plus `connectReady` (KV **and** key present — the
account-connect flow will work). It never returns secrets.

## Environment variables

Server variables go in the **Vercel project**; `LBV_EMAIL`/`LBV_PASSWORD` live only in your local
`.env.local` (gitignored) for `verify-auth` / integration tests:

| Variable | Purpose |
|---|---|
| `LBV_EMAIL`, `LBV_PASSWORD` | **Local only** (verify-auth + integration tests). The server never reads them — never set on Vercel. |
| `LBV_CRED_KEY` | AES-256-GCM key encrypting connected users' credentials at rest (`openssl rand -hex 32`). Rotating it forces everyone to reconnect. |
| `LBV_API_TOKEN` | Bearer token checked by the server; also given to the agent / CLI |
| `DESCOPE_PROJECT_ID` | Descope project id — enables the OAuth path (not a secret) |
| `LBV_ALLOWED_EMAIL` | **The OAuth security boundary**: only a token with this email claim is accepted (fail-closed) |
| `LBV_ALLOWED_SUBJECT` | Same boundary keyed on the Descope user id (`U…`) in `sub` — covers tokens without an email claim; either match suffices |
| `DESCOPE_BASE_URL` | Optional Descope regional base URL (default `https://api.descope.com`) |
| `DESCOPE_MANAGEMENT_KEY` | Local `descope` CLI only — **never** on Vercel, never committed |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel KV — account connections, one-time connect links, cookie jars. **Required in production**; the in-memory fallback is local-dev only. |
| `LBV_MCP_URL` | CLI only — the server URL (default `http://localhost:3000/mcp`) |

See [`.env.example`](./.env.example).

### Verify auth

To confirm the login handshake works with your credentials (the same handshake the `/connect` page
uses), locally:

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
npm run capture-fixtures     # re-capture the orders/favorites responses into a temp dir (local creds)
```

- **Unit** (`tests/unit`): request builders + response parsers grounded in captured API fixtures,
  the CSRF login handshake + auto re-login, and the session store.
- **Contract** (`tests/contract`): starts the MCP server in-process and asserts the exact tool set,
  each tool's input schema, and — as a guardrail regression — that **no payment/order-placing tool is
  exposed**.
- **Integration** (`tests/integration`): read-only / self-reverting live calls (search, coverage,
  slots, an add→view→remove cart round-trip that restores the basket, the orders pages, and a
  favorites round-trip on a throwaway `__lbv_mcp_test_*` list that is deleted afterwards). Never
  touches payment. Skipped unless `LBV_LIVE=1`.
- **Fixtures** (`tests/fixtures`): `npm run capture-fixtures` logs in with the local
  `LBV_EMAIL`/`LBV_PASSWORD`, performs read-only requests and writes the raw responses to a temp
  directory — never into the repo. Before copying a capture in, strip everything personal (name,
  email, address, phone, user id) and replace real order/list ids with synthetic ones; product data
  is public catalogue content and stays.

## CI/CD & branches

- **`main`** = production (protected), **`dev`** = staging. Flow: feature branch → PR → `dev` → PR →
  `main`.
- **`.github/workflows/ci.yml`** (push/PR to `dev` & `main`): install → lint → typecheck → test →
  build, on **Node 24**. Fully mocked, no secrets — this is the merge gate.
- **`.github/workflows/integration.yml`** (manual, via *Run workflow*): runs the live tests with the
  repo secrets `LBV_EMAIL` / `LBV_PASSWORD`, also on Node 24. Kept off the PR path so a flaky
  external API never blocks a merge.

### Deploy (Vercel)

Deployment uses Vercel's native Git integration (one-time setup):

1. Import this repo into a Vercel project.
2. Set the environment variables above (`LBV_API_TOKEN`, `LBV_CRED_KEY`, `DESCOPE_PROJECT_ID`,
   `LBV_ALLOWED_EMAIL`, KV). Do **not** set `LBV_EMAIL`/`LBV_PASSWORD` — if migrating from an older
   deploy, delete them. Env changes only apply to **new** deployments — redeploy after changing
   them.
3. Add a Vercel KV (Upstash Redis) store to the project (required for the connect flow).
4. Push `dev` → **Preview** deploy; PR `dev` → `main` → **Production** deploy.
5. From each MCP client, run `connect_account` once and complete the browser login.

Vercel picks the function runtime from `engines.node` in `package.json` (**Node 24**) — no runtime
setting to configure in the dashboard.

Add the same `LBV_EMAIL` / `LBV_PASSWORD` as **GitHub Actions secrets** to enable the integration
workflow.

## Notes & limitations

- This automates **your own** account through the app's private, undocumented API. Keep it to
  personal use and gently rate-limited. Undocumented endpoints can change without notice; `/api/health`
  helps flag breakage early.
- Payment is out of scope by design — the tool stops at a ready basket and you complete payment.
- Favorites are the site's own "listes favoris": the tools read and edit the same lists you see on
  labellevie.com. `add_to_favorites` creates "Mes favoris" when the account has no list yet, and
  asks for `listId`/`listName` when it has several. Lists themselves are never deleted by a tool.
- The orders pages (`/commande-rapide/…`) are server-rendered HTML, parsed with a few patterns
  behind a page-marker check: if La Belle Vie changes that markup, `list_recent_orders` /
  `list_usual_products` fail with an explicit "site may have changed" error rather than an empty
  list.

## License

[MIT](LICENSE)
