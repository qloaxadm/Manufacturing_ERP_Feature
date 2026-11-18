import { test, expect, Browser, Page } from '@playwright/test';
import { apiAs, ok, SEED, uid } from '../../helpers/api';
import { signInAs } from '../../helpers/auth';
import { captureDialogs, gotoApp, reactSelect, rowWith, trackBrowserErrors } from '../../helpers/ui';

/**
 * ONE lot, FIVE roles, REAL browser:
 *   ADMIN (stock) -> PACKING/DPR -> BOX/FGS -> INVOICE -> GATE -> ADMIN (reconciliation)
 * Mirrors docs/MANUAL_ONE_PART_E2E_TEST_REPORT.md. Tests share state, so they run serially.
 */
test.describe.configure({ mode: 'serial' });

const tag = uid();
const QTY = 5;
const PART_NUMBER = `E2E-UI-${tag}`;
const INVOICE_NUMBER = `UI-${tag}`; // invoice numbers are limited to 20 chars

const state: { partId?: number; packingBarcode?: string; boxId?: number; boxBarcode?: string; invoiceId?: number; invoiceBarcode?: string; matchId?: number; clearance?: string } = {};

async function asRole(browser: Browser, role: Parameters<typeof signInAs>[1]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signInAs(context, role);
  return context.newPage();
}

