import { CATEGORY_TREE_TTL_SECONDS } from './config';
import type { LbvHttp } from './http';

/**
 * Public, unauthenticated endpoint returning the full category taxonomy as an
 * array of root nodes nested via `descendent` (sic — the API's own spelling).
 * The raw payload is ~7 MB / ~5,400 nodes, so it is parsed once into a compact
 * tree and cached at module level (a new LbvClient is constructed per tool
 * call, so an instance field would never be reused).
 */
export const CATEGORIES_PATH = '/api/categories';

/** Cap on roots/children returned by a single browse call. */
export const MAX_CATEGORY_LIST = 80;
/** Cap on name-search matches returned by a single browse call. */
export const MAX_CATEGORY_MATCHES = 40;

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
  depth: number;
  /** Aggregated product count (the API's total_number_of_products). */
  productCount: number;
  hasChildren: boolean;
  childIds: number[];
}

export interface CategoryTree {
  roots: number[];
  byId: Map<number, CategoryNode>;
  fetchedAt: number;
}

export interface CategoryMatch extends CategoryNode {
  /** Root-first breadcrumb of names, ending with the node itself. */
  path: string[];
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Normalize the raw /api/categories payload into a compact tree. The live data
 * is really a DAG — a node can appear under several parents (e.g. a seasonal
 * list surfacing in both a promo root and its home aisle). The first
 * occurrence wins: later occurrences are linked from their parent's childIds
 * but keep the first occurrence's parentId/depth.
 */
export function parseCategoryTree(raw: unknown): CategoryTree {
  const byId = new Map<number, CategoryNode>();
  const roots: number[] = [];

  const walk = (rawNode: unknown, parentId: number | null, depth: number): number | null => {
    if (typeof rawNode !== 'object' || rawNode === null) return null;
    const n = rawNode as Record<string, unknown>;
    const id = typeof n.id === 'number' && Number.isFinite(n.id) ? n.id : null;
    const name = typeof n.name === 'string' ? n.name.trim() : '';
    if (id === null || !name) return null;
    if (byId.has(id)) return id;

    const node: CategoryNode = {
      id,
      name,
      parentId,
      depth,
      productCount: count(n.total_number_of_products),
      hasChildren: false,
      childIds: [],
    };
    byId.set(id, node);
    const children = Array.isArray(n.descendent) ? n.descendent : [];
    for (const child of children) {
      const childId = walk(child, id, depth + 1);
      if (childId !== null && childId !== id && !node.childIds.includes(childId)) {
        node.childIds.push(childId);
      }
    }
    node.hasChildren = node.childIds.length > 0;
    return id;
  };

  for (const root of Array.isArray(raw) ? raw : []) {
    const id = walk(root, null, 0);
    if (id !== null && !roots.includes(id)) roots.push(id);
  }
  return { roots, byId, fetchedAt: Date.now() };
}

/** Children of a category, or the root aisles when parentId is null. */
export function getChildren(tree: CategoryTree, parentId: number | null): CategoryNode[] {
  const ids = parentId === null ? tree.roots : (tree.byId.get(parentId)?.childIds ?? []);
  const out: CategoryNode[] = [];
  for (const id of ids) {
    const node = tree.byId.get(id);
    if (node) out.push(node);
  }
  return out;
}

/**
 * The category plus every descendant, as a Set of ids. Search hits carry only
 * their direct category ids, so filtering by a parent category REQUIRES this
 * expansion. Cycle-safe (the live data is a DAG).
 */
export function descendantIdSet(tree: CategoryTree, id: number): Set<number> {
  const out = new Set<number>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (out.has(cur)) continue;
    out.add(cur);
    const node = tree.byId.get(cur);
    if (node) stack.push(...node.childIds);
  }
  return out;
}

/** Root-first breadcrumb of names ending with the node itself. */
export function pathTo(tree: CategoryTree, id: number): string[] {
  const names: string[] = [];
  const seen = new Set<number>();
  let cur = tree.byId.get(id) ?? null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.push(cur.name);
    cur = cur.parentId === null ? null : (tree.byId.get(cur.parentId) ?? null);
  }
  return names.reverse();
}

/** Accent-insensitive lowercase fold, so "epicerie" matches "Épicerie". */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Name search over the whole tree, ranked exact > starts-with > contains and
 * by product count within each rank. Uncapped — callers cap for display but
 * report the true total.
 */
export function findByName(tree: CategoryTree, query: string): CategoryMatch[] {
  const q = fold(query);
  if (!q) return [];
  const exact: CategoryMatch[] = [];
  const starts: CategoryMatch[] = [];
  const contains: CategoryMatch[] = [];
  for (const node of tree.byId.values()) {
    const name = fold(node.name);
    const bucket = name === q ? exact : name.startsWith(q) ? starts : name.includes(q) ? contains : null;
    if (bucket) bucket.push({ ...node, path: pathTo(tree, node.id) });
  }
  const byCount = (a: CategoryMatch, b: CategoryMatch) => b.productCount - a.productCount;
  exact.sort(byCount);
  starts.sort(byCount);
  contains.sort(byCount);
  return [...exact, ...starts, ...contains];
}

/** Resolve up to `limit` category ids to names, in order, skipping unknowns. */
export function resolveNames(tree: CategoryTree | null, ids: number[], limit = 3): string[] {
  if (!tree) return [];
  const names: string[] = [];
  for (const id of ids) {
    if (names.length >= limit) break;
    const node = tree.byId.get(id);
    if (node) names.push(node.name);
  }
  return names;
}

// --- Module-level cache ------------------------------------------------------
// Process-lifetime, independent of any LbvClient instance (withClient builds a
// fresh client per tool call). Single-flight so concurrent cold calls share one
// ~7 MB fetch. Deliberately NOT mirrored to KV in v1: the compact tree is close
// to Upstash's value-size ceiling and the payoff is tiny at personal-use
// concurrency.

let cache: CategoryTree | null = null;
let inflight: Promise<CategoryTree> | null = null;

function isFresh(tree: CategoryTree): boolean {
  return Date.now() - tree.fetchedAt < CATEGORY_TREE_TTL_SECONDS * 1000;
}

/**
 * Synchronous peek at whatever tree is cached (even a stale one — category
 * names do not rot meaningfully). Never triggers a fetch: the plain-search hot
 * path uses this so taxonomy availability can never slow it down.
 */
export function peekCategoryTree(): CategoryTree | null {
  return cache;
}

/**
 * Return the cached tree, fetching (single-flight) when cold, stale or
 * forceRefresh. If a refresh fails but a stale tree exists, the stale tree is
 * returned rather than failing the caller.
 */
export async function getCategoryTree(
  http: LbvHttp,
  opts: { forceRefresh?: boolean } = {},
): Promise<CategoryTree> {
  if (cache && isFresh(cache) && !opts.forceRefresh) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const raw = await http.getJson<unknown>(CATEGORIES_PATH, { xhr: false, accept: 'application/json' });
      cache = parseCategoryTree(raw);
      return cache;
    } catch (err) {
      if (cache) return cache;
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam: drop the cached tree and any in-flight fetch. */
export function resetCategoryTreeCache(): void {
  cache = null;
  inflight = null;
}
