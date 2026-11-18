import { test, expect } from '@playwright/test';
import { apiAs, ok } from '../../helpers/api';

/**
 * KNOWN ISSUES - each test asserts the behaviour the product SHOULD have and is marked
 * `test.fail()`. While the bug exists the test "fails as expected" (suite stays green).
 * When someone fixes the bug, Playwright reports "expected to fail but passed": delete the
 * `test.fail(...)` line and the test becomes a permanent regression guard.
 */
test.describe('Known issues (expected failures)', () => {
  test('GET /api/users must not expose password values', async () => {
    test.fail(true, 'Passwords are stored and returned in plaintext (userinfo.user_password).');
    const admin = await apiAs('admin');
    const users = await ok(await admin.get('/api/users'));
    for (const u of users as any[]) expect(u, `user ${u.user_email}`).not.toHaveProperty('user_password');
  });

  test('POST /api/users response must not echo the password', async () => {
    test.fail(true, 'Create-user response includes user_password in plaintext.');
    const admin = await apiAs('admin');
    const email = `ki-${Date.now()}@talbros.com`;
    const created = await ok(
      await admin.post('/api/users', { data: { user_name: 'KI', user_email: email, user_password: 'secret1', user_role: 'box' } }),
    );
    await admin.delete(`/api/users/${created.id}`);
    expect(created).not.toHaveProperty('user_password');
  });

  test('barcode validation flags a packing that is already inside a box', async () => {
    test.fail(
      true,
      'box_packing.pack_id stores the packing BARCODE but BarcodeService looks it up by packing ID, so boxed packings still validate as "Ready for box packing".',
    );
    const admin = await apiAs('admin');
    const tag = Date.now();
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-KI-BC-${tag}`, part_desc: 'ki', qty: 10, supplier_name: 's' } }),
    );
    const pk = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 2 } }));
    const box = await ok(await admin.post('/api/boxes', { data: { box_name: part.part_number, customer_id: 1, box_size: '1x1x1' } }));
    await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pk.barcode } }));
    const res = await ok(await admin.post('/api/barcode/validate', { data: { barcode: pk.barcode } }));
    expect(res.is_valid).toBe(false);
    expect(res.validation_status).toBe('ALREADY_PROCESSED');
  });

  for (const [method, url] of [
    ['post', '/api/boxes/lock'],
    ['post', '/api/invoices/lock'],
    ['post', '/api/ai/gate-risk/review'],
  ] as const) {
    test(`${method.toUpperCase()} ${url} with an empty body must be a 4xx, not a 500`, async () => {
      test.fail(true, 'Missing ids become NaN and reach SQL (QueryFailedError: Unknown column NaN) -> HTTP 500.');
      const admin = await apiAs('admin');
      const res = await admin[method](url, { data: {} });
      expect(res.status()).toBeLessThan(500);
    });
  }

  test('GET /api/settings/health exists (the Settings page calls it for System Health)', async () => {
    test.fail(true, 'SettingsPage requests /api/settings/health but the settings controller has no such route (404), so System Health shows static text.');
    const admin = await apiAs('admin');
    expect((await admin.get('/api/settings/health')).status()).toBe(200);
  });

  test('POST /api/notifications/trigger-test with an empty body must be a 4xx, not a 500', async () => {
    test.fail(true, "Missing 'type' column value -> QueryFailedError -> HTTP 500.");
    const admin = await apiAs('admin');
    const res = await admin.post('/api/notifications/trigger-test', { data: {} });
    expect(res.status()).toBeLessThan(500);
  });

  test('part-master actions are attributed to the acting user id (audit + created_id + history)', async () => {
    test.fail(
      true,
      'parts.service reads user?.id || user?.sub || 3 but the JWT user object exposes `userId`, so every non-admin action is attributed to user 3 (admin).',
    );
    const packing = await apiAs('packing');
    const me = await ok(await packing.get('/api/auth/me'));
    const number = `E2E-KI-ID-${Date.now()}`;
    const part = await ok(
      await packing.post('/api/parts', { data: { part_number: number, part_desc: 'ki', qty: 1, supplier_name: 's' } }),
    );
    expect(part.created_id).toBe(me.id);
    const admin = await apiAs('admin');
    const log = await ok(await admin.get('/api/activity-log?limit=100'));
    expect((log.items as any[]).find((a) => a.entity_id === number).user_id).toBe(me.id);
    const history = await ok(await admin.get(`/api/parts/${part.id}/history`));
    expect(history.history[0].created_by_user_id).toBe(me.id);
  });

  test('audit-log rows record the actor email for part-master actions', async () => {
    test.fail(true, 'Part Master activity is logged with user_email = null even though user_id is known.');
    const packing = await apiAs('packing');
    const number = `E2E-KI-${Date.now()}`;
    await ok(await packing.post('/api/parts', { data: { part_number: number, part_desc: 'ki', qty: 1, supplier_name: 's' } }));
    const admin = await apiAs('admin');
    const log = await ok(await admin.get('/api/activity-log?limit=100'));
    const row = (log.items as any[]).find((a) => a.entity_id === number);
    expect(row.user_email).toBe('dpr@talbros.com');
  });

  test('AI security anomalies carry a risk/confidence score and a recommended review (AGENTS.md rule 4)', async () => {
    test.fail(true, 'security-anomalies items only expose type/severity/description - no score, evidence or recommendation.');
    const admin = await apiAs('admin');
    const rows = (await ok(await admin.get('/api/ai/security-anomalies'))) as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      expect(a.risk_score ?? a.confidence ?? a.confidence_score, 'quantified risk/confidence').toBeDefined();
      expect(a.recommendation ?? a.recommended_action, 'recommended human review').toBeTruthy();
    }
  });
});
