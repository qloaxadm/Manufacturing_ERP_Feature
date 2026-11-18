import { test, expect } from '@playwright/test';
import { apiAnon, apiAs, Role, ROLES } from '../../helpers/api';

/**
 * Role matrix, derived from the @Roles() decorators in backend/src/**\/*.controller.ts.
 * Admin is always allowed (RolesGuard). Unauthenticated -> 401. Wrong role -> 403.
 */
const ALL: Role[] = ['admin', 'packing', 'box', 'invoice', 'gate'];

const MATRIX: Array<{ url: string; allowed: Role[] }> = [
  { url: '/api/users', allowed: ['admin'] },
  { url: '/api/parts', allowed: ['admin', 'packing', 'box', 'invoice'] },
  { url: '/api/parts/simple', allowed: ['admin', 'packing', 'box', 'invoice'] },
  { url: '/api/parts/stock', allowed: ['admin', 'packing'] },
  { url: '/api/customers', allowed: ['admin', 'box'] },
  { url: '/api/packing', allowed: ['admin', 'packing'] },
  { url: '/api/boxes', allowed: ['admin', 'box'] },
  { url: '/api/invoices', allowed: ['admin', 'invoice'] },
  { url: '/api/verification', allowed: ['admin', 'gate'] },
  { url: '/api/reports/gate-out', allowed: ['admin', 'gate'] },
  { url: '/api/ai/stock-intelligence', allowed: ['admin'] },
  { url: '/api/ai/security-anomalies', allowed: ['admin'] },
  { url: '/api/ai/gate-risk/dashboard', allowed: ['admin'] },
  { url: '/api/ai/gate-risk/transactions', allowed: ['admin'] },
  { url: '/api/ai/gate-risk/config', allowed: ['admin'] },
  { url: '/api/ai/security-briefing/today', allowed: ['admin'] },
  { url: '/api/ai/security-briefing/history', allowed: ['admin'] },
  { url: '/api/ai/status', allowed: ALL },
  { url: '/api/ai/ask/suggestions', allowed: ALL },
  { url: '/api/dashboard/stats', allowed: ALL },
  { url: '/api/notifications', allowed: ALL },
  { url: '/api/notifications/unread-count', allowed: ALL },
  { url: '/api/settings', allowed: ALL },
  { url: '/api/activity-log', allowed: ALL },
  { url: '/api/auth/me', allowed: ALL },
];

test.describe('RBAC: GET endpoint x role matrix', () => {
  for (const { url, allowed } of MATRIX) {
    test(`${url}  allowed: ${allowed.join(',')}`, async () => {
      const anon = await apiAnon();
      expect((await anon.get(url)).status(), 'no token').toBe(401);

      for (const role of ROLES) {
        const api = await apiAs(role);
        const status = (await api.get(url)).status();
        if (allowed.includes(role)) {
          expect(status, `${role} should be allowed`).toBe(200);
        } else {
          expect(status, `${role} should be forbidden`).toBe(403);
        }
      }
    });
  }
});

test.describe('RBAC: write endpoints', () => {
  const WRITES: Array<{ method: 'post' | 'put' | 'delete'; url: string; data?: object; allowed: Role[] }> = [
    { method: 'post', url: '/api/users', data: {}, allowed: ['admin'] },
    { method: 'delete', url: '/api/users/999999', allowed: ['admin'] },
    { method: 'post', url: '/api/customers', data: {}, allowed: ['admin'] },
    { method: 'put', url: '/api/customers/999999', data: {}, allowed: ['admin'] },
    { method: 'post', url: '/api/parts', data: {}, allowed: ['admin', 'packing'] },
    { method: 'post', url: '/api/packing/single', data: {}, allowed: ['admin', 'packing'] },
    { method: 'post', url: '/api/boxes', data: {}, allowed: ['admin', 'box'] },
    { method: 'post', url: '/api/boxes/lock', data: {}, allowed: ['admin', 'box'] },
    { method: 'post', url: '/api/invoices', data: {}, allowed: ['admin', 'invoice'] },
    { method: 'post', url: '/api/invoices/lock', data: {}, allowed: ['admin', 'invoice'] },
    { method: 'post', url: '/api/verification/start', data: {}, allowed: ['admin', 'gate'] },
    { method: 'post', url: '/api/verification/scan-box', data: {}, allowed: ['admin', 'gate'] },
    { method: 'post', url: '/api/ai/gate-risk/review', data: {}, allowed: ['admin'] },
    { method: 'post', url: '/api/ai/security-briefing/generate', data: {}, allowed: ['admin'] },
    { method: 'post', url: '/api/notifications/trigger-test', data: {}, allowed: ['admin'] },
  ];

  for (const w of WRITES) {
    test(`${w.method.toUpperCase()} ${w.url} allowed: ${w.allowed.join(',')}`, async () => {
      // For roles that are NOT allowed we only assert the guard: it must answer 403 and must
      // never reach the business logic. (Allowed roles get a 4xx validation error for empty
      // bodies - that proves the guard let them through without us creating junk data.)
      const anon = await apiAnon();
      expect((await anon[w.method](w.url, { data: w.data })).status(), 'no token').toBe(401);
      for (const role of ROLES) {
        const api = await apiAs(role);
        const status = (await api[w.method](w.url, { data: w.data })).status();
        if (w.allowed.includes(role)) {
          expect(status, `${role} must pass the role guard`).not.toBe(403);
          expect(status, `${role} must not 401`).not.toBe(401);
        } else {
          expect(status, `${role} must be forbidden`).toBe(403);
        }
      }
    });
  }
});
