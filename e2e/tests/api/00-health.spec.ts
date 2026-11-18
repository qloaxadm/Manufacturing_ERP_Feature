import { test, expect } from '@playwright/test';

test('API is up and connected to the E2E database', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe('ok');
});
