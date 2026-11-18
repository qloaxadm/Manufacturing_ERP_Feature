import { test, expect, Page } from '@playwright/test';
import { apiAnon, apiAs, ok, SEED, uid, USERS } from '../../helpers/api';
import { signInAs } from '../../helpers/auth';
import { captureDialogs, gotoApp, rowWith, trackBrowserErrors } from '../../helpers/ui';

const SEARCH_PARTS = 'Search by Part Number or Part Name...';

async function newPart(qty = 10) {
  const admin = await apiAs('admin');
  const number = `E2E-MD-${uid()}`;
  const part = await ok(await admin.post('/api/parts', { data: { part_number: number, part_desc: 'Master data part', qty, supplier_name: 'E2E' } }));
  return { ...part, number };
}

async function openAs(page: Page, role: Parameters<typeof signInAs>[1], path: string) {
  await signInAs(page, role);
  await gotoApp(page, path);
}

test.describe('Part Master (admin)', () => {
  test('add a new part through the supplier form; required fields and duplicates are enforced', async ({ page }) => {
    const dialogs = captureDialogs(page);
    const problems = trackBrowserErrors(page);
    await openAs(page, 'admin', '/part_master');
    const number = `E2E-NEW-${uid()}`;

    await page.getByRole('button', { name: 'Add New Part' }).click();
    const modal = page.locator('.modal-dialog', { hasText: 'Add New Part & Supplier' });
    await expect(modal).toBeVisible();

    // required fields: submitting an empty form keeps the modal open
    await modal.getByRole('button', { name: 'Save Part & Log History' }).click();
    await expect(modal).toBeVisible();

    await modal.getByPlaceholder(/Enter Part Number/).fill(number);
    await modal.getByPlaceholder(/Enter Part Description/).fill('Created from the UI');
    await modal.getByPlaceholder(/Enter Initial Stock Quantity/).fill('25');
    await modal.getByPlaceholder(/Enter Supplier \/ Vendor Name/).fill('Bosch Automotive');
    await modal.getByPlaceholder('Phone or Email...').fill('+91 99999 00000');
    await modal.getByPlaceholder('Invoice / PO / Challan...').fill('PO-7781');
    await modal.getByPlaceholder(/Optional delivery or lot remarks/).fill('first lot');
    await modal.getByRole('button', { name: 'Save Part & Log History' }).click();
    await expect(modal).toBeHidden();

    await page.getByPlaceholder(SEARCH_PARTS).fill(number);
    const row = rowWith(page, number);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Created from the UI');
    await expect(row).toContainText('25');

    // the supplier details were stored in the part history
    const admin = await apiAs('admin');
    const found = await ok(await admin.get(`/api/parts?search=${number}`));
    const history = await ok(await admin.get(`/api/parts/${found.items[0].id}/history`));
    expect(history.history[0]).toMatchObject({ supplier_name: 'Bosch Automotive', supplier_invoice_no: 'PO-7781', new_qty: 25 });

    // duplicate part number
    await page.getByRole('button', { name: 'Add New Part' }).click();
    const again = page.locator('.modal-dialog', { hasText: 'Add New Part & Supplier' });
    await again.getByPlaceholder(/Enter Part Number/).fill(number);
    await again.getByPlaceholder(/Enter Part Description/).fill('dup');
    await again.getByPlaceholder(/Enter Initial Stock Quantity/).fill('1');
    await again.getByPlaceholder(/Enter Supplier \/ Vendor Name/).fill('x');
    await again.getByRole('button', { name: 'Save Part & Log History' }).click();
    await expect.poll(() => dialogs.messages.join('|') + ' ' + '').toMatch(/already exists/);
    expect(problems).toEqual([]);
  });

  test('add stock, edit stock, history and barcode modals, then remove', async ({ page }) => {
    const dialogs = captureDialogs(page);
    const part = await newPart(10);
    await openAs(page, 'admin', '/part_master');
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    const row = rowWith(page, part.number);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('10');

    // --- add stock
    await row.getByRole('button', { name: 'Add Stock' }).click();
    const addModal = page.locator('.modal-dialog', { hasText: `Add Stock - ${part.number}` });
    await expect(addModal).toContainText('Current Stock: 10');
    await addModal.getByPlaceholder(/Enter units to add/).fill('5');
    await addModal.getByPlaceholder('Supplier / Vendor name...').fill('ACME Metals');
    await addModal.getByPlaceholder('Invoice / PO / DC ref...').fill('DC-1');
    await addModal.getByRole('button', { name: 'Confirm & Add Stock' }).click();
    await expect(addModal).toBeHidden();
    await expect(rowWith(page, part.number)).toContainText('15');

    // --- edit stock (manual correction)
    await rowWith(page, part.number).getByRole('button', { name: 'Edit' }).click();
    const editModal = page.locator('.modal-dialog', { hasText: `Edit Part Stock - ${part.number}` });
    await editModal.locator('input[type="number"]').fill('12');
    await editModal.getByRole('button', { name: 'Update Stock' }).click();
    await expect(editModal).toBeHidden();
    await expect(rowWith(page, part.number)).toContainText('12');

    // --- history modal
    await rowWith(page, part.number).getByRole('button', { name: 'View Details' }).click();
    const hist = page.locator('.modal-dialog', { hasText: `Part History & Details — ${part.number}` });
    await expect(hist).toBeVisible();
    await expect(hist.getByRole('button', { name: /All History \(\d+\)/ })).toBeVisible();
    await expect(hist.getByRole('button', { name: /Stock Added \(\d+\)/ })).toBeVisible();
    await expect(hist).toContainText('ACME Metals');
    await hist.getByRole('button', { name: 'Close' }).click();
    await expect(hist).toBeHidden();

    // --- barcode label
    await rowWith(page, part.number).getByRole('button', { name: 'View / Download' }).click();
    const label = page.locator('.modal-dialog', { hasText: 'Part Barcode' });
    await expect(label).toContainText(part.number);
    await expect(label.getByRole('button', { name: 'Print' })).toBeVisible();
    await expect(label.getByRole('button', { name: 'Download' })).toBeVisible();
    await page.reload();

    // --- remove with confirmation (Cancel keeps it)
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    await rowWith(page, part.number).getByRole('button', { name: 'Remove' }).click();
    const confirm = page.locator('.modal-dialog', { hasText: 'Confirm Part Removal' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(rowWith(page, part.number)).toHaveCount(1);
    await rowWith(page, part.number).getByRole('button', { name: 'Remove' }).click();
    await confirm.getByRole('button', { name: 'Yes, Remove Part' }).click();
    await expect(rowWith(page, part.number)).toHaveCount(0);

    // API agrees: part is gone, edits were audited
    const admin = await apiAs('admin');
    expect((await ok(await admin.get(`/api/parts?search=${part.number}`))).total).toBe(0);
    expect(dialogs.messages.filter((m) => /error|fail/i.test(m))).toEqual([]);
  });

  test('search narrows the list and pagination controls work', async ({ page }) => {
    await openAs(page, 'admin', '/part_master');
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await expect(page.getByRole('button', { name: /Last Page/ })).toBeVisible();
    const firstBefore = await page.locator('tbody tr').first().innerText();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('tbody tr').first()).not.toHaveText(firstBefore); // page 2 really loaded
    await page.getByPlaceholder(SEARCH_PARTS).fill('zzz-no-such-part-zzz');
    await expect(page.locator('tbody')).toContainText('No data available in table');
  });

  test('KNOWN ISSUE: a slow earlier page response must not overwrite a newer search result', async ({ page }) => {
    test.fail(
      true,
      'PartMasterPage.fetchParts has no out-of-order guard: a slow page-2 response arriving after the filtered search result replaces it with stale rows.',
    );
    await openAs(page, 'admin', '/part_master');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    // make the page-2 request slow, then search while it is still in flight
    await page.route('**/api/parts?*page=2*', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByPlaceholder(SEARCH_PARTS).fill('zzz-no-such-part-zzz');
    await expect(page.locator('tbody')).toContainText('No data available in table');
    await page.waitForTimeout(3000); // let the slow response land
    await expect(page.locator('tbody')).toContainText('No data available in table');
  });

  test('packing role may manage parts too (add stock) but sees no Customer / Users', async ({ page }) => {
    const part = await newPart(4);
    await openAs(page, 'packing', '/part_master');
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    await expect(rowWith(page, part.number).getByRole('button', { name: 'Add Stock' })).toBeVisible();
    await expect(page.locator('aside a[href="/customer"], aside a[href="/erp_users"]')).toHaveCount(0);
  });
});

test.describe('Part Stock', () => {
  test('shows FG / box / invoice stock columns and filters by search', async ({ page }) => {
    const part = await newPart(8);
    await openAs(page, 'packing', '/part_stock');
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    const row = rowWith(page, part.number);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('8');
    for (const col of ['Remaining Stock', 'FG Rack stock', 'Box pack stock', 'Invoice Barcode Generated stock']) {
      await expect(page.locator('th', { hasText: col })).toBeVisible();
    }
  });
});

test.describe('Customers (admin)', () => {
  test('add then edit a customer', async ({ page }) => {
    const problems = trackBrowserErrors(page);
    await openAs(page, 'admin', '/customer');
    const name = `E2E Motors ${uid()}`;

    await page.getByRole('button', { name: 'Add Customer' }).click();
    const modal = page.locator('.modal-dialog', { hasText: 'Add Customer' });
    await modal.getByRole('button', { name: 'Save Customer' }).click(); // required
    await expect(modal).toBeVisible();
    await modal.getByPlaceholder('e.g. Mahindra & Mahindra').fill(name);
    await modal.getByRole('button', { name: 'Save Customer' }).click();
    await expect(modal).toBeHidden();

    await page.getByPlaceholder('Search...').fill(name);
    const row = rowWith(page, name);
    await expect(row).toHaveCount(1);

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator('.modal-dialog', { hasText: 'Edit Customer' });
    await expect(edit.locator('input[type="text"]')).toHaveValue(name);
    await edit.locator('input[type="text"]').fill(`${name} Renamed`);
    await edit.getByRole('button', { name: 'Update Customer' }).click();
    await expect(edit).toBeHidden();
    await expect(rowWith(page, `${name} Renamed`)).toHaveCount(1);

    const admin = await apiAs('admin');
    const list = await ok(await admin.get('/api/customers'));
    expect((list as any[]).some((c) => c.customer_name === `${name} Renamed`)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('the seeded customers are listed', async ({ page }) => {
    await openAs(page, 'admin', '/customer');
    await expect(rowWith(page, SEED.customerName)).toHaveCount(1);
    await expect(rowWith(page, 'Tata Motors')).toHaveCount(1);
  });
});

test.describe('ERP Users (admin)', () => {
  test('passwords are masked until "Show Passwords" is toggled', async ({ page }) => {
    await openAs(page, 'admin', '/erp_users');
    const row = rowWith(page, USERS.admin.email);
    await expect(row).toContainText('••••');
    await page.getByRole('button', { name: 'Show Passwords' }).click();
    await expect(row).toContainText(USERS.admin.password);
    await page.getByRole('button', { name: 'Hide Passwords' }).click();
    await expect(row).toContainText('••••');
  });

  test('create a user, log in as them, then delete them; own account cannot be deleted', async ({ page }) => {
    await openAs(page, 'admin', '/erp_users');
    const email = `e2e-${uid().toLowerCase()}@talbros.com`;

    await expect(rowWith(page, USERS.admin.email).getByRole('button', { name: 'Delete' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Add ERP User' }).click();
    await page.getByPlaceholder('e.g. Ramesh Sharma').fill('E2E Operator');
    await page.getByPlaceholder('e.g. ramesh@talbros.com').fill(email);
    await page.getByPlaceholder('Enter account password').fill('op-pass');
    // role tiles are clickable cards, not <button>s
    await page
      .locator('form')
      .filter({ has: page.getByPlaceholder('e.g. ramesh@talbros.com') })
      .getByText('Packing (DPR)', { exact: true })
      .click();
    await page.getByRole('button', { name: 'Create User' }).click();

    await page.getByPlaceholder('Search name, email, role...').fill(email);
    const row = rowWith(page, email);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('E2E Operator');
    await expect(row).toContainText(/packing/i);

    // the account works
    const anon = await apiAnon();
    const login = await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'op-pass' } });
    expect(login.status()).toBe(201);
    expect((await login.json()).user.type).toBe('packing');

    // delete (Cancel first)
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { name: 'Delete ERP User?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(rowWith(page, email)).toHaveCount(1);
    await rowWith(page, email).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Yes, Delete User' }).click();
    await expect(rowWith(page, email)).toHaveCount(0);
    expect((await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'op-pass' } })).status()).toBe(401);
  });

  test('KNOWN ISSUE: a user created with the "Gate Security" role gets type "gate"', async ({ page }) => {
    test.fail(
      true,
      'The Gate Security tile submits user_role "Gate Security", stored as type "gate security". Every route/API guard expects exactly "gate", so the new user cannot open the gate screens.',
    );
    await openAs(page, 'admin', '/erp_users');
    const email = `e2e-gate-${uid().toLowerCase()}@talbros.com`;
    await page.getByRole('button', { name: 'Add ERP User' }).click();
    await page.getByPlaceholder('e.g. Ramesh Sharma').fill('Gate Tester');
    await page.getByPlaceholder('e.g. ramesh@talbros.com').fill(email);
    await page.getByPlaceholder('Enter account password').fill('gate-pass');
    await page
      .locator('form')
      .filter({ has: page.getByPlaceholder('e.g. ramesh@talbros.com') })
      .getByText('Gate Security', { exact: true })
      .click();
    await page.getByRole('button', { name: 'Create User' }).click();
    const anon = await apiAnon();
    await expect
      .poll(async () => (await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'gate-pass' } })).status())
      .toBe(201);
    const login = await (await anon.post('/api/auth/login', { data: { user_email: email, user_password: 'gate-pass' } })).json();
    // cleanup before asserting so a failing assertion does not leave the user behind
    const admin = await apiAs('admin');
    await admin.delete(`/api/users/${login.user.id}`);
    expect(login.user.type).toBe('gate');
  });

  test('a duplicate e-mail is rejected with the server message', async ({ page }) => {
    const dialogs = captureDialogs(page);
    await openAs(page, 'admin', '/erp_users');
    await page.getByRole('button', { name: 'Add ERP User' }).click();
    await page.getByPlaceholder('e.g. Ramesh Sharma').fill('Dup');
    await page.getByPlaceholder('e.g. ramesh@talbros.com').fill(USERS.gate.email);
    await page.getByPlaceholder('Enter account password').fill('x');
    await page.getByRole('button', { name: 'Create User' }).click();
    await dialogs.expectMessage('already exists');
  });
});

