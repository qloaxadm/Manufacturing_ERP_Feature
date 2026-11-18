import { test, expect } from '@playwright/test';
import { apiAnon, apiAs, createTempUser, ok, removeUser, ROLES, USERS } from '../../helpers/api';
import { signInAs, signInAsUser } from '../../helpers/auth';
import { captureDialogs, gotoApp, trackBrowserErrors } from '../../helpers/ui';

test.describe('My Profile', () => {
  for (const role of ROLES) {
    test(`${role}: shows their own identity, department and employee id`, async ({ page }) => {
      await signInAs(page, role);
      const problems = trackBrowserErrors(page);
      await gotoApp(page, '/profile');
      await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();
      await expect(page.getByText(USERS[role].email).first()).toBeVisible();
      await expect(page.getByText(/EMP-\d+/)).toBeVisible();
      await expect(page.getByText('Personal & Employee Information')).toBeVisible();
      const departments = {
        admin: 'Executive & Management',
        packing: 'Finished Goods Packing Line',
        box: 'Master Carton Dispatch Packaging',
        invoice: 'Commercial Invoicing & Logistics',
        gate: 'Security & Outward Gate Control',
      } as const;
      await expect(page.getByText(departments[role]).first()).toBeVisible();
      expect(problems).toEqual([]);
    });
  }

  test('edit profile: the name is saved, the e-mail is read-only', async ({ page }) => {
    const user = await createTempUser('box');
    try {
      await signInAsUser(page, user);
      await gotoApp(page, '/profile');
      await page.getByRole('button', { name: 'Edit Profile' }).click();
      const modal = page.locator('.modal-dialog, [role="dialog"]').filter({ hasText: 'Edit Profile Details' });
      await expect(modal).toBeVisible();
      await expect(modal.locator('input[type="email"]')).toHaveValue(user.email);
      await expect(modal.locator('input[type="email"]')).toBeDisabled();
      await modal.locator('input[type="text"]').first().fill('Renamed By E2E');
      await modal.getByRole('button', { name: 'Save Profile Changes' }).click();
      await expect(page.getByText('Profile information updated successfully!')).toBeVisible();

      const admin = await apiAs('admin');
      const users = await ok(await admin.get('/api/users'));
      expect((users as any[]).find((u) => u.id === user.id).user_name).toBe('Renamed By E2E');
    } finally {
      await removeUser(user.id);
    }
  });

  test('change password: mismatch and too-short are blocked client-side, a valid change works', async ({ page }) => {
    const user = await createTempUser('invoice');
    try {
      await signInAsUser(page, user);
      await gotoApp(page, '/profile');
      const open = async () => {
        await page.getByRole('button', { name: 'Change Password' }).click();
        return page.locator('.modal-dialog, [role="dialog"]').filter({ hasText: 'Confirm New Password' });
      };
      let modal = await open();
      const [cur, next, confirm] = [
        modal.getByPlaceholder('Enter current password'),
        modal.getByPlaceholder('Minimum 3 characters'),
        modal.getByPlaceholder('Re-type new password'),
      ];

      await cur.fill(user.password);
      await next.fill('abcdef');
      await confirm.fill('different');
      await modal.getByRole('button', { name: 'Update Password' }).click();
      await expect(modal.getByText('New password and confirmation do not match')).toBeVisible();

      await next.fill('ab');
      await confirm.fill('ab');
      await modal.getByRole('button', { name: 'Update Password' }).click();
      await expect(modal.getByText('New password must be at least 3 characters long')).toBeVisible();

      await cur.fill(user.password);
      await next.fill('abcdef');
      await confirm.fill('abcdef');
      await modal.getByRole('button', { name: 'Update Password' }).click();
      await expect(page.getByText(/Password changed successfully/)).toBeVisible();

      const anon = await apiAnon();
      expect((await anon.post('/api/auth/login', { data: { user_email: user.email, user_password: user.password } })).status()).toBe(401);
      expect((await anon.post('/api/auth/login', { data: { user_email: user.email, user_password: 'abcdef' } })).status()).toBe(201);
    } finally {
      await removeUser(user.id);
    }
  });
});

