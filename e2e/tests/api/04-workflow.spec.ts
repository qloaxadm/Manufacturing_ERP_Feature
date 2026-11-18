import { test, expect } from '@playwright/test';
import { apiAs, badRequest, buildLockedInvoice, json, ok, SEED, uid } from '../../helpers/api';

/**
 * Packing -> Box -> Invoice -> Gate. Each step is performed by the role that owns it
 * (DPR packing, FGS box, INVOICE commercial, GATE security) exactly as in production.
 */
test.describe('Workflow: happy path, one lot through five roles', () => {
  test('part -> packing -> box -> invoice -> gate clearance -> gate-out report', async () => {
    const tag = uid();
    const qty = 5;
    const admin = await apiAs('admin');
    const packingUser = await apiAs('packing');
    const boxUser = await apiAs('box');
    const invoiceUser = await apiAs('invoice');
    const gate = await apiAs('gate');

    const stockOf = async (partId: number) => {
      const s = await ok(await admin.get(`/api/parts/stock?search=${encodeURIComponent(part.part_number)}`));
      return (s.items as any[]).find((p) => p.id === partId);
    };

    // --- ADMIN: master data
    const part = await ok(
      await admin.post('/api/parts', {
        data: { part_number: `E2E-WF-${tag}`, part_desc: 'Workflow part', qty: 20, supplier_name: 'ACME' },
      }),
    );
    expect((await stockOf(part.id)).remaining_stock).toBe(20);

    // --- PACKING (DPR)
    const packing = await ok(await packingUser.post('/api/packing/single', { data: { part_id: part.id, part_qty: qty } }));
    expect(packing).toMatchObject({ part_qty: qty, status: 'pending', remaining_stock: 15 });
    expect(packing.barcode).toMatch(/^1\d{5}$/); // packing barcodes start with 1
    expect((await stockOf(part.id)).remaining_stock).toBe(15);

    // --- BOX (FGS)
    const box = await ok(
      await boxUser.post('/api/boxes', {
        data: { box_name: part.part_number, customer_id: SEED.customerId, box_size: '50x50x50' },
      }),
    );
    expect(box).toMatchObject({ lock_status: 'no', status: 'pending', customer_id: SEED.customerId });
    expect(box.barcode).toMatch(/^2\d{5}$/);

    // negative: cannot lock an empty box
    await badRequest(await boxUser.post('/api/boxes/lock', { data: { box_id: box.id } }), 'Cannot lock an empty box');

    const added = await ok(await boxUser.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: packing.barcode } }));
    expect(added.success).toBe(true);

    let detail = await ok(await boxUser.get(`/api/boxes/${box.id}`));
    expect(detail.total_part_qty).toBe(qty);
    expect(detail.items).toHaveLength(1);
    expect(detail.customer.customer_name).toBe(SEED.customerName);
    expect(detail.box.lock_status).toBe('no');

    const lockedBox = await ok(await boxUser.post('/api/boxes/lock', { data: { box_id: box.id } }));
    expect(lockedBox).toMatchObject({ success: true, lock_status: 'yes' });
    detail = await ok(await boxUser.get(`/api/boxes/${box.id}`));
    expect(detail.box.lock_status).toBe('yes');
    expect(detail.total_part_qty).toBe(qty); // quantity survives the lock
    expect(detail.items).toHaveLength(1); // items stay visible after lock

    // packing record moved to "used" once inside a box
    const pk = await ok(await packingUser.get(`/api/packing/${packing.id}`));
    expect(JSON.stringify(pk)).toContain('"used"');

    // --- INVOICE (commercial)
    const invoice = await ok(
      await invoiceUser.post('/api/invoices', { data: { invoice_number: `WF-${tag}`, part_id: part.id, qty } }),
    );
    expect(invoice).toMatchObject({ lock_status: 'no', qty });
    expect(invoice.barcode).toMatch(/^3\d{5}$/);

    await badRequest(await invoiceUser.post('/api/invoices/lock', { data: { invoice_id: invoice.id } }), 'empty invoice');

    const addedBox = await ok(
      await invoiceUser.post('/api/invoices/add-box', { data: { invoice_id: invoice.id, box_id: box.barcode } }),
    );
    expect(addedBox.success).toBe(true);

    let inv = await ok(await invoiceUser.get(`/api/invoices/${invoice.id}`));
    expect(inv.total_part_qty).toBe(qty); // 5 / 5 matched
    expect(inv.boxes).toHaveLength(1);

    const lockedInvoice = await ok(await invoiceUser.post('/api/invoices/lock', { data: { invoice_id: invoice.id } }));
    expect(lockedInvoice).toMatchObject({ success: true, lock_status: 'yes' });
    inv = await ok(await invoiceUser.get(`/api/invoices/${invoice.id}`));
    expect(inv.invoice.lock_status).toBe('yes');
    expect(inv.invoice.status).toBe('pending'); // locked, but not yet dispatched

    // --- GATE (security)
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: invoice.barcode } }));
    expect(match.status).toBe('pending');
    expect(match.id).toBe(match.invoice_match_id);

    let ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver.invoice.status).toBe('used'); // claimed by the gate session
    expect(ver).toMatchObject({ expected_boxes_count: 1, scanned_boxes_count: 0, is_complete: false, checked: false });

    await badRequest(
      await gate.post('/api/verification/scan-box', { data: { match_id: match.id, box_barcode: '000000' } }),
      'not found in this invoice',
    );

    const scan = await ok(await gate.post('/api/verification/scan-box', { data: { match_id: match.id, box_barcode: box.barcode } }));
    expect(scan).toMatchObject({ success: true, matched: true, completed: true, remaining: 0 });
    // clearance code = <invoice_number> + "4000" + <match id>  (settings.barcode.clearanceCodeFormula)
    expect(scan.clearance_code).toBe(`${invoice.invoice_number}4000${match.id}`);
    expect(scan.gate_out_code).toBe(scan.clearance_code);

    ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver).toMatchObject({ scanned_boxes_count: 1, is_complete: true, checked: true });
    expect(ver.match.status).toBe('verified');

    // --- GATE-OUT REPORT
    const report = await ok(await gate.get('/api/reports/gate-out'));
    const row = (report as any[]).find((r) => r.invoice_number === invoice.invoice_number);
    expect(row, 'dispatched invoice appears in gate-out report').toBeTruthy();
    expect(row).toMatchObject({ qty, part_number: part.part_number, gateout_code: scan.clearance_code });

    // --- ADMIN: AI risk was recorded for the gate transaction (explainability: score + reasons)
    const risk = await ok(await admin.get(`/api/ai/gate-risk/match/${match.id}`));
    expect(risk.risk_score).toBeGreaterThanOrEqual(0);
    expect(risk.risk_score).toBeLessThanOrEqual(100);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(risk.risk_level);

    // --- the stock ledger shows the end-to-end consumption
    const history = await ok(await admin.get(`/api/parts/${part.id}/history`));
    expect((history.history as any[]).some((h) => h.event_type === 'STOCK_CONSUMED' && h.quantity_change === -qty)).toBe(true);
    expect((await stockOf(part.id)).remaining_stock).toBe(15);
  });
});

