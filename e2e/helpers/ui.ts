import { expect, Locator, Page } from '@playwright/test';

/**
 * The ERP uses window.alert() for most feedback. Playwright auto-dismisses dialogs, which would
 * hide the message - so capture every dialog, accept it, and let tests assert on the text.
 */
export function captureDialogs(page: Page) {
  const messages: string[] = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.accept().catch(() => {});
  });
  return {
    messages,
    /** waits until a dialog containing `text` was shown */
    async expectMessage(text: string | RegExp, timeout = 10_000) {
      await expect
        .poll(() => messages.some((m) => (typeof text === 'string' ? m.includes(text) : text.test(m))), {
          timeout,
          message: `expected an alert matching ${text}; saw: ${JSON.stringify(messages)}`,
        })
        .toBe(true);
    },
    last: () => messages[messages.length - 1],
    clear: () => messages.splice(0, messages.length),
  };
}

/** react-select (classNamePrefix="react-select"): open control #index, type to filter, pick option. */
export async function reactSelect(page: Page, index: number, search: string, scope?: Locator) {
  const root = scope ?? page;
  const control = root.locator('.react-select__control').nth(index);
  await control.click();
  await page.keyboard.type(search, { delay: 5 });
  const option = page.locator('.react-select__option').filter({ hasText: search }).first();
  await expect(option, `react-select option "${search}"`).toBeVisible();
  await option.click();
}

/** Collects problems a real user would hit: uncaught exceptions, console errors, 5xx API calls. */
export function trackBrowserErrors(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // 4xx are asserted explicitly by the tests that provoke them
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    problems.push(`console.error: ${text.slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

/** Waits for the app shell (sidebar + content) after navigation. */
export async function gotoApp(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Row in the first table on the page that contains `text`. */
export function rowWith(page: Page, text: string | RegExp): Locator {
  return page.locator('tbody tr').filter({ hasText: text });
}
