#!/usr/bin/env node
/**
 * `lbv` — a thin command-line client for the La Belle Vie MCP server. It speaks
 * MCP (Streamable HTTP) to the same deployed server the agent uses, so all the
 * shopping logic and credentials stay server-side. This binary holds no
 * secrets beyond the bearer token used to reach the server.
 *
 * Config: LBV_MCP_URL (default http://localhost:3000/mcp), LBV_API_TOKEN.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_URL = 'http://localhost:3000/mcp';
const BOOLEAN_FLAGS = new Set(['json', 'pretty', 'help']);

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inlineValue] = a.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function num(v: string | boolean | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Translate a CLI command + args into an MCP tool call. */
function resolveCommand(cmd: string, rest: string[], flags: Parsed['flags']): ToolCall {
  switch (cmd) {
    case 'search':
      return {
        name: 'search_products',
        arguments: {
          query: rest.join(' '),
          page: num(flags.page),
          perPage: num(flags.perPage),
          categoryId: num(flags.category),
        },
      };
    case 'categories':
      return {
        name: 'browse_categories',
        arguments: {
          parentId: num(rest[0]),
          query: typeof flags.find === 'string' ? flags.find : undefined,
        },
      };
    case 'cart':
      return { name: 'view_cart', arguments: {} };
    case 'add':
      return { name: 'add_to_cart', arguments: { productId: rest[0], quantity: num(rest[1]) } };
    case 'remove':
      return { name: 'remove_from_cart', arguments: { productId: rest[0], quantity: num(rest[1]) } };
    case 'empty':
      return { name: 'empty_cart', arguments: {} };
    case 'coverage':
      return { name: 'check_postal_coverage', arguments: { postalCode: rest[0] } };
    case 'slots':
      return { name: 'get_delivery_slots', arguments: { postalCode: rest[0] } };
    case 'promo':
      return { name: 'verify_promo', arguments: { code: rest[0] } };
    case 'orders':
      return { name: 'list_recent_orders', arguments: {} };
    case 'usuals':
      return { name: 'list_usual_products', arguments: {} };
    case 'reorder':
      return { name: 'reorder', arguments: { orderId: rest[0] } };
    case 'checkout':
      return { name: 'prepare_checkout', arguments: { postalCode: rest[0], slotKey: rest[1] } };
    case 'connect':
      return { name: 'connect_account', arguments: {} };
    case 'status':
      return { name: 'connection_status', arguments: {} };
    case 'disconnect':
      return { name: 'disconnect_account', arguments: {} };
    default:
      throw new UsageError(`Unknown command: ${cmd || '(none)'}`);
  }
}

class UsageError extends Error {}

const USAGE = `lbv — do the groceries on labellevie.com via the MCP server

Usage: lbv <command> [args] [--json]

Commands:
  search <query> [--page N] [--perPage N] [--category ID]  Search the catalog
  categories [parentId] [--find name]      Browse the category taxonomy
  cart                                     Show the current basket
  add <productId> [qty]                    Add a product to the basket
  remove <productId> [qty]                 Remove (or reduce) a product
  empty                                    Empty the basket
  coverage <postalCode>                    Check delivery coverage
  slots <postalCode>                       List delivery slots
  promo <code>                             Verify a promo code (needs connected account)
  orders                                   List recent orders (needs connected account)
  usuals                                   List usual products (needs connected account)
  reorder <orderId>                        Add a past order into the basket (needs connected account)
  checkout <postalCode> [slotKey]          Ready-to-pay summary (does NOT pay)
  connect                                  Get a one-time link to connect your LBV account
  status                                   Show which LBV account is connected
  disconnect                               Disconnect and delete stored credentials

Options:
  --json     Print the structured JSON result instead of text
  --help     Show this help

Env:
  LBV_MCP_URL    MCP server URL (default ${DEFAULT_URL})
  LBV_API_TOKEN  Bearer token for the server

Note: this tool never places or pays for an order — it stops at a ready cart.`;

/** Drain the text content blocks from a tool result. */
function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

async function main(): Promise<number> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positionals;

  if (flags.help || !cmd || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }

  const call = resolveCommand(cmd, rest, flags);

  const url = new URL(process.env.LBV_MCP_URL ?? DEFAULT_URL);
  const token = process.env.LBV_API_TOKEN;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'lbv-cli', version: '0.1.0' });

  await client.connect(transport);
  try {
    const result = (await client.callTool(call)) as CallToolResult;
    if (flags.json) {
      console.log(JSON.stringify(result.structuredContent ?? {}, null, 2));
    } else {
      console.log(textOf(result));
    }
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  });
