/** Profile / addresses. Auth-required (400 when logged out). Tolerant parsers. */

export const FULL_PROFILE_PATH = '/api/fullprofile';
export const PROFILE_PATH = '/api/profile';
export const ADDRESSES_PATH = '/api/profile/addresses';

export interface Profile {
  id: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  raw: unknown;
}

/** Pull common identity fields out of the (varied) profile payload. */
export function parseProfile(json: unknown): Profile {
  const body = (json ?? {}) as Record<string, unknown>;
  const user = (body.user ?? body.profile ?? body) as Record<string, unknown>;
  return {
    id: user.id !== undefined && user.id !== null ? String(user.id) : null,
    email: (user.email as string) ?? null,
    firstName: (user.firstname as string) ?? (user.first_name as string) ?? null,
    lastName: (user.lastname as string) ?? (user.last_name as string) ?? null,
    raw: json,
  };
}

export interface Address {
  id: string;
  label: string | null;
  line1: string | null;
  postalCode: string | null;
  city: string | null;
}

function toArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['addresses', 'data', 'results', 'items']) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  return [];
}

export function parseAddresses(json: unknown): Address[] {
  return toArray(json).map((a) => ({
    id: String(a.id ?? ''),
    label: (a.label as string) ?? (a.name as string) ?? null,
    line1: (a.address as string) ?? (a.line1 as string) ?? (a.street as string) ?? null,
    postalCode: (a.postal_code as string) ?? (a.zip as string) ?? null,
    city: (a.city as string) ?? (a.city_name as string) ?? null,
  }));
}