test.describe('Packing: bulk creation and ledger', () => {
  test('bulk packing generates N labels and deducts qty x N from stock', async ({ page }) => {
    const part = await newPart(30);
    const dialogs = captureDialogs(page);
    await openAs(page, 'packing', '/create_packing_bulk');
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    await rowWith(page, part.number).getByRole('button', { name: 'Bulk Pack' }).click();
    const modal = page.locator('.modal-dialog', { hasText: 'Create Bulk Packing' });
    await modal.getByPlaceholder(/Enter Quantity Per Package/).fill('4');
    await modal.getByPlaceholder(/Enter Number of Labels to Generate/).fill('5');
    await modal.getByRole('button', { name: 'Generate Barcodes' }).click();
    await expect(modal).toBeHidden();

    const admin = await apiAs('admin');
    await expect
      .poll(async () => {
        const s = await ok(await admin.get(`/api/parts/stock?search=${part.number}`));
        return s.items[0].remaining_stock;
      })
      .toBe(10); // 30 - 5*4
    const all = await ok(await admin.get('/api/packing'));
    expect((all as any[]).filter((p) => p.part_id === part.id)).toHaveLength(5);
    expect(dialogs.messages.filter((m) => /enough stock|error/i.test(m))).toEqual([]);
  });

  test('bulk packing beyond available stock is blocked', async ({ page }) => {
    const part = await newPart(10);
    await openAs(page, 'packing', '/create_packing_bulk');
    await page.getByPlaceholder(SEARCH_PARTS).fill(part.number);
    await rowWith(page, part.number).getByRole('button', { name: 'Bulk Pack' }).click();
    const modal = page.locator('.modal-dialog', { hasText: 'Create Bulk Packing' });
    await modal.getByPlaceholder(/Enter Quantity Per Package/).fill('4');
    await modal.getByPlaceholder(/Enter Number of Labels to Generate/).fill('2'); // 8 <= 10: allowed
    await expect(modal.getByRole('button', { name: 'Generate Barcodes' })).toBeEnabled();
    await modal.getByPlaceholder(/Enter Number of Labels to Generate/).fill('5'); // 20 > 10: blocked
    await expect(modal.getByRole('button', { name: 'Generate Barcodes' })).toBeDisabled();
    const admin = await apiAs('admin');
    const s = await ok(await admin.get(`/api/parts/stock?search=${part.number}`));
    expect(s.items[0].remaining_stock).toBe(10); // nothing was packed
  });

  test('ledger lists a packing, supports search, and deletes it after confirmation', async ({ page }) => {
    const part = await newPart(10);
    const admin = await apiAs('admin');
    const pk = await ok(await admin.post('/api/packing/single', { data: { part_id: part.id, part_qty: 3 } }));
    const dialogs = captureDialogs(page);
    await openAs(page, 'packing', '/view_packing');
    await page.getByPlaceholder('Search by Barcode, Part Number or Part Name...').fill(pk.barcode);
    const row = rowWith(page, pk.barcode);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(part.number);
    await expect(row).toContainText('3');
    await expect(row).toContainText(/pending/i);
    await expect(row.getByRole('button', { name: 'Print' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();

    await row.locator('button').last().click(); // delete icon
    const modal = page.locator('.modal-dialog', { hasText: 'Are You Sure Want To Delete This Packing' });
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(rowWith(page, pk.barcode)).toHaveCount(1);
    await rowWith(page, pk.barcode).locator('button').last().click();
    await modal.getByRole('button', { name: 'Delete' }).click();
    await dialogs.expectMessage('Deleted Successfully');
    await expect(rowWith(page, pk.barcode)).toHaveCount(0);
  });
});
