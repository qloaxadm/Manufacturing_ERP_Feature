import { test, expect } from '@playwright/test';
import { apiAnon, apiAs, badRequest, json, ok, SEED, uid } from '../../helpers/api';

test.describe('Parts master', () => {
  test('list is paginated and reports a total', async () => {
    const api = await apiAs('admin');
    const page1 = await ok(await api.get('/api/parts?page=1&limit=5'));
    expect(page1.items).toHaveLength(5);
    expect(page1.total).toBeGreaterThanOrEqual(3053);
    const page2 = await ok(await api.get('/api/parts?page=2&limit=5'));
    expect(page2.items).toHaveLength(5);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
  });

  test('simple list is a lightweight array for dropdowns', async () => {
    const api = await apiAs('box');
    const simple = await ok(await api.get('/api/parts/simple'));
    expect(Array.isArray(simple)).toBe(true);
    expect(Object.keys(simple[0]).sort()).toEqual(['id', 'part_description', 'part_number', 'qty']);
  });

  test('full part lifecycle: create -> search -> add stock -> edit -> finish -> history -> delete', async () => {
    const api = await apiAs('packing'); // packing role owns part master
    const tag = uid();
    const number = `E2E-PART-${tag}`;

    // create
    const created = await ok(
      await api.post('/api/parts', {
        data: { part_number: number, part_desc: 'Lifecycle part', qty: 10, supplier_name: 'ACME', supplier_invoice_no: 'S-1' },
      }),
    );
    expect(created).toMatchObject({ part_number: number, part_description: 'Lifecycle part', qty: 10 });

    // duplicate + blank validation
    await badRequest(await api.post('/api/parts', { data: { part_number: number, part_desc: 'dup', qty: 1 } }), 'already exists');
    await badRequest(await api.post('/api/parts', { data: { part_number: '', part_desc: '', qty: 1 } }), 'required');

    // search finds exactly it
    const found = await ok(await api.get(`/api/parts?search=${number}`));
    expect(found.total).toBe(1);
    expect(found.items[0].id).toBe(created.id);

    // add stock
    const added = await ok(
      await api.post(`/api/parts/${created.id}/add-stock`, {
        data: { qty: 5, supplier_name: 'ACME', supplier_invoice_no: 'S-2' },
      }),
    );
    expect(added.success).toBe(true);
    expect(added.part.qty).toBe(15);
    expect(added.message).toContain('15');
    await badRequest(
      await api.post(`/api/parts/${created.id}/add-stock`, { data: { qty: 0, supplier_name: 'ACME' } }),
      'greater than zero',
    );

    // edit
    const edited = await ok(await api.patch(`/api/parts/${created.id}`, { data: { part_desc: 'Edited description' } }));
    expect(edited.part_description).toBe('Edited description');
    expect(edited.qty).toBe(15);

    // mark finished -> stock 0 + history entry
    const finished = await ok(await api.post(`/api/parts/${created.id}/mark-finished`, { data: { reason: 'e2e close-out' } }));
    expect(finished).toMatchObject({ event_type: 'STOCK_FINISHED', previous_qty: 15, new_qty: 0, quantity_change: -15 });

    const history = await ok(await api.get(`/api/parts/${created.id}/history`));
    expect(history.part.qty).toBe(0);
    const events = (history.history as any[]).map((h) => h.event_type);
    expect(events).toContain('STOCK_FINISHED');
    expect(history.history.length).toBeGreaterThanOrEqual(3); // created + added + finished

    // the depletion is surfaced to admins as a notification with a reason
    const admin = await apiAs('admin');
    const notifs = await ok(await admin.get(`/api/notifications?limit=50&search=${number}`));
    const depleted = (notifs.items as any[]).find((n) => n.type === 'STOCK_DEPLETED_WARNING');
    expect(depleted, 'stock-depleted notification').toBeTruthy();
    expect(depleted.reason).toContain('e2e close-out');

    // audit trail
    const activity = await ok(await admin.get('/api/activity-log?limit=50'));
    expect((activity.items as any[]).some((a) => a.entity_id === number)).toBe(true);

    // delete
    const del = await ok(await api.delete(`/api/parts/${created.id}`));
    expect(del.success).toBe(true);
    const after = await ok(await api.get(`/api/parts?search=${number}`));
    expect(after.total).toBe(0);
  });

  test('part stock report exposes remaining / FG / box / invoice stock', async () => {
    const api = await apiAs('packing');
    const stock = await ok(await api.get(`/api/parts/stock?search=${SEED.partNumber}`));
    const row = (stock.items as any[]).find((p) => p.part_number === SEED.partNumber);
    expect(row).toBeTruthy();
    for (const key of ['remaining_stock', 'fg_stock', 'box_stock', 'inv_stock']) {
      expect(typeof row[key], key).toBe('number');
    }
  });

  test('history for an unknown part is a clean 4xx, not a 500', async () => {
    const api = await apiAs('admin');
    const res = await api.get('/api/parts/99999999/history');
    expect([400, 404]).toContain(res.status());
  });
});

