import { test, expect } from '@playwright/test';
import { Role, ROLES } from '../../helpers/api';
import { signInAs } from '../../helpers/auth';

const COMMON = ['/index', '/dashboard', '/profile', '/settings', '/notifications', '/activity_history'];

/** Mirrors <ProtectedRoute allowedRoles> in frontend/src/App.tsx (admin may open everything). */
const ROUTE_ROLES: Record<string, Role[]> = {
  '/erp_users': ['admin'],
  '/customer': ['admin'],
  '/ai_stock_intelligence': ['admin'],
  '/ai_security': ['admin'],
  '/ai_gate_risk': ['admin'],
  '/ai_security_briefing': ['admin'],
  '/part_master': ['admin', 'packing'],
  '/part_stock': ['admin', 'packing'],
  '/create_packing': ['admin', 'packing'],
  '/create_packing_bulk': ['admin', 'packing'],
  '/view_packing': ['admin', 'packing'],
  '/create_box': ['admin', 'box'],
  '/view_box': ['admin', 'box'],
  '/create_invoice': ['admin', 'invoice'],
  '/view_invoice': ['admin', 'invoice'],
  '/verify_invoice': ['admin', 'gate'],
  '/gate_out_report': ['admin', 'gate'],
};

/** Sidebar entries (visible text -> href) each role should see, from Layout.tsx */
const SIDEBAR: Record<Role, string[]> = {
  admin: ['/index', '/profile', '/notifications', '/activity_history', '/ai_stock_intelligence', '/ai_security', '/ai_gate_risk', '/ai_security_briefing', '/erp_users', '/part_master', '/part_stock', '/customer', '/create_packing', '/create_packing_bulk', '/view_packing', '/create_box', '/view_box', '/create_invoice', '/view_invoice', '/verify_invoice', '/gate_out_report'],
  packing: ['/index', '/profile', '/notifications', '/activity_history', '/part_master', '/part_stock', '/create_packing', '/create_packing_bulk', '/view_packing'],
  box: ['/index', '/profile', '/notifications', '/activity_history', '/create_box', '/view_box'],
  invoice: ['/index', '/profile', '/notifications', '/activity_history', '/create_invoice', '/view_invoice'],
  gate: ['/index', '/profile', '/notifications', '/activity_history', '/verify_invoice', '/gate_out_report'],
};

test.describe('Sidebar shows exactly the modules a role may use', () => {
  for (const role of ROLES) {
    test(`${role} sidebar`, async ({ page }) => {
      await signInAs(page, role);
      await page.goto('/index');
      await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
      const hrefs = await page.locator('aside a[href], nav a[href]').evaluateAll((els) =>
        [...new Set(els.map((a) => a.getAttribute('href') || ''))].filter(Boolean),
      );
      expect(hrefs.sort()).toEqual([...SIDEBAR[role]].sort());
    });
  }
});

test.describe('Direct URL access respects roles', () => {
  for (const role of ROLES) {
    test(`${role}: allowed routes render, forbidden routes show Access Denied`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInAs(page, role);
      for (const [route, allowed] of Object.entries(ROUTE_ROLES)) {
        await page.goto(route);
        if (allowed.includes(role)) {
          await expect(page.getByText('Access Denied'), `${role} should open ${route}`).toHaveCount(0);
          await expect(page.locator('h1').first(), `${role} ${route} heading`).toBeVisible();
        } else {
          await expect(page.getByRole('heading', { name: 'Access Denied' }), `${role} must be blocked from ${route}`).toBeVisible();
          await expect(page.getByText(new RegExp(`Your active role \\(${role}\\)`, 'i'))).toBeVisible();
        }
      }
      for (const route of COMMON) {
        await page.goto(route);
        await expect(page.getByText('Access Denied'), `${role} should open ${route}`).toHaveCount(0);
      }
    });
  }

  test('Access Denied offers a Go Back button', async ({ page }) => {
    await signInAs(page, 'gate');
    await page.goto('/index');
    await page.goto('/part_master');
    await expect(page.getByRole('heading', { name: 'Access Denied' })).toBeVisible();
    await page.getByRole('button', { name: 'Go Back' }).click();
    await expect(page).toHaveURL(/\/index$/);
  });
});

test.describe('Route aliases and fallbacks', () => {
  test('"/" and unknown routes land on the dashboard', async ({ page }) => {
    await signInAs(page, 'admin');
    for (const url of ['/', '/this/route/does/not/exist']) {
      await page.goto(url);
      await expect(page).toHaveURL(/\/index$/);
    }
  });

  for (const [alias, target] of [
    ['/verification', '/verify_invoice'],
    ['/gate_risk', '/ai_gate_risk'],
    ['/security', '/ai_security'],
    ['/security_briefing', '/ai_security_briefing'],
    ['/dashboard', '/dashboard'],
  ] as const) {
    test(`${alias} -> ${target}`, async ({ page }) => {
      await signInAs(page, 'admin');
      await page.goto(alias);
      await expect(page).toHaveURL(new RegExp(`${target}$`));
    });
  }

  test('the sidebar navigates between modules without a full reload', async ({ page }) => {
    await signInAs(page, 'admin');
    await page.goto('/index');
    await page.evaluate(() => ((window as any).__marker = 'same-document'));
    await page.locator('aside a[href="/part_master"]').click();
    await expect(page).toHaveURL(/\/part_master$/);
    await page.locator('aside a[href="/view_box"]').click();
    await expect(page).toHaveURL(/\/view_box$/);
    expect(await page.evaluate(() => (window as any).__marker)).toBe('same-document'); // SPA navigation
  });
});
