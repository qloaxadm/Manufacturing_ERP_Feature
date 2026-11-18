import { test, expect, Page } from '@playwright/test';
import { apiAs, ok, uid } from '../../helpers/api';
import { signInAs } from '../../helpers/auth';
import { gotoApp, rowWith, trackBrowserErrors } from '../../helpers/ui';

async function seedNotification(priority: 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL', tag = uid()) {
  const admin = await apiAs('admin');
  await ok(
    await admin.post('/api/notifications/system-event', {
      data: { reason: `reason ${tag}`, module: 'E2E', title: `E2E alert ${tag}`, message: `message ${tag}`, priority },
    }),
  );
  return tag;
}

const searchBox = (page: Page) => page.getByPlaceholder('Search by invoice, customer, or title...');

test.describe('Notification & Alert Center', () => {
  test('a new alert is listed with its title, reason and priority, and can be searched', async ({ page }) => {
    const tag = await seedNotification('HIGH');
    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/notifications');
    await expect(page.getByRole('heading', { name: 'Notification & Alert Center' })).toBeVisible();
    await expect(page.getByText('ADMIN RBAC SCOPE')).toBeVisible();

    await searchBox(page).fill(tag);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`E2E alert ${tag}`).first()).toBeVisible();
    await expect(page.getByText(new RegExp(`reason ${tag}`)).first()).toBeVisible(); // explainability: why
    await expect(page.getByRole('button', { name: 'Mark Read' }).first()).toBeVisible();

    await searchBox(page).fill(`no-such-alert-${uid()}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`E2E alert ${tag}`)).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('priority tabs filter the list', async ({ page }) => {
    const warn = await seedNotification('WARNING');
    const info = await seedNotification('INFO');
    await signInAs(page, 'admin');
    await gotoApp(page, '/notifications');
    await page.getByRole('button', { name: 'WARNING', exact: true }).click();
    await expect(page.getByText(`E2E alert ${warn}`).first()).toBeVisible();
    await expect(page.getByText(`E2E alert ${info}`)).toHaveCount(0);
    await page.getByRole('button', { name: 'INFO', exact: true }).click();
    await expect(page.getByText(`E2E alert ${info}`).first()).toBeVisible();
    await expect(page.getByText(`E2E alert ${warn}`)).toHaveCount(0);
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
    await expect(page.getByText(`E2E alert ${warn}`).first()).toBeVisible();
  });

  test('Mark Read lowers the unread count; Mark All Read clears it', async ({ page }) => {
    await seedNotification('HIGH');
    await seedNotification('WARNING');
    await signInAs(page, 'admin');
    const admin = await apiAs('admin');
    const unread = async () => (await ok(await admin.get('/api/notifications/unread-count'))).unread_count as number;

    await gotoApp(page, '/notifications');
    const before = await unread();
    expect(before).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Mark Read' }).first().click();
    await expect.poll(unread).toBe(before - 1);

    await page.getByRole('button', { name: 'Mark All Read' }).click();
    await expect.poll(unread).toBe(0);
    await expect(page.getByRole('button', { name: 'Mark Read' })).toHaveCount(0);
  });

  test('the header bell opens a popover with the latest alerts', async ({ page }) => {
    const tag = await seedNotification('CRITICAL');
    await signInAs(page, 'admin');
    await gotoApp(page, '/index');
    await page.getByRole('button', { name: 'Notification Center' }).click();
    await expect(page.getByText(`E2E alert ${tag}`).first()).toBeVisible();
  });

  test('operators never see admin-only alerts (role scoping in the UI)', async ({ page }) => {
    const tag = await seedNotification('HIGH');
    await signInAs(page, 'packing');
    await gotoApp(page, '/notifications');
    await searchBox(page).fill(tag);
    await expect(page.getByText(`E2E alert ${tag}`)).toHaveCount(0);
  });

  test('a stock-depleted alert reaches the packing operator with its reason', async ({ page }) => {
    const admin = await apiAs('admin');
    const number = `E2E-NT-${uid()}`;
    const part = await ok(await admin.post('/api/parts', { data: { part_number: number, part_desc: 'n', qty: 3, supplier_name: 's' } }));
    await ok(await admin.post(`/api/parts/${part.id}/mark-finished`, { data: { reason: 'closed by e2e' } }));
    await signInAs(page, 'packing');
    await gotoApp(page, '/notifications');
    await searchBox(page).fill(number);
    await expect(page.getByText(new RegExp(`Part "${number}" Stock Finished`)).first()).toBeVisible();
    await expect(page.getByText(/closed by e2e/).first()).toBeVisible();
  });
});

test.describe('Activity History & Audit Trail', () => {
  test('part actions are listed with type, section, operator and timestamp, and are searchable', async ({ page }) => {
    const packing = await apiAs('packing');
    const number = `E2E-AH-${uid()}`;
    await ok(await packing.post('/api/parts', { data: { part_number: number, part_desc: 'audit', qty: 5, supplier_name: 's' } }));

    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/activity_history');
    for (const col of ['Type', 'Action & Section', 'Identifier', 'Activity Description', 'Operator', 'Timestamp', 'Inspect']) {
      await expect(page.locator('th', { hasText: col })).toBeVisible();
    }
    await page.getByPlaceholder(/Search by action title/).fill(number);
    const row = rowWith(page, number).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Part Created');
    await expect(row).toContainText('Part Master');
    await expect(row).toContainText('DPR'); // the operator who did it

    // inspect opens the evidence for that row
    await row.getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('heading', { name: /Audit Activity Record #\d+/ })).toBeVisible();
    await page.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(page.getByText(new RegExp(`"part_number":\\s*"${number}"`))).toBeVisible(); // metadata evidence
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: /Audit Activity Record/ })).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('the audit trail is read-only in the UI (no edit / delete controls)', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/activity_history');
    await expect(page.getByRole('button', { name: /^(Edit|Delete|Remove)$/ })).toHaveCount(0);
  });

  test('an operator only sees activity of their own role', async ({ page }) => {
    // an admin action must be invisible to the gate officer
    const admin = await apiAs('admin');
    const adminOnly = `E2E-AH-ADM-${uid()}`;
    await ok(await admin.post('/api/parts', { data: { part_number: adminOnly, part_desc: 'a', qty: 1, supplier_name: 's' } }));

    await signInAs(page, 'gate');
    await gotoApp(page, '/activity_history');
    await page.getByPlaceholder(/Search by action title/).fill(adminOnly);
    await expect(rowWith(page, adminOnly)).toHaveCount(0);
  });

  test('Export to Excel downloads a file', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/activity_history');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export to Excel' }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
  });
});
