import { test, expect } from '@playwright/test';
import { ROLES, USERS } from '../../helpers/api';
import { seedSession, signInAs } from '../../helpers/auth';
import { trackBrowserErrors } from '../../helpers/ui';

const email = (page: import('@playwright/test').Page) => page.getByPlaceholder('name@talbros.com');
const password = (page: import('@playwright/test').Page) => page.getByPlaceholder('Enter password');
const signIn = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /sign in/i });

test.describe('Login page', () => {
  test('renders the sign-in form and the login-first notice', async ({ page }) => {
    const problems = trackBrowserErrors(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByText('Please log in first to access the ERP dashboard.')).toBeVisible();
    await expect(email(page)).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(password(page)).toHaveAttribute('type', 'password');
    expect(problems).toEqual([]);
  });

  test('the show/hide toggle reveals the password', async ({ page }) => {
    await page.goto('/login');
    await password(page).fill('s3cret');
    await page.getByTitle('Show password').click();
    await expect(password(page)).toHaveAttribute('type', 'text');
    await page.getByTitle('Hide password').click();
    await expect(password(page)).toHaveAttribute('type', 'password');
  });

  for (const role of ROLES) {
    test(`${role}: real form login lands on the dashboard with the right identity`, async ({ page }) => {
      await page.goto('/login');
      await email(page).fill(USERS[role].email);
      await password(page).fill(USERS[role].password);
      await signIn(page).click();
      await expect(page).toHaveURL(/\/index$/);
      await expect(page.getByRole('heading', { name: new RegExp(`Welcome, ${USERS[role].name}`, 'i') })).toBeVisible();
      // token + user persisted for the session
      const stored = await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
      }));
      expect(stored.token).toBeTruthy();
      expect(stored.user.type).toBe(role);
      expect(stored.user).not.toHaveProperty('user_password');
    });
  }

  test('role preset buttons fill the matching credentials', async ({ page }) => {
    await page.goto('/login');
    for (const [label, role] of [['Packing', 'packing'], ['Box', 'box'], ['Invoice', 'invoice'], ['Gate', 'gate'], ['Admin', 'admin']] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(email(page)).toHaveValue(USERS[role].email);
      await expect(password(page)).toHaveValue(USERS[role].password);
    }
  });

  test('wrong password shows the server error and keeps the user on /login', async ({ page }) => {
    await page.goto('/login');
    await email(page).fill(USERS.admin.email);
    await password(page).fill('definitely-wrong');
    await signIn(page).click();
    await expect(page.getByText('Email and Password Invalid')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  });

  test('unknown user gets the same generic error', async ({ page }) => {
    await page.goto('/login');
    await email(page).fill('nobody@talbros.com');
    await password(page).fill('x');
    await signIn(page).click();
    await expect(page.getByText('Email and Password Invalid')).toBeVisible();
  });

  test('a deep link while signed out redirects to login and returns after sign-in', async ({ page }) => {
    await page.goto('/part_master');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fpart_master&notice=login_first/);
    await email(page).fill(USERS.admin.email);
    await password(page).fill(USERS.admin.password);
    await signIn(page).click();
    await expect(page).toHaveURL(/\/part_master$/);
    await expect(page.getByRole('heading', { name: 'Part Master' })).toBeVisible();
  });

  test('an already signed-in user visiting /login is sent to the dashboard', async ({ page }) => {
    await signInAs(page, 'gate');
    await page.goto('/login');
    await expect(page).toHaveURL(/\/index$/);
  });

  test('a corrupted / expired token is rejected and the session is cleared', async ({ page }) => {
    await seedSession(
      page,
      'not-a-real-token',
      JSON.stringify({ id: 3, user_name: 'ghost', user_email: 'ghost@x.com', type: 'admin' }),
    );
    await page.goto('/part_master');
    await expect(page).toHaveURL(/\/login/);
    // (the app redirects with a full page load, so tolerate a navigation mid-poll)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('token')).catch(() => 'navigating'))
      .toBeNull();
  });

  test('logout ends the session and protects every route again', async ({ page }) => {
    await signInAs(page, 'packing');
    await page.goto('/index');
    await page.getByRole('button', { name: /logout/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
    // a brand-new browser context (no stored session) is bounced to the login page
    const clean = await page.context().browser()!.newContext();
    const p2 = await clean.newPage();
    await p2.goto('/create_packing');
    await expect(p2).toHaveURL(/\/login\?redirect=/);
    await clean.close();
  });

  test('auto_auth query param signs in a demo role (used by the legacy walkthroughs)', async ({ page }) => {
    await page.goto('/login?auto_auth=gate');
    await expect(page).toHaveURL(/\/index$/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').type)).toBe('gate');
  });
});
