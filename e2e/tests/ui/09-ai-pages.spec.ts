import { test, expect, Page } from '@playwright/test';
import { apiAs, buildLockedInvoice, ok } from '../../helpers/api';
import { signInAs } from '../../helpers/auth';
import { gotoApp, rowWith, trackBrowserErrors } from '../../helpers/ui';

/** A gate verification that the AI engine has scored, ready to inspect in the UI. */
async function seedScoredGateTransaction() {
  const lot = await buildLockedInvoice();
  const gate = await apiAs('gate');
  const admin = await apiAs('admin');
  const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));
  const risk = await ok(await admin.post('/api/ai/gate-risk/analyze', { data: { match_id: match.id } }));
  return { lot, match, risk };
}

test.describe('AI Stock Intelligence', () => {
  test('summarises risk, explains each forecast and lets admin export', async ({ page }) => {
    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/ai_stock_intelligence');
    await expect(page.getByRole('heading', { name: 'AI Stock Intelligence' })).toBeVisible();
    for (const tile of ['High Risk Parts', 'Medium Risk Parts', 'Safe & In-Stock Parts']) {
      await expect(page.getByText(tile).first()).toBeVisible();
    }

    // every forecast row must explain itself: reason + confidence + risk level (AGENTS.md rule 4)
    await page.getByPlaceholder('Search Part Number Or Name').fill('GASKET FLEXOID');
    const row = page.locator('tbody tr').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Confidence:\s*\d+%/);
    await expect(row).toContainText(/High|Medium|Low|Critical|Safe/i);
    await expect(row).toContainText(/depletes|days|stock/i);
    for (const col of ['Trend Reason', 'Depletes In', '30-Day Forecast', 'Suggested Production', 'Risk']) {
      await expect(page.locator('th', { hasText: col })).toBeVisible();
    }

    const [xlsx] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export to Excel/ }).click(),
    ]);
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/i);
    expect(problems).toEqual([]);
  });

  test('searching narrows the table; a nonsense search shows an empty state', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_stock_intelligence');
    await page.getByPlaceholder('Search Part Number Or Name').fill('zzz-no-such-part-zzz');
    await expect(page.locator('tbody tr')).toHaveCount(1); // the "no results" row
    await expect(page.locator('tbody')).toContainText(/no|found|match/i);
  });
});