test.describe('Settings & Preferences', () => {
  test('admin sees every configuration section; operators only their own', async ({ browser }) => {
    const sections: Record<string, string[]> = {
      admin: ['My Preferences', 'Scanner Settings', 'Packing Preferences', 'Box Preferences', 'Invoice Preferences', 'Gate Verification', 'Company Master Profile', 'Barcode Numbering & Sequences', 'System Health & Diagnostics'],
      packing: ['My Preferences', 'Scanner Settings', 'Packing Preferences'],
      box: ['My Preferences', 'Scanner Settings', 'Box Preferences'],
      invoice: ['My Preferences', 'Invoice Preferences'],
      gate: ['My Preferences', 'Scanner Settings', 'Gate Verification'],
    };
    for (const role of ROLES) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInAs(page, role);
      await gotoApp(page, '/settings');
      await expect(page.getByRole('heading', { name: 'Settings & Preferences' })).toBeVisible();
      await expect(page.getByText(new RegExp(`Active Role: ${role}`, 'i'))).toBeVisible();
      // sections shown in the left rail
      const rail = await page.locator('main button').allInnerTexts();
      for (const s of sections[role]) expect(rail.join('|'), `${role} should see ${s}`).toContain(s);
      if (role !== 'admin') {
        expect(rail.join('|'), `${role} must not see System Health`).not.toContain('System Health & Diagnostics');
        expect(rail.join('|'), `${role} must not see Company Master`).not.toContain('Company Master Profile');
      }
      await context.close();
    }
  });

  test('theme and font size are applied to the document and survive a reload', async ({ page }) => {
    await signInAs(page, 'gate');
    await gotoApp(page, '/settings');
    await page.getByRole('button', { name: /Dark Mode/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: /18px/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-font-size', /xl|extra/i);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-font-size', /xl|extra/i);

    await page.getByRole('button', { name: /Light Mode/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: /14px/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'normal');
  });

  test('switching the language translates the interface', async ({ page }) => {
    await signInAs(page, 'gate');
    await gotoApp(page, '/settings');
    await page.getByRole('button', { name: /हिंदी/ }).click();
    await expect(page.locator('aside, nav').getByText('डैशबोर्ड').first()).toBeVisible();
    await page.getByRole('button', { name: /मराठी/ }).click();
    await expect(page.locator('aside, nav').getByText('डॅशबोर्ड').first()).toBeVisible();
    await page.getByRole('button', { name: /English/ }).click();
    await expect(page.locator('aside, nav').getByText('Dashboard').first()).toBeVisible();
  });

  test('the System Health tab renders for admin', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/settings');
    await page.getByRole('button', { name: 'System Health & Diagnostics' }).click();
    await expect(page.getByText('DATABASE ENGINE')).toBeVisible();
    await expect(page.getByText('SYSTEM UPTIME')).toBeVisible();
  });
});

/**
 * KNOWN UI ISSUES - assert the behaviour the product SHOULD have; marked test.fail() so the
 * suite stays green until the bug is fixed (then Playwright flags "expected to fail but passed").
 */
test.describe('Known UI issues (expected failures)', () => {
  test('"Save Settings" reaches the API and confirms without an error alert', async ({ page }) => {
    test.fail(
      true,
      'SettingsPage uses raw axios with relative /api/settings instead of the shared api client, so with VITE_API_URL set (production) the call goes to the frontend host (Vercel rewrites it to index.html) and never reaches the backend. Also calls a non-existent /api/settings/health.',
    );
    const dialogs = captureDialogs(page);
    await signInAs(page, 'admin');
    await gotoApp(page, '/settings');
    await page.getByRole('button', { name: 'Packing Preferences' }).click();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByText('Settings saved successfully!')).toBeVisible({ timeout: 5000 });
    expect(dialogs.messages.filter((m) => /fail/i.test(m))).toEqual([]);
  });

  test('a wrong current password shows an error and keeps the user signed in', async ({ page }) => {
    test.fail(
      true,
      'api/client.ts treats EVERY 401 as an expired session, so a wrong current password logs the user out instead of showing "Current password does not match".',
    );
    const user = await createTempUser('invoice');
    try {
      await signInAsUser(page, user);
      await gotoApp(page, '/profile');
      await page.getByRole('button', { name: 'Change Password' }).click();
      const modal = page.locator('.modal-dialog, [role="dialog"]').filter({ hasText: 'Confirm New Password' });
      await modal.getByPlaceholder('Enter current password').fill('wrong-current');
      await modal.getByPlaceholder('Minimum 3 characters').fill('abcdef');
      await modal.getByPlaceholder('Re-type new password').fill('abcdef');
      await modal.getByRole('button', { name: 'Update Password' }).click();
      await expect(modal.getByText(/Current password does not match/i)).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveURL(/\/profile$/);
    } finally {
      await removeUser(user.id);
    }
  });

  test('the Settings page shows the company profile stored on the server', async ({ page }) => {
    test.fail(
      true,
      'SettingsPage bypasses the shared api client (raw axios, relative URL) and also expects GET /api/settings to return {success, settings} while the API returns the object directly - so it always shows hard-coded defaults.',
    );
    const admin = await apiAs('admin');
    const before = (await ok(await admin.get('/api/settings'))).company.companyName;
    await ok(await admin.put('/api/settings', { data: { company: { companyName: 'Talbros E2E Plant' } } }));
    try {
      await signInAs(page, 'admin');
      await gotoApp(page, '/settings');
      await page.getByRole('button', { name: 'Company Master Profile' }).click();
      await expect(page.locator('main input[type="text"]').first()).toHaveValue('Talbros E2E Plant', { timeout: 5000 });
    } finally {
      await admin.put('/api/settings', { data: { company: { companyName: before } } });
    }
  });

  test('"Save Settings" persists the company profile on the server', async ({ page }) => {
    test.fail(
      true,
      'Besides the unreachable URL, the page PUTs a flat object (companyName, ...) while the API only merges nested sections ({company: {...}}), so nothing would be stored even when reachable.',
    );
    const admin = await apiAs('admin');
    const before = (await ok(await admin.get('/api/settings'))).company.companyName;
    try {
      await signInAs(page, 'admin');
      await gotoApp(page, '/settings');
      await page.getByRole('button', { name: 'Company Master Profile' }).click();
      await page.locator('main input[type="text"]').first().fill('Saved From UI');
      await page.getByRole('button', { name: 'Save Settings' }).click();
      await expect(page.getByText('Settings saved successfully!')).toBeVisible();
      expect((await ok(await admin.get('/api/settings'))).company.companyName).toBe('Saved From UI');
    } finally {
      await admin.put('/api/settings', { data: { company: { companyName: before } } });
    }
  });
});
