import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  descendantIdSet,
  findByName,
  getCategoryTree,
  getChildren,
  parseCategoryTree,
  pathTo,
  peekCategoryTree,
  resetCategoryTreeCache,
  resolveNames,
} from '../../src/lbv/categories';
import { CATEGORY_TREE_TTL_SECONDS } from '../../src/lbv/config';
import type { LbvHttp } from '../../src/lbv/http';

const raw = JSON.parse(
  readFileSync(new URL('../fixtures/categories.json', import.meta.url), 'utf8'),
);
const tree = parseCategoryTree(raw);

describe('parseCategoryTree', () => {
  it('collects roots in order, skipping invalid and duplicate roots', () => {
    // The fixture has a duplicated "Pâtisserie" root, one root with a string
    // id and one with an empty name — all three must be dropped.
    expect(tree.roots).toEqual([1522, 71, 4441, 3700]);
    expect(tree.byId.size).toBe(11);
  });

  it('maps node fields (productCount from total_number_of_products)', () => {
    const fruits = tree.byId.get(204);
    expect(fruits).toMatchObject({
      id: 204,
      name: 'Fruits',
      parentId: 71,
      depth: 1,
      productCount: 65,
      hasChildren: true,
      childIds: [74, 547],
    });
    const leaf = tree.byId.get(74);
    expect(leaf).toMatchObject({ parentId: 204, depth: 2, productCount: 37, hasChildren: false });
  });

  it('keeps the first occurrence of a DAG-duplicated node but links it from both parents', () => {
    // 16819 appears under root 1522 first, then again under root 71.
    const dup = tree.byId.get(16819);
    expect(dup?.parentId).toBe(1522);
    expect(tree.byId.get(1522)?.childIds).toContain(16819);
    expect(tree.byId.get(71)?.childIds).toEqual([204, 16819]);
  });
});

describe('getChildren', () => {
  it('returns the roots for parentId null', () => {
    expect(getChildren(tree, null).map((n) => n.id)).toEqual([1522, 71, 4441, 3700]);
  });
  it('returns direct children of a node', () => {
    expect(getChildren(tree, 204).map((n) => n.id)).toEqual([74, 547]);
  });
  it('returns [] for leaves and unknown ids', () => {
    expect(getChildren(tree, 3700)).toEqual([]);
    expect(getChildren(tree, 123456789)).toEqual([]);
  });
});

describe('descendantIdSet', () => {
  it('includes the node itself and all descendants', () => {
    expect([...descendantIdSet(tree, 204)].sort((a, b) => a - b)).toEqual([74, 204, 547]);
  });
  it('crosses DAG links without looping', () => {
    expect([...descendantIdSet(tree, 71)].sort((a, b) => a - b)).toEqual([71, 74, 204, 547, 16819]);
  });
  it('is just the id for unknown nodes', () => {
    expect([...descendantIdSet(tree, 42)]).toEqual([42]);
  });
});

describe('pathTo', () => {
  it('builds a root-first breadcrumb', () => {
    expect(pathTo(tree, 74)).toEqual(['Primeur', 'Fruits', 'Fruits exotiques']);
  });
  it('uses the first-occurrence parent for DAG-duplicated nodes', () => {
    expect(pathTo(tree, 16819)).toEqual([
      'Promos, lots & produits OFFERTS',
      'Les fruits et légumes de la semaine',
    ]);
  });
  it('returns [] for unknown ids', () => {
    expect(pathTo(tree, 42)).toEqual([]);
  });
});

describe('findByName', () => {
  it('ranks exact > startsWith > contains, by product count within each rank', () => {
    // Two nodes are named exactly "Bonbons" (203 vs 47 products), then the
    // starts-with match "Bonbons goût fruits et plantes".
    expect(findByName(tree, 'bonbons').map((m) => m.id)).toEqual([2319, 4975, 5675]);
    expect(findByName(tree, 'fruits').map((m) => m.id)).toEqual([204, 74, 547, 16819, 5675]);
  });

  it('is accent-insensitive in both directions', () => {
    expect(findByName(tree, 'patisserie').map((m) => m.id)).toEqual([3700]);
    expect(findByName(tree, 'épicerie').map((m) => m.id)).toEqual([4441]);
  });

  it('attaches breadcrumb paths and returns [] for blank queries', () => {
    const [top] = findByName(tree, 'fruits exotiques');
    expect(top.path).toEqual(['Primeur', 'Fruits', 'Fruits exotiques']);
    expect(findByName(tree, '   ')).toEqual([]);
  });
});

describe('resolveNames', () => {
  it('resolves up to the limit, skipping unknown ids', () => {
    // 13037 exists live but not in the trimmed fixture — it must be skipped.
    expect(resolveNames(tree, [2319, 5675, 13037])).toEqual([
      'Bonbons',
      'Bonbons goût fruits et plantes',
    ]);
    expect(resolveNames(tree, [74, 547, 204, 2319])).toEqual([
      'Fruits exotiques',
      'Fruits BIO',
      'Fruits',
    ]);
  });
  it('returns [] when there is no tree', () => {
    expect(resolveNames(null, [74])).toEqual([]);
  });
});

describe('category tree cache', () => {
  function stubHttp(impl: () => Promise<unknown>): LbvHttp {
    return { getJson: () => impl() } as unknown as LbvHttp;
  }

  beforeEach(() => {
    resetCategoryTreeCache();
  });
  afterEach(() => {
    resetCategoryTreeCache();
    vi.useRealTimers();
  });

  it('fetches once and serves the cache afterwards', async () => {
    let calls = 0;
    const http = stubHttp(async () => (calls++, raw));
    expect(peekCategoryTree()).toBeNull();
    const first = await getCategoryTree(http);
    const second = await getCategoryTree(http);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(peekCategoryTree()).toBe(first);
  });

  it('de-duplicates concurrent cold fetches (single-flight)', async () => {
    let calls = 0;
    const http = stubHttp(
      () =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve(raw), 0);
        }),
    );
    const [a, b] = await Promise.all([getCategoryTree(http), getCategoryTree(http)]);
    expect(calls).toBe(1);
    expect(b).toBe(a);
  });

  it('refetches after the TTL expires and on forceRefresh', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const http = stubHttp(async () => (calls++, raw));
    await getCategoryTree(http);
    await getCategoryTree(http);
    expect(calls).toBe(1);
    vi.advanceTimersByTime((CATEGORY_TREE_TTL_SECONDS + 60) * 1000);
    await getCategoryTree(http);
    expect(calls).toBe(2);
    await getCategoryTree(http, { forceRefresh: true });
    expect(calls).toBe(3);
  });

  it('propagates a cold-fetch failure and retries on the next call', async () => {
    let calls = 0;
    const failing = stubHttp(async () => {
      calls++;
      throw new Error('network down');
    });
    await expect(getCategoryTree(failing)).rejects.toThrow('network down');
    expect(peekCategoryTree()).toBeNull();
    // The failed in-flight promise must not be reused.
    await expect(getCategoryTree(failing)).rejects.toThrow('network down');
    expect(calls).toBe(2);
  });

  it('falls back to the stale tree when a refresh fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    const http = stubHttp(async () => {
      if (fail) throw new Error('network down');
      return raw;
    });
    const first = await getCategoryTree(http);
    vi.advanceTimersByTime((CATEGORY_TREE_TTL_SECONDS + 60) * 1000);
    fail = true;
    const second = await getCategoryTree(http);
    expect(second).toBe(first);
  });
});
