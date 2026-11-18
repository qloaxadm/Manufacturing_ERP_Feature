import { test, expect } from '@playwright/test';
import { apiAs, buildLockedInvoice, json, ok, ROLES, uid, USERS } from '../../helpers/api';

test.describe('Barcode validation service', () => {
  test('recognises packing, box and invoice barcodes and reports their state', async () => {
    const lot = await buildLockedInvoice();
    const api = await apiAs('gate');

    const box = await ok(await api.post('/api/barcode/validate', { data: { barcode: lot.box.barcode } }));
    expect(box).toMatchObject({ type: 'BOX', is_valid: true, validation_status: 'VALID' });
    expect(box.details.lock_status).toMatch(/Locked/);

    const invoice = await ok(await api.post('/api/barcode/validate', { data: { barcode: lot.invoice.barcode } }));
    expect(invoice).toMatchObject({ type: 'INVOICE', is_valid: true });

    // barcode types are role-gated: the gate officer is not authorised to inspect packing labels
    const denied = await ok(await api.post('/api/barcode/validate', { data: { barcode: lot.packing.barcode } }));
    expect(denied).toMatchObject({ type: 'PACKING', is_valid: false, validation_status: 'UNAUTHORIZED' });

    // the packing operator is authorised; a fresh, un-boxed packing is valid
    // (re-validating an already-boxed packing is a known issue, see 07-known-issues.spec.ts)
    const packingUser = await apiAs('packing');
    const fresh = await ok(await packingUser.post('/api/packing/single', { data: { part_id: lot.part.id, part_qty: 1 } }));
    const valid = await ok(await packingUser.post('/api/barcode/validate', { data: { barcode: fresh.barcode } }));
    expect(valid).toMatchObject({ type: 'PACKING', is_valid: true, validation_status: 'VALID' });
  });

  test('unknown barcodes are reported NOT_FOUND with an explanation', async () => {
    const api = await apiAs('packing');
    const r = await ok(await api.post('/api/barcode/validate', { data: { barcode: 'does-not-exist' } }));
    expect(r).toMatchObject({ type: 'UNKNOWN', validation_status: 'NOT_FOUND', is_valid: false });
    expect(r.message).toContain('not found');
  });

  test('bulk validation summarises valid / invalid / duplicate scans', async () => {
    const lot = await buildLockedInvoice();
    const api = await apiAs('gate');
    const r = await ok(
      await api.post('/api/barcode/bulk-validate', {
        data: { barcodes: [lot.box.barcode, lot.box.barcode, '999999', lot.invoice.barcode] },
      }),
    );
    expect(r.summary.scanned_count).toBe(4);
    expect(r.summary.valid_count).toBeGreaterThanOrEqual(2);
    expect(r.summary.invalid_count).toBeGreaterThanOrEqual(1);
    expect(r.summary.unique_count).toBeLessThan(r.summary.scanned_count);
    expect(Array.isArray(r.results)).toBe(true);
  });
});

test.describe('Dashboard', () => {
  for (const role of ROLES) {
    test(`${role} gets a role-specific dashboard payload`, async () => {
      const api = await apiAs(role);
      const d = await ok(await api.get('/api/dashboard/stats'));
      expect(d.role).toBe(role);
      expect(d.roleTitle).toBeTruthy();
    });
  }

  test('admin dashboard counts match the underlying lists', async () => {
    const admin = await apiAs('admin');
    const d = await ok(await admin.get('/api/dashboard/stats'));
    const [parts, packings, boxes, invoices, users] = await Promise.all([
      ok(await admin.get('/api/parts?limit=1')),
      ok(await admin.get('/api/packing')),
      ok(await admin.get('/api/boxes')),
      ok(await admin.get('/api/invoices')),
      ok(await admin.get('/api/users')),
    ]);
    expect(d.systemCounts.parts).toBe(parts.total);
    expect(d.systemCounts.packings).toBe((packings as any[]).length);
    expect(d.systemCounts.boxes).toBe((boxes as any[]).length);
    expect(d.systemCounts.invoices).toBe((invoices as any[]).length);
    expect(d.systemCounts.users).toBe((users as any[]).length);
    expect(d.systemCounts.lockedBoxes + d.systemCounts.unlockedBoxes).toBe(d.systemCounts.boxes);
    const dist = d.stockDistribution;
    expect(dist.rawStock + dist.fgStock + dist.boxStock + dist.invStock).toBe(dist.totalStock);
  });
});