test.describe('Workflow guards: packing', () => {
  test('rejects quantity above available stock, zero and negative quantities', async () => {
    const admin = await apiAs('admin');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-PK-${uid()}`, part_desc: 'pk', qty: 10, supplier_name: 's' } }),
    );
    await badRequest(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 11 } }), "don't have enough stock");
    await badRequest(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 0 } }), 'Invalid quantity');
    await badRequest(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: -3 } }), 'Invalid quantity');
    // stock untouched by the rejected attempts
    const s = await ok(await admin.get(`/api/parts/stock?search=${part.part_number}`));
    expect(s.items[0].remaining_stock).toBe(10);
  });

  test('bulk packing creates N unique barcodes and deducts qty x N', async () => {
    const admin = await apiAs('admin');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-BK-${uid()}`, part_desc: 'bulk', qty: 30, supplier_name: 's' } }),
    );
    const rows = await ok(await admin.post('/api/packing/bulk', { data: { part_id: part.id, part_qty: 4, packing_qty: 5 } }));
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r: any) => r.barcode)).size).toBe(5);
    expect(rows.every((r: any) => r.part_qty === 4)).toBe(true);
    const s = await ok(await admin.get(`/api/parts/stock?search=${part.part_number}`));
    expect(s.items[0].remaining_stock).toBe(10); // 30 - 5*4

    // 3 x 4 = 12 > 10 remaining -> rejected, nothing created
    await badRequest(await admin.post('/api/packing/bulk', { data: { part_id: part.id, part_qty: 4, packing_qty: 3 } }));
    const after = await ok(await admin.get(`/api/parts/stock?search=${part.part_number}`));
    expect(after.items[0].remaining_stock).toBe(10);
  });

  test('barcodes are globally unique across the packing table', async () => {
    const admin = await apiAs('admin');
    const all = await ok(await admin.get('/api/packing'));
    const codes = (all as any[]).map((p) => p.barcode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('packing list supports a date range filter', async () => {
    const admin = await apiAs('admin');
    const none = await ok(await admin.get('/api/packing?from_date=1999-01-01&to_date=1999-01-02'));
    expect(none).toHaveLength(0);
    const today = new Date().toISOString().slice(0, 10);
    const some = await ok(await admin.get(`/api/packing?from_date=2000-01-01&to_date=${today}`));
    expect((some as any[]).length).toBeGreaterThan(0);
  });

  test('deleting a pending packing removes it', async () => {
    const admin = await apiAs('admin');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-DEL-${uid()}`, part_desc: 'd', qty: 10, supplier_name: 's' } }),
    );
    const pk = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 3 } }));
    await ok(await admin.delete(`/api/packing/${pk.id}`));
    const list = await ok(await admin.get('/api/packing'));
    expect((list as any[]).some((p) => p.id === pk.id)).toBe(false);
  });
});

test.describe('Workflow guards: box', () => {
  test('rejects unknown packing, wrong part, duplicate scan, and scans into a locked box', async () => {
    const admin = await apiAs('admin');
    const tag = uid();
    const partA = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-BXA-${tag}`, part_desc: 'a', qty: 50, supplier_name: 's' } }),
    );
    const partB = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-BXB-${tag}`, part_desc: 'b', qty: 50, supplier_name: 's' } }),
    );
    const pkA1 = await ok(await admin.post('/api/packing/single', { data: { part_id: partA.id, part_qty: 2 } }));
    const pkA2 = await ok(await admin.post('/api/packing/single', { data: { part_id: partA.id, part_qty: 3 } }));
    const pkB = await ok(await admin.post('/api/packing/single', { data: { part_id: partB.id, part_qty: 2 } }));
    const box = await ok(
      await admin.post('/api/boxes', { data: { box_name: partA.part_number, customer_id: SEED.customerId, box_size: '10x10x10' } }),
    );

    await badRequest(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: '999999' } }), 'not found or already used');
    await badRequest(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pkB.barcode } }), 'Part Id Not Matched');

    await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pkA1.barcode } }));
    await badRequest(
      await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pkA1.barcode } }),
      'not found or already used',
    );
    await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pkA2.barcode } }));
    const detail = await ok(await admin.get(`/api/boxes/${box.id}`));
    expect(detail.total_part_qty).toBe(5); // 2 + 3
    expect(detail.items).toHaveLength(2);

    await ok(await admin.post('/api/boxes/lock', { data: { box_id: box.id } }));
    const pkA3 = await ok(await admin.post('/api/packing/single', { data: { part_id: partA.id, part_qty: 1 } }));
    await badRequest(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pkA3.barcode } }), 'already locked');
  });

  test('unknown box id is a 404', async () => {
    const admin = await apiAs('admin');
    expect((await admin.get('/api/boxes/99999999')).status()).toBe(404);
  });
});

test.describe('Workflow guards: invoice', () => {
  test('rejects duplicate invoice numbers, unlocked boxes, unknown boxes and reused boxes', async () => {
    const admin = await apiAs('admin');
    const tag = uid();
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-IV-${tag}`, part_desc: 'i', qty: 50, supplier_name: 's' } }),
    );
    const pk = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 4 } }));
    const box = await ok(
      await admin.post('/api/boxes', { data: { box_name: part.part_number, customer_id: SEED.customerId, box_size: '10x10x10' } }),
    );
    await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pk.barcode } }));

    const inv1 = await ok(await admin.post('/api/invoices', { data: { invoice_number: `E2E-D-${tag}`, part_id: part.id, qty: 4 } }));
    await badRequest(
      await admin.post('/api/invoices', { data: { invoice_number: `E2E-D-${tag}`, part_id: part.id, qty: 4 } }),
      'Invoice Number Already Exists',
    );

    // box is still open
    await badRequest(
      await admin.post('/api/invoices/add-box', { data: { invoice_id: inv1.id, box_id: box.barcode } }),
      'still Unlocked',
    );
    await ok(await admin.post('/api/boxes/lock', { data: { box_id: box.id } }));
    await badRequest(
      await admin.post('/api/invoices/add-box', { data: { invoice_id: inv1.id, box_id: '999999' } }),
      'not found or already used',
    );
    await ok(await admin.post('/api/invoices/add-box', { data: { invoice_id: inv1.id, box_id: box.barcode } }));

    // the same box cannot go on a second invoice
    const inv2 = await ok(await admin.post('/api/invoices', { data: { invoice_number: `E2E-D2-${tag}`, part_id: part.id, qty: 4 } }));
    await badRequest(
      await admin.post('/api/invoices/add-box', { data: { invoice_id: inv2.id, box_id: box.barcode } }),
      'not found or already used',
    );
  });

  test('invoice numbers longer than 20 characters are rejected', async () => {
    const admin = await apiAs('admin');
    await badRequest(
      await admin.post('/api/invoices', { data: { invoice_number: 'X'.repeat(21), part_id: SEED.partId, qty: 1 } }),
      'must not exceed 20 characters',
    );
    // exactly 20 is fine
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-LEN-${uid()}`, part_desc: 'l', qty: 5, supplier_name: 's' } }),
    );
    const inv = await ok(await admin.post('/api/invoices', { data: { invoice_number: uid().padEnd(20, 'Z'), part_id: part.id, qty: 1 } }));
    expect(inv.invoice_number).toHaveLength(20);
  });

  test('unknown invoice id is a 404 for read, add-box and lock', async () => {
    const admin = await apiAs('admin');
    expect((await admin.get('/api/invoices/99999999')).status()).toBe(404);
    expect((await admin.post('/api/invoices/lock', { data: { invoice_id: 99999999 } })).status()).toBe(404);
    expect((await admin.post('/api/invoices/add-box', { data: { invoice_id: 99999999, box_id: '200001' } })).status()).toBe(404);
  });

  test('a draft invoice can be deleted', async () => {
    const admin = await apiAs('admin');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-ID-${uid()}`, part_desc: 'i', qty: 5, supplier_name: 's' } }),
    );
    const inv = await ok(await admin.post('/api/invoices', { data: { invoice_number: `E2E-X-${uid()}`, part_id: part.id, qty: 1 } }));
    await ok(await admin.delete(`/api/invoices/${inv.id}`));
    expect((await admin.get(`/api/invoices/${inv.id}`)).status()).toBe(404);
  });
});

