import { BrowserContext, Page } from '@playwright/test';
import { API_URL, loginToken, Role, USERS } from './api';

/**
 * Starts the browser already signed in as `role` (token + user in storage, which is what
 * AuthContext reads on boot). The seed runs ONCE per tab (guarded by a sessionStorage flag),
 * so logging out, or the app dropping a rejected token, is not undone by the next page load.
 * Use the real login form only in the login tests.
 */
export async function signInAs(target: Page | BrowserContext, role: Role): Promise<void> {
  const token = await loginToken(role);
  const res = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const user = await res.json();
  await seedSession(target, token, JSON.stringify(user));
}

/** Seeds an arbitrary token/user pair (e.g. a deliberately corrupted one) once per tab. */
export async function seedSession(target: Page | BrowserContext, token: string, userJson: string): Promise<void> {
  await target.addInitScript(
    ([t, u]) => {
      try {
        if (sessionStorage.getItem('__e2e_seeded')) return;
        sessionStorage.setItem('__e2e_seeded', '1');
        localStorage.setItem('token', t as string);
        localStorage.setItem('user', u as string);
        sessionStorage.setItem('token', t as string);
        sessionStorage.setItem('user', u as string);
      } catch {
        /* storage unavailable */
      }
    },
    [token, userJson],
  );
}

export { USERS };

/**
 * Signs in as an arbitrary account (e.g. a throw-away user created by the test) so tests that
 * change profile / password never touch the seeded demo accounts.
 */
export async function signInAsUser(
  target: Page | BrowserContext,
  creds: { email: string; password: string },
): Promise<void> {
  const login = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_email: creds.email, user_password: creds.password }),
  });
  if (!login.ok) throw new Error(`login failed for ${creds.email}: HTTP ${login.status}`);
  const body = await login.json();
  await seedSession(target, body.access_token, JSON.stringify(body.user));
}