test.describe('Notifications', () => {
  test('admin event -> list, filter, read, unread-count, mark-all-read', async () => {
    const admin = await apiAs('admin');
    const tag = uid();
    const created = await ok(
      await admin.post('/api/notifications/system-event', {
        data: { reason: `reason-${tag}`, module: 'E2E', title: `Title ${tag}`, message: `Body ${tag}`, priority: 'HIGH' },
      }),
    );
    expect(created.priority).toBe('HIGH');
    expect(created.message).toContain(`reason-${tag}`); // explainability: reason is part of the message

    const before = await ok(await admin.get('/api/notifications/unread-count'));
    expect(before.unread_count).toBeGreaterThan(0);

    const found = await ok(await admin.get(`/api/notifications?search=${tag}`));
    expect(found.items).toHaveLength(1);
    const n = found.items[0];
    expect(n.is_read ?? 0).toBeFalsy();

    // filters
    const byPriority = await ok(await admin.get(`/api/notifications?search=${tag}&priority=HIGH`));
    expect(byPriority.items).toHaveLength(1);
    const wrongPriority = await ok(await admin.get(`/api/notifications?search=${tag}&priority=INFO`));
    expect(wrongPriority.items).toHaveLength(0);

    // mark one read
    await ok(await admin.patch(`/api/notifications/${n.id}/read`));
    const unreadOnly = await ok(await admin.get(`/api/notifications?search=${tag}&is_read=false`));
    expect(unreadOnly.items).toHaveLength(0);
    const after = await ok(await admin.get('/api/notifications/unread-count'));
    expect(after.unread_count).toBe(before.unread_count - 1);

    // mark all read -> badge goes to zero
    await ok(await admin.post('/api/notifications/mark-all-read'));
    expect((await ok(await admin.get('/api/notifications/unread-count'))).unread_count).toBe(0);

    const summary = await ok(await admin.get('/api/notifications/summary'));
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.user_role).toBe('admin');
  });

  test('notifications are scoped by role: admin-only alerts are hidden from operators', async () => {
    const admin = await apiAs('admin');
    const tag = uid();
    await ok(
      await admin.post('/api/notifications/system-event', {
        data: { reason: 'admin-only', module: 'E2E', title: `AdminOnly ${tag}`, message: `secret ${tag}` },
      }),
    );
    for (const role of ['packing', 'box', 'invoice', 'gate'] as const) {
      const api = await apiAs(role);
      const list = await ok(await api.get(`/api/notifications?search=${tag}`));
      expect(list.items, `${role} must not see admin-only alert`).toHaveLength(0);
    }
  });

  test('only admin / gate can resolve; only admin can trigger test notifications', async () => {
    const admin = await apiAs('admin');
    const tag = uid();
    const n = await ok(
      await admin.post('/api/notifications/system-event', {
        data: { reason: 'r', module: 'E2E', title: `Resolve ${tag}`, message: 'm', priority: 'WARNING' },
      }),
    );
    const list = await ok(await admin.get(`/api/notifications?search=${tag}`));
    const id = list.items[0].id;
    expect((await (await apiAs('packing')).post(`/api/notifications/${id}/resolve`, { data: { note: 'x' } })).status()).toBe(403);
    expect((await (await apiAs('invoice')).post('/api/notifications/trigger-test', { data: {} })).status()).toBe(403);
    const resolved = await admin.post(`/api/notifications/${id}/resolve`, { data: { note: 'resolved by e2e' } });
    expect(resolved.status(), await resolved.text()).toBeLessThan(300);
    expect(n).toBeTruthy();
  });
});

test.describe('Settings', () => {
  test('every role gets only the sections it may configure', async () => {
    const admin = await ok(await (await apiAs('admin')).get('/api/settings'));
    expect(admin.role).toBe('admin');
    expect(admin.allowedSections).toEqual(expect.arrayContaining(['company', 'barcode', 'system', 'audit']));
    for (const role of ['packing', 'box', 'invoice', 'gate'] as const) {
      const s = await ok(await (await apiAs(role)).get('/api/settings'));
      expect(s.role).toBe(role);
      expect(s.allowedSections.length, role).toBeLessThan(admin.allowedSections.length);
      expect(s.allowedSections, role).not.toContain('system');
    }
  });

  test('settings can be saved and the response echoes success', async () => {
    const api = await apiAs('admin');
    const res = await ok(await api.put('/api/settings', { data: { preferences: { theme: 'light' } } }));
    expect(res.success).toBe(true);
    expect(res.settings.role).toBe('admin');
  });

  test('barcode settings document the clearance code formula', async () => {
    const s = await ok(await (await apiAs('admin')).get('/api/settings'));
    expect(s.barcode.clearanceCodeFormula).toBe('${invoice_number}4000${match_id}');
  });
});

test.describe('Activity log (append-only audit trail)', () => {
  test('admin sees every action and stats; operators see only their own role\'s activity', async () => {
    const packing = await apiAs('packing');
    const me = await ok(await packing.get('/api/auth/me'));
    const tag = uid();
    const part = await ok(
      await packing.post('/api/parts', { data: { part_number: `E2E-AL-${tag}`, part_desc: 'audit', qty: 3, supplier_name: 's' } }),
    );

    const admin = await apiAs('admin');
    const all = await ok(await admin.get('/api/activity-log?limit=200'));
    const entry = (all.items as any[]).find((a) => a.entity_id === part.part_number);
    expect(entry, 'part creation is audited').toBeTruthy();
    // (user_id attribution is covered by the known-issues spec)
    expect(entry).toMatchObject({ module: 'Part Master', user_name: USERS.packing.name, user_role: 'packing' });
    expect(entry.details).toContain(part.part_number);

    const stats = await ok(await admin.get('/api/activity-log/stats'));
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.insertCount + stats.updateCount + stats.deleteCount).toBeLessThanOrEqual(stats.total);

    // an operator only sees rows that are theirs or belong to their own role (never other departments)
    const mine = await ok(await packing.get('/api/activity-log?limit=200'));
    expect((mine.items as any[]).length).toBeGreaterThan(0);
    for (const row of mine.items as any[]) {
      expect(row.user_id === me.id || row.user_role === 'packing', `row ${row.id} (${row.user_role}) leaked`).toBe(true);
    }
    const gate = await ok(await (await apiAs('gate')).get('/api/activity-log?limit=200'));
    expect((gate.items as any[]).some((a) => a.entity_id === part.part_number)).toBe(false);
  });

  test('the audit log is immutable: no write endpoints exist', async () => {
    const admin = await apiAs('admin');
    for (const [method, url] of [
      ['delete', '/api/activity-log/1'],
      ['put', '/api/activity-log/1'],
      ['patch', '/api/activity-log/1'],
      ['post', '/api/activity-log'],
    ] as const) {
      const res = await admin[method](url, { data: {} });
      expect(res.status(), `${method} ${url}`).toBe(404);
    }
  });
});
