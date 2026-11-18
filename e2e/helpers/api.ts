import { APIRequestContext, APIResponse, expect, request as pwRequest } from '@playwright/test';

export const API_URL = `http://127.0.0.1:${process.env.E2E_API_PORT || 5101}`;

export type Role = 'admin' | 'packing' | 'box' | 'invoice' | 'gate';

/** Seeded demo accounts that ship in Dump20260919.sql */
export const USERS: Record<Role, { email: string; password: string; name: string }> = {
  admin: { email: 'admin@admin.com', password: 'admin', name: 'admin' },
  packing: { email: 'dpr@talbros.com', password: 'dpr', name: 'DPR' },
  box: { email: 'fgs@talbros.com', password: 'fgs', name: 'FGS' },
  invoice: { email: 'invoice@talbros.com', password: 'invoice', name: 'INVOICE' },
  gate: { email: 'gate@talbros.com', password: 'gate', name: 'GATE' },
};

export const ROLES = Object.keys(USERS) as Role[];

/** Seeded baseline rows (known part / customer ids in the dump) */
export const SEED = {
  /** TEST-PART-2390 : remaining stock 10 in the dump */
  partId: 3053,
  partNumber: 'TEST-PART-2390',
  /** Mahindra & Mahindra */
  customerId: 1,
  customerName: 'Mahindra & Mahindra',
};

/** Short unique suffix so repeated runs / parallel data never collide */
export const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

const tokenCache = new Map<Role, string>();

export async function loginToken(role: Role): Promise<string> {
  const cached = tokenCache.get(role);
  if (cached) return cached;
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  try {
    const res = await ctx.post('/api/auth/login', {
      data: { user_email: USERS[role].email, user_password: USERS[role].password },
    });
    expect(res.ok(), `login as ${role} should succeed (HTTP ${res.status()})`).toBeTruthy();
    const body = await res.json();
    tokenCache.set(role, body.access_token);
    return body.access_token;
  } finally {
    await ctx.dispose();
  }
}

/** An APIRequestContext that sends the role's Bearer token on every call. */
export async function apiAs(role: Role): Promise<APIRequestContext> {
  const token = await loginToken(role);
  return pwRequest.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Anonymous context (no Authorization header). */
export async function apiAnon(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: API_URL });
}

export async function json<T = any>(res: APIResponse): Promise<T> {
  return (await res.json()) as T;
}

/** Asserts a 2xx and returns the parsed JSON body. */
export async function ok<T = any>(res: APIResponse): Promise<T> {
  const text = await res.text();
  expect(res.ok(), `HTTP ${res.status()} ${res.url()} -> ${text.slice(0, 300)}`).toBeTruthy();
  return JSON.parse(text) as T;
}

/** Asserts a 400 and returns the error message. */
export async function badRequest(res: APIResponse, messagePart?: string | RegExp): Promise<string> {
  const text = await res.text();
  expect(res.status(), `expected 400, got ${res.status()}: ${text.slice(0, 300)}`).toBe(400);
  const message = String(JSON.parse(text).message);
  if (messagePart) {
    if (typeof messagePart === 'string') expect(message).toContain(messagePart);
    else expect(message).toMatch(messagePart);
  }
  return message;
}

/**
 * Creates a self-contained, ready-to-dispatch lot through the API:
 *   new part (stock) -> packing -> box (locked) -> invoice (locked)
 * Every row is unique to the caller, so tests never depend on each other.
 */
export async function buildLockedInvoice(opts: { qty?: number } = {}) {
  const qty = opts.qty ?? 4;
  const tag = uid();
  const admin = await apiAs('admin');
  try {
    const part = await ok(
      await admin.post('/api/parts', {
        data: { part_number: `E2E-${tag}`, part_desc: `E2E part ${tag}`, qty: qty + 6, supplier_name: 'E2E Supplier' },
      }),
    );
    const packing = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: qty } }));
    const box = await ok(
      await admin.post('/api/boxes', {
        data: { box_name: part.part_number, customer_id: SEED.customerId, box_size: '40x40x40' },
      }),
    );
    await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: packing.barcode } }));
    await ok(await admin.post('/api/boxes/lock', { data: { box_id: box.id } }));
    const invoice = await ok(
      await admin.post('/api/invoices', { data: { invoice_number: `E2E-INV-${tag}`, part_id: part.id, qty } }),
    );
    await ok(await admin.post('/api/invoices/add-box', { data: { invoice_id: invoice.id, box_id: box.barcode } }));
    await ok(await admin.post('/api/invoices/lock', { data: { invoice_id: invoice.id } }));
    return { tag, qty, part, packing, box, invoice };
  } finally {
    await admin.dispose();
  }
}

/** Creates a throw-away ERP user (admin API) and returns its credentials; delete with removeUser. */
export async function createTempUser(role: Role = 'packing') {
  const admin = await apiAs('admin');
  try {
    const email = `tmp-${uid().toLowerCase()}@talbros.com`;
    const password = 'tmp-pass';
    const user = await ok(
      await admin.post('/api/users', { data: { user_name: 'Temp User', user_email: email, user_password: password, user_role: role } }),
    );
    return { id: user.id as number, email, password, name: 'Temp User' };
  } finally {
    await admin.dispose();
  }
}

export async function removeUser(id: number) {
  const admin = await apiAs('admin');
  try {
    await admin.delete(`/api/users/${id}`);
  } finally {
    await admin.dispose();
  }
}