test.describe('Customers', () => {
  test('create, list, rename (PUT and POST /:id/update) and validate', async () => {
    const admin = await apiAs('admin');
    const name = `E2E Customer ${uid()}`;
    const created = await ok(await admin.post('/api/customers', { data: { customer_name: name } }));
    expect(created.customer_name).toBe(name);

    await badRequest(await admin.post('/api/customers', { data: { customer_name: '' } }), 'required');

    // box role may read but not write
    const box = await apiAs('box');
    const list = await ok(await box.get('/api/customers'));
    expect((list as any[]).some((c) => c.id === created.id)).toBe(true);
    expect((await box.post('/api/customers', { data: { customer_name: 'x' } })).status()).toBe(403);

    const renamed = await ok(await admin.put(`/api/customers/${created.id}`, { data: { customer_name: `${name} v2` } }));
    expect(renamed.customer_name).toBe(`${name} v2`);
    const renamed2 = await ok(
      await admin.post(`/api/customers/${created.id}/update`, { data: { customer_name: `${name} v3` } }),
    );
    expect(renamed2.customer_name).toBe(`${name} v3`);
    const again = await ok(await admin.get('/api/customers'));
    expect((again as any[]).find((c) => c.id === created.id).customer_name).toBe(`${name} v3`);
  });
});

test.describe('ERP users', () => {
  test('admin creates a user who can log in, then deletes them', async () => {
    const admin = await apiAs('admin');
    const email = `e2e-${uid().toLowerCase()}@talbros.com`;
    const created = await ok(
      await admin.post('/api/users', {
        data: { user_name: 'E2E Operator', user_email: email, user_password: 'op-pass', user_role: ' Packing ' },
      }),
    );
    expect(created).toMatchObject({ user_email: email, type: 'packing' }); // role normalised to lower-case

    await badRequest(
      await admin.post('/api/users', {
        data: { user_name: 'dup', user_email: email, user_password: 'x', user_role: 'box' },
      }),
      'already exists',
    );
    await badRequest(await admin.post('/api/users', { data: { user_name: 'only name' } }), 'required');

    const anon = await apiAnon();
    const login = await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'op-pass' } });
    expect(login.status()).toBe(201);

    const del = await ok(await admin.delete(`/api/users/${created.id}`));
    expect(del.success).toBe(true);
    expect((await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'op-pass' } })).status()).toBe(401);
  });

  test('an admin cannot delete their own account', async () => {
    const admin = await apiAs('admin');
    const me = await ok(await admin.get('/api/auth/me'));
    await badRequest(await admin.delete(`/api/users/${me.id}`), 'cannot delete your own');
  });

  test('deleting an unknown user is rejected', async () => {
    const admin = await apiAs('admin');
    await badRequest(await admin.delete('/api/users/99999999'), 'not found');
  });
});