test.describe('Workflow guards: gate verification', () => {
  test('cannot verify a draft (unlocked) invoice or an unknown barcode', async () => {
    const admin = await apiAs('admin');
    const gate = await apiAs('gate');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-GD-${uid()}`, part_desc: 'g', qty: 5, supplier_name: 's' } }),
    );
    const draft = await ok(await admin.post('/api/invoices', { data: { invoice_number: `E2E-G-${uid()}`, part_id: part.id, qty: 1 } }));
    await badRequest(await gate.post('/api/verification/start', { data: { invoice_barcode: draft.barcode } }), 'Unlocked / Draft');
    const unknown = await gate.post('/api/verification/start', { data: { invoice_barcode: '399999' } });
    expect([400, 404]).toContain(unknown.status());
  });

  test('partial scans stay pending; the last scan completes the clearance', async () => {
    // an invoice carrying TWO boxes
    const admin = await apiAs('admin');
    const gate = await apiAs('gate');
    const tag = uid();
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: `E2E-GP-${tag}`, part_desc: 'two boxes', qty: 40, supplier_name: 's' } }),
    );
    const boxes: any[] = [];
    for (let i = 0; i < 2; i++) {
      const pk = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 3 } }));
      const box = await ok(
        await admin.post('/api/boxes', { data: { box_name: part.part_number, customer_id: SEED.customerId, box_size: '10x10x10' } }),
      );
      await ok(await admin.post('/api/boxes/add-packing', { data: { box_id: box.id, pack_id: pk.barcode } }));
      await ok(await admin.post('/api/boxes/lock', { data: { box_id: box.id } }));
      boxes.push(box);
    }
    const inv = await ok(await admin.post('/api/invoices', { data: { invoice_number: `E2E-GPI-${tag}`, part_id: part.id, qty: 6 } }));
    for (const b of boxes) await ok(await admin.post('/api/invoices/add-box', { data: { invoice_id: inv.id, box_id: b.barcode } }));
    await ok(await admin.post('/api/invoices/lock', { data: { invoice_id: inv.id } }));

    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: inv.barcode } }));
    const first = await ok(await gate.post('/api/verification/scan-box', { data: { match_id: match.id, box_barcode: boxes[0].barcode } }));
    expect(first).toMatchObject({ matched: true, completed: false, remaining: 1 });
    let ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver).toMatchObject({ expected_boxes_count: 2, scanned_boxes_count: 1, is_complete: false });
    expect(ver.match.status).toBe('pending');

    // the same box twice is not counted twice
    const dup = await gate.post('/api/verification/scan-box', { data: { match_id: match.id, box_barcode: boxes[0].barcode } });
    const dupBody = await json(dup);
    ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver.scanned_boxes_count, `duplicate scan response: ${JSON.stringify(dupBody).slice(0, 200)}`).toBe(1);

    const last = await ok(await gate.post('/api/verification/scan-box', { data: { match_id: match.id, box_barcode: boxes[1].barcode } }));
    expect(last).toMatchObject({ matched: true, completed: true, remaining: 0 });
    ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver.match.status).toBe('verified');
  });

  test('a verification session appears in the gate list with its AI risk fields', async () => {
    const lot = await buildLockedInvoice();
    const gate = await apiAs('gate');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));
    const list = await ok(await gate.get('/api/verification'));
    const row = (list as any[]).find((r) => r.id === match.id);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ part_number: lot.part.part_number });
    expect(row).toHaveProperty('risk_score');
    expect(row).toHaveProperty('risk_level');
    expect(row).toHaveProperty('review_status');
  });

  test('returning an invoice at the gate is handled and does not 500', async () => {
    const lot = await buildLockedInvoice();
    const gate = await apiAs('gate');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));
    const res = await gate.post('/api/verification/return', { data: { match_id: match.id, invoice_barcode: lot.invoice.barcode } });
    expect(res.status(), await res.text()).toBeLessThan(500);
  });
});