test.describe('Five-role workflow through the UI', () => {
  test('0. admin: part exists in Part Master with the starting stock', async ({ browser }) => {
    const admin = await apiAs('admin');
    const part = await ok(
      await admin.post('/api/parts', { data: { part_number: PART_NUMBER, part_desc: 'UI workflow part', qty: 20, supplier_name: 'E2E' } }),
    );
    state.partId = part.id;

    const page = await asRole(browser, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/part_master');
    await page.getByPlaceholder('Search by Part Number or Part Name...').fill(PART_NUMBER);
    const row = rowWith(page, PART_NUMBER);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('UI workflow part');
    await expect(row).toContainText('20');

    await gotoApp(page, '/part_stock');
    await page.getByPlaceholder('Search by Part Number or Part Name...').fill(PART_NUMBER);
    await expect(rowWith(page, PART_NUMBER)).toContainText('20');
    expect(problems).toEqual([]);
    await page.context().close();
  });

  test('1. packing (DPR): stock guard, then create a packing label', async ({ browser }) => {
    const page = await asRole(browser, 'packing');
    const dialogs = captureDialogs(page);
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/create_packing');
    await page.getByPlaceholder('Search by Part Number or Part Name...').fill(PART_NUMBER);
    const row = rowWith(page, PART_NUMBER);
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Pack' }).click();

    // guard: asking for more than the stock disables Submit and explains why
    const modal = page.locator('.modal-dialog');
    await expect(modal.getByText('Remaining Part Stock:')).toBeVisible();
    await modal.getByPlaceholder(/Enter Packing Quantity/).fill('21');
    await expect(modal.getByText(/You don't have enough stock! Available: 20, Requested: 21/)).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Submit' })).toBeDisabled();

    // valid quantity
    await modal.getByPlaceholder(/Enter Packing Quantity/).fill(String(QTY));
    await expect(modal.getByRole('button', { name: 'Submit' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Submit' }).click();

    const card = page.locator('.card', { hasText: 'Barcode Generated Successfully!' });
    await expect(card).toBeVisible();
    const text = await card.innerText();
    const barcode = text.match(/\b(1\d{5})\b/)?.[1];
    expect(barcode, `packing barcode in: ${text.slice(0, 200)}`).toBeTruthy();
    state.packingBarcode = barcode!;
    await expect(card).toContainText(PART_NUMBER);

    // remaining stock dropped 20 -> 15 in the list
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(rowWith(page, PART_NUMBER)).toContainText('15');

    // appears in the Packing Ledger as pending with the right qty
    await gotoApp(page, '/view_packing');
    await page.getByPlaceholder('Search by Barcode, Part Number or Part Name...').fill(barcode!);
    const ledger = rowWith(page, barcode!);
    await expect(ledger).toHaveCount(1);
    await expect(ledger).toContainText(PART_NUMBER);
    await expect(ledger).toContainText(String(QTY));
    await expect(ledger).toContainText(/pending/i);

    expect(dialogs.messages).toEqual([]);
    expect(problems).toEqual([]);
    await page.context().close();
  });

  test('2. box (FGS): create box, empty-lock guard, scan packing, lock', async ({ browser }) => {
    const page = await asRole(browser, 'box');
    const dialogs = captureDialogs(page);
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/create_box');
    await reactSelect(page, 0, PART_NUMBER); // part
    await reactSelect(page, 1, SEED.customerName); // customer
    await page.getByRole('button', { name: 'Submit' }).first().click();

    await expect(page).toHaveURL(/\/add_packing_to_box\/\d+$/);
    state.boxId = Number(page.url().match(/(\d+)$/)![1]);
    await expect(page.getByRole('heading', { name: 'Create Box Packing' })).toBeVisible();

    // guard: an empty box cannot be locked
    await page.locator('#btn-lock-box').click();
    await dialogs.expectMessage('Cannot lock an empty box');
    dialogs.clear();

    // guard: unknown barcode is rejected with the server message
    await page.getByPlaceholder(/Scan \/ Enter Packing Barcode/).fill('999999');
    await page.locator('#btn-add-packing').click();
    await dialogs.expectMessage('not found or already used');
    dialogs.clear();

    // scan the real packing label
    await page.getByPlaceholder(/Scan \/ Enter Packing Barcode/).fill(state.packingBarcode!);
    await page.locator('#btn-add-packing').click();
    await expect(page.locator('tbody tr').filter({ hasText: PART_NUMBER })).toHaveCount(1);
    await expect(page.locator('tbody tr').filter({ hasText: PART_NUMBER })).toContainText(String(QTY));

    // the same label cannot be scanned twice
    await page.getByPlaceholder(/Scan \/ Enter Packing Barcode/).fill(state.packingBarcode!);
    await page.locator('#btn-add-packing').click();
    await dialogs.expectMessage('not found or already used');
    dialogs.clear();

    // lock via the confirmation modal
    await page.locator('#btn-lock-box').click();
    const modal = page.locator('.modal-dialog', { hasText: 'Lock Box' });
    await expect(modal).toContainText('Are You Sure Want To Lock This Box');
    await modal.getByRole('button', { name: 'Save changes' }).click();
    await dialogs.expectMessage('Box Locked Successfully');

    // locked box: scan form is gone, items still visible, qty preserved
    await expect(page.locator('#btn-add-packing')).toHaveCount(0);
    await expect(page.locator('tbody tr').filter({ hasText: PART_NUMBER })).toContainText(String(QTY));

    const admin = await apiAs('admin');
    const box = await ok(await admin.get(`/api/boxes/${state.boxId}`));
    expect(box.box.lock_status).toBe('yes');
    expect(box.total_part_qty).toBe(QTY);
    state.boxBarcode = box.box.barcode;

    // the box shows up in View Box
    await gotoApp(page, '/view_box');
    await page.getByPlaceholder('Search by Barcode, Part Number or Part Name...').fill(PART_NUMBER);
    await expect(rowWith(page, PART_NUMBER)).toContainText(state.boxBarcode!);
    expect(problems).toEqual([]);
    await page.context().close();
  });

  test('3. invoice: create invoice, add box until quantity matches, lock', async ({ browser }) => {
    const page = await asRole(browser, 'invoice');
    const dialogs = captureDialogs(page);
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/create_invoice');

    // guard: empty form
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page).toHaveURL(/create_invoice/);

    await page.getByPlaceholder(/Enter Invoice Number/).fill(INVOICE_NUMBER);
    await reactSelect(page, 0, PART_NUMBER);
    await page.getByPlaceholder(/Enter Invoice Quantity Required/).fill(String(QTY));
    await page.getByRole('button', { name: 'Submit' }).click();
    await dialogs.expectMessage('Invoice Created Successfully');
    dialogs.clear();

    // duplicate invoice number is refused
    await page.getByPlaceholder(/Enter Invoice Number/).fill(INVOICE_NUMBER);
    await reactSelect(page, 0, PART_NUMBER);
    await page.getByPlaceholder(/Enter Invoice Quantity Required/).fill(String(QTY));
    await page.getByRole('button', { name: 'Submit' }).click();
    await dialogs.expectMessage('Invoice Number Already Exists');
    dialogs.clear();

    await gotoApp(page, '/view_invoice');
    await page.getByPlaceholder('Search by Invoice, Part Number or Part Name...').fill(INVOICE_NUMBER);
    const row = rowWith(page, INVOICE_NUMBER);
    await expect(row).toHaveCount(1);
    await row.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/add_box_to_invoice\/\d+$/);
    state.invoiceId = Number(page.url().match(/(\d+)$/)![1]);
    await expect(page.getByRole('heading', { name: 'Add Box To Invoice' })).toBeVisible();

    // scan the sealed box
    await page.getByPlaceholder(/Scan \/ Enter Box Barcode/).fill(state.boxBarcode!);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Status : Invoice Qty Matched')).toBeVisible();

    // lock
    await page.getByRole('button', { name: /Lock Invoice/ }).click();
    const modal = page.locator('.modal-dialog', { hasText: 'Lock Invoice' });
    await expect(modal).toContainText('Are You Sure Want To Lock This Invoice');
    await modal.getByRole('button', { name: 'Save changes' }).click();
    await dialogs.expectMessage('Invoice Locked Successfully');

    const admin = await apiAs('admin');
    const inv = await ok(await admin.get(`/api/invoices/${state.invoiceId}`));
    expect(inv.invoice).toMatchObject({ lock_status: 'yes', qty: QTY });
    expect(inv.total_part_qty).toBe(QTY);
    state.invoiceBarcode = inv.invoice.barcode;
    expect(problems).toEqual([]);
    await page.context().close();
  });

  test('4. gate: verify invoice, scan the physical box, clearance + gate pass', async ({ browser }) => {
    const page = await asRole(browser, 'gate');
    const dialogs = captureDialogs(page);
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/verify_invoice');

    // guard: unknown invoice barcode
    await page.getByPlaceholder(/Scan \/ Enter Invoice Barcode/).fill('399999');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => dialogs.messages.length).toBeGreaterThan(0);
    dialogs.clear();

    await page.getByPlaceholder(/Scan \/ Enter Invoice Barcode/).fill(state.invoiceBarcode!);
    await page.getByRole('button', { name: 'Submit' }).click();
    await dialogs.expectMessage('Added Successfully');
    await expect(page).toHaveURL(/\/add_box_to_invoice_verify\/\d+$/);
    state.matchId = Number(page.url().match(/(\d+)$/)![1]);
    await expect(page.getByRole('heading', { name: 'Add Box To Invoice Verify' })).toBeVisible();
    await expect(page.getByText('Invoice Matched !!!')).toHaveCount(0);
    dialogs.clear();

    // wrong box -> rejected
    await page.getByPlaceholder(/Scan \/ Enter Box Barcode/).fill('000000');
    await page.getByRole('button', { name: 'Submit' }).click();
    await dialogs.expectMessage('not found in this invoice');

    // right box -> matched, clearance code shown
    await page.getByPlaceholder(/Scan \/ Enter Box Barcode/).fill(state.boxBarcode!);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Invoice Matched !!!')).toBeVisible();
    state.clearance = `${INVOICE_NUMBER}4000${state.matchId}`;
    await expect(page.getByText(state.clearance)).toBeVisible();

    // printable gate pass
    await page.getByRole('button', { name: /Print Gate Pass/ }).click();
    const pass = page.locator('.modal-dialog, [role="dialog"], .modal-backdrop').filter({ hasText: state.clearance }).first();
    await expect(pass).toBeVisible();
    await expect(pass).toContainText(INVOICE_NUMBER);
    await page.keyboard.press('Escape');

    // gate out report lists the dispatch
    await gotoApp(page, '/gate_out_report');
    await page.getByPlaceholder(/Search by Invoice, Part Number, Part Name or Gate Out Code/).fill(INVOICE_NUMBER);
    const row = rowWith(page, INVOICE_NUMBER);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(state.clearance);
    await expect(row).toContainText(PART_NUMBER);
    await expect(row).toContainText(String(QTY));
    expect(problems).toEqual([]);
    await page.context().close();
  });

  test('5. admin: reconciliation - stock, gate risk, audit trail and dashboard', async ({ browser }) => {
    const page = await asRole(browser, 'admin');
    const problems = trackBrowserErrors(page);

    // stock ledger: 20 raw - 5 packed = 15 remaining
    await gotoApp(page, '/part_stock');
    await page.getByPlaceholder('Search by Part Number or Part Name...').fill(PART_NUMBER);
    await expect(rowWith(page, PART_NUMBER)).toContainText('15');

    // AI gate risk analysed this dispatch and explains it
    await gotoApp(page, '/ai_gate_risk');
    await page.getByPlaceholder('Search Invoice, Customer, Part...').fill(state.invoiceBarcode!);
    const risk = rowWith(page, state.invoiceBarcode!);
    await expect(risk).toHaveCount(1);
    await expect(risk).toContainText(PART_NUMBER);
    await expect(risk).toContainText(/LOW|MEDIUM|HIGH/);

    // audit trail recorded the part creation
    await gotoApp(page, '/activity_history');
    await page.getByPlaceholder(/Search by action title/).fill(PART_NUMBER);
    await expect(rowWith(page, PART_NUMBER).first()).toBeVisible();

    // API cross-check of the final state of the whole chain
    const admin = await apiAs('admin');
    const ver = await ok(await admin.get(`/api/verification/${state.matchId}`));
    expect(ver.match.status).toBe('verified');
    expect(ver.clearance_code).toBe(state.clearance);
    const box = await ok(await admin.get(`/api/boxes/${state.boxId}`));
    expect(box.box.lock_status).toBe('yes');
    expect(problems).toEqual([]);
    await page.context().close();
  });
});
