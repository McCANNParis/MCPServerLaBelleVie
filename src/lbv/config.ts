/**
 * Static configuration for the La Belle Vie (Deleev) private API.
 *
 * These values were reverse-engineered from the live site. The CSRF salts are
 * baked into the site's JS bundle (APP.USER.csrfnamesalt / csrfvaluesalt) and
 * are appended to the hidden-input token values before the login POST — see
 * auth.ts. They can rotate if La Belle Vie redeploys their frontend; if login
 * starts failing with a CSRF-rejection response, re-check these against the
 * current bundle.
 */

export const BASE_URL = 'https://www.labellevie.com';
export const SEARCH_URL = 'https://search.deleev.com';

/** Algolia/Typesense-style index names used by the Deleev search backend. */
export const PRODUCTS_INDEX = 'prod_products_ecommerce';
export const RECIPES_INDEX = 'prod_recipes_recipes';

/** Required search params discovered empirically (search 400s without them). */
export const SEARCH_ALTERNATE = '1-9';
export const DEFAULT_PER_PAGE = 25;

/** CSRF salts appended to the login-form hidden inputs before POST /connexion. */
export const CSRF_NAME_SALT = '_wYuZjspTTCNvyoN4';
export const CSRF_VALUE_SALT = '_jDWPYFHUAkgy3RFte';

/**
 * The `source` field the site sends when adding a product to the basket.
 * Verified working value; the payload is `{product_id, quantity, source}`.
 */
export const DEFAULT_CART_SOURCE = 'search';

/** A realistic desktop browser UA — some endpoints gate on a browser-like UA. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Default session TTL (seconds) for the cookie jar stored in KV/Redis. */
export const SESSION_TTL_SECONDS = 60 * 60 * 6; // 6 hours

/** Rolling TTL for a connected account record (refreshed on every use). */
export const CONNECTION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/** Lifetime of a one-time connect link, and wrong-password attempts allowed. */
export const LINK_CODE_TTL_SECONDS = 60 * 10; // 10 minutes
export const LINK_MAX_ATTEMPTS = 5;

/** How long the in-memory category tree is trusted before re-fetching. */
export const CATEGORY_TREE_TTL_SECONDS = 60 * 60 * 8; // 8 hours