test.describe('AI Gate Risk (explainable, human-reviewed)', () => {
  test('a scored dispatch shows score, level, primary signal and review status', async ({ page }) => {
    const { lot, risk } = await seedScoredGateTransaction();
    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/ai_gate_risk');
    await expect(page.getByRole('heading', { name: 'AI Gate Risk Analysis & Security Hub' })).toBeVisible();
    await page.getByPlaceholder('Search Invoice, Customer, Part...').fill(lot.invoice.barcode);

    const row = rowWith(page, lot.invoice.barcode);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(lot.invoice.invoice_number);
    await expect(row).toContainText(lot.part.part_number);
    await expect(row).toContainText(new RegExp(`${risk.risk_score}\\s*/\\s*100`));
    await expect(row).toContainText(risk.risk_level);
    await expect(row).toContainText(/Pending/); // awaiting human review
    expect(problems).toEqual([]);
  });

  test('the evidence chain answers what / why / evidence / confidence', async ({ page }) => {
    const { lot, risk } = await seedScoredGateTransaction();
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_gate_risk');
    await page.getByPlaceholder('Search Invoice, Customer, Part...').fill(lot.invoice.barcode);
    await rowWith(page, lot.invoice.barcode).getByTitle('View Risk Evidence').click();

    await expect(page.getByText('AI Gate Risk Details & Evidence Chain')).toBeVisible();
    // 1. what: classification + score
    await expect(page.getByText(new RegExp(`${risk.risk_level} RISK`)).first()).toBeVisible();
    await expect(page.getByText(`Score: ${risk.risk_score} / 100`, { exact: true })).toBeVisible();
    // 2. why: trigger factors
    await expect(page.getByText('AI Identified Trigger Factors:')).toBeVisible();
    // 3. evidence: metrics + weighted factor table + timeline
    await expect(page.getByText('Evidence Breakdown & Metrics:')).toBeVisible();
    await expect(page.getByText('Risk Factor Weights & Criteria:')).toBeVisible();
    await expect(page.getByText('Gate Scan Timeline & Barcode Logs:')).toBeVisible();
    for (const factor of ['Quantity Anomaly', 'Unusual Scan Time', 'Workflow Bypass']) {
      await expect(page.getByText(factor).first()).toBeVisible();
    }
    // 4. confidence / risk indication
    await expect(page.getByText(/AI Confidence:\s*\d+%/)).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByText('AI Gate Risk Details & Evidence Chain')).toHaveCount(0);
  });

  test('supervisor review: choose a decision, log an audit note, status becomes Reviewed', async ({ page }) => {
    const { lot } = await seedScoredGateTransaction();
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_gate_risk');
    await page.getByPlaceholder('Search Invoice, Customer, Part...').fill(lot.invoice.barcode);
    const row = rowWith(page, lot.invoice.barcode);
    await row.getByTitle('Review & Log Audit').click();

    await expect(page.getByText('Review Gate Dispatch Risk')).toBeVisible();
    await expect(page.getByText(/AI Identified Risk Signals/)).toBeVisible(); // the AI explains itself first
    const submit = page.getByRole('button', { name: 'Submit Risk Review' });

    // both a decision and an audit note are mandatory
    await submit.click();
    await expect(page.getByText('Review Gate Dispatch Risk')).toBeVisible();

    await page.getByText('Approve', { exact: true }).click();
    await page.locator('textarea').fill('Seal and quantity physically verified at the gate (e2e).');
    await submit.click();
    await expect(page.getByText('Review Gate Dispatch Risk')).toHaveCount(0);

    // human decision persisted with attribution
    const admin = await apiAs('admin');
    await expect
      .poll(async () => {
        const list = await ok(await admin.get(`/api/ai/gate-risk/transactions?search=${lot.invoice.barcode}`));
        return list.items[0]?.review_decision;
      })
      .toBe('approved');
    const list = await ok(await admin.get(`/api/ai/gate-risk/transactions?search=${lot.invoice.barcode}`));
    expect(list.items[0].review_note).toContain('physically verified');
    expect(list.items[0].reviewed_by_name).toBeTruthy();
    await expect(rowWith(page, lot.invoice.barcode)).toContainText(/Reviewed|Approved/i);
  });

  test('risk-level tabs and search filter the transaction list', async ({ page }) => {
    const { lot, risk } = await seedScoredGateTransaction();
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_gate_risk');
    await page.getByPlaceholder('Search Invoice, Customer, Part...').fill(lot.invoice.barcode);
    await expect(rowWith(page, lot.invoice.barcode)).toHaveCount(1);

    const other = risk.risk_level === 'HIGH' ? 'LOW Risk' : 'HIGH Risk';
    // wait for each filter response so one click cannot race the next
    await page.getByRole('button', { name: other, exact: true }).click();
    await page.waitForLoadState('networkidle');
    await expect(rowWith(page, lot.invoice.barcode)).toHaveCount(0);
    await page.getByRole('button', { name: `${risk.risk_level} Risk`, exact: true }).click();
    await page.waitForLoadState('networkidle');
    await expect(rowWith(page, lot.invoice.barcode)).toHaveCount(1);
    await page.getByRole('button', { name: 'All Risks', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await expect(rowWith(page, lot.invoice.barcode)).toHaveCount(1);
  });

  test('the scoring configuration is visible to admin and can be dismissed', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_gate_risk');
    await page.getByRole('button', { name: 'Risk Config' }).click();
    await expect(page.getByText('Configure AI Risk Scoring Parameters')).toBeVisible();
    for (const label of ['Quantity Anomaly Weight', 'Off-Hours Dispatch Weight', 'Workflow Bypass', 'Failed Barcode Scans', 'Off-Hours Start', 'Off-Hours End']) {
      await expect(page.getByText(new RegExp(label)).first()).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Save Configuration' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Configure AI Risk Scoring Parameters')).toHaveCount(0);
  });

  test('the gate officer sees the AI risk next to each invoice on Verify Invoice', async ({ page }) => {
    const { lot, risk } = await seedScoredGateTransaction();
    await signInAs(page, 'gate');
    await gotoApp(page, '/verify_invoice');
    await page.getByPlaceholder('Search by Invoice, Part Number or Part Name...').fill(lot.invoice.barcode);
    const row = rowWith(page, lot.invoice.barcode);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${risk.risk_level} (${risk.risk_score})`);
  });
});

test.describe('AI Daily Security Briefing', () => {
  test('shows the executive summary, KPI tiles and day navigation', async ({ page }) => {
    await seedScoredGateTransaction();
    const admin = await apiAs('admin');
    await ok(await admin.post('/api/ai/security-briefing/generate', { data: {} }));

    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/ai_security_briefing');
    await expect(page.getByRole('heading', { name: 'AI Daily Security Briefing' })).toBeVisible();
    for (const t of ['MONITORED GATE OPERATIONS', 'HIGH PRIORITY ALERTS', 'MEDIUM PRIORITY ALERTS', 'PENDING SUPERVISOR REVIEWS', 'EXECUTIVE SECURITY BRIEFING SUMMARY']) {
      await expect(page.getByText(t)).toBeVisible();
    }
    await expect(page.getByText(/Daily Incident Digest & Evidence Trace \(\d+ Flagged Events\)/)).toBeVisible();

    // previous day -> a different date, Today brings us back
    const dateInput = page.locator('input[type="date"]');
    const today = await dateInput.inputValue();
    await page.getByRole('button', { name: 'Previous Day' }).click();
    await expect(dateInput).not.toHaveValue(today);
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(dateInput).toHaveValue(today);
    expect(problems).toEqual([]);
  });

  test('the history archive lists past briefings and can reload one', async ({ page }) => {
    const admin = await apiAs('admin');
    await ok(await admin.post('/api/ai/security-briefing/generate', { data: {} }));
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_security_briefing');
    await page.getByRole('button', { name: 'Briefing History' }).click();
    await expect(page.getByText('Historical Security Briefings Archive')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load Report' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Load Report' }).first().click();
    await expect(page.getByText('Historical Security Briefings Archive')).toHaveCount(0);
    await expect(page.getByText('EXECUTIVE SECURITY BRIEFING SUMMARY')).toBeVisible();
  });

  test('regenerating keeps the briefing for the same date and exports are offered', async ({ page }) => {
    await signInAs(page, 'admin');
    await gotoApp(page, '/ai_security_briefing');
    const dateInput = page.locator('input[type="date"]');
    const date = await dateInput.inputValue();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/security-briefing/generate') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Regenerate Briefing' }).click(),
    ]);
    expect(res.status()).toBeLessThan(300);
    await expect(dateInput).toHaveValue(date);
    await expect(page.getByRole('button', { name: 'PDF' })).toBeVisible();
    const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel' }).click()]);
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/i);
  });
});

test.describe('AI Security & Anomaly Detection', () => {
  test('renders the status, counters and filters; a manual scan completes without error', async ({ page }) => {
    await signInAs(page, 'admin');
    const problems = trackBrowserErrors(page);
    await gotoApp(page, '/ai_security');
    await expect(page.getByRole('heading', { name: 'AI Security & Anomaly Detection' })).toBeVisible();
    for (const t of ['TOTAL ANOMALIES (7D)', 'CRITICAL THREATS', 'HIGH RISK FLAGS', 'RESOLVED INCIDENTS']) {
      await expect(page.getByText(t)).toBeVisible();
    }
    for (const f of ['All', 'Pending Action', 'Under Investigation', 'Resolved']) {
      await expect(page.getByRole('button', { name: f, exact: true })).toBeVisible();
    }
    const [scan] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/ai/security-anomalies')),
      page.getByRole('button', { name: 'Run Security Scan' }).click(),
    ]);
    expect(scan.status()).toBe(200);
    expect(problems).toEqual([]);
  });
});

test.describe('AI pages are admin-only in the UI', () => {
  for (const role of ['packing', 'box', 'invoice', 'gate'] as const) {
    test(`${role} cannot open any AI page and sees no AI links`, async ({ page }) => {
      await signInAs(page, role);
      for (const route of ['/ai_stock_intelligence', '/ai_security', '/ai_gate_risk', '/ai_security_briefing']) {
        await page.goto(route);
        await expect(page.getByRole('heading', { name: 'Access Denied' }), route).toBeVisible();
      }
      await expect(page.locator('aside a[href^="/ai_"]')).toHaveCount(0);
    });
  }
});
