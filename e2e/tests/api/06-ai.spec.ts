import { test, expect } from '@playwright/test';
import { apiAs, badRequest, buildLockedInvoice, json, ok, ROLES } from '../../helpers/api';

/**
 * AGENTS.md AI principles under test:
 *   1. read-only by default (AI never mutates ERP state)
 *   2. every alert carries: what / why / evidence / risk-confidence / recommended review
 *   3. RBAC applies to every AI endpoint
 * The suite runs with GEMINI_API_KEY blank, so it exercises the deterministic rule engine.
 */
test.describe('AI service status', () => {
  test('reports the engine in use and the guarantees it provides', async () => {
    const api = await apiAs('gate');
    const s = await ok(await api.get('/api/ai/status'));
    expect(s.status).toBe('operational');
    expect(s.gemini_connected).toBe(false);
    expect(s.features).toMatchObject({ role_based_access_control: true, audit_evidence_trail: true });
  });
});

test.describe('AI stock intelligence (explainability)', () => {
  test('every forecast has numbers, a trend reason, a risk level and a confidence score', async () => {
    const api = await apiAs('admin');
    const rows = await ok(await api.get('/api/ai/stock-intelligence'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of (rows as any[]).slice(0, 50)) {
      expect(typeof r.current_stock).toBe('number');
      expect(typeof r.historical_demand_90d).toBe('number'); // evidence
      expect(typeof r.forecasted_demand_30d).toBe('number'); // projection
      expect(r.trend_reason, `part ${r.part_number}`).toBeTruthy(); // why
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(String(r.risk_level).toUpperCase());
      expect(r.confidence_score).toBeGreaterThanOrEqual(0);
      expect(r.confidence_score).toBeLessThanOrEqual(100);
    }
  });
});

test.describe('AI gate risk (explainability + human review)', () => {
  test('a gate transaction is scored 0-100 with reasons, evidence and a recommendation', async () => {
    const lot = await buildLockedInvoice();
    const gate = await apiAs('gate');
    const admin = await apiAs('admin');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));

    const risk = await ok(await admin.post('/api/ai/gate-risk/analyze', { data: { match_id: match.id } }));
    expect(risk.risk_score).toBeGreaterThanOrEqual(0);
    expect(risk.risk_score).toBeLessThanOrEqual(100);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(risk.risk_level);

    // WHY
    expect(Array.isArray(risk.reasons)).toBe(true);
    expect(risk.reasons.length).toBeGreaterThan(0);
    // EVIDENCE: each factor documents what was measured, its weight, and whether it fired
    const factors = Object.values(risk.risk_factors) as any[];
    expect(factors.length).toBeGreaterThan(0);
    for (const f of factors) {
      expect(f).toHaveProperty('detected');
      expect(f.detail, `factor ${f.name}`).toBeTruthy();
      expect(f.score).toBeLessThanOrEqual(f.maxScore);
    }
    expect(risk.metrics).toBeTruthy();
    // RECOMMENDED REVIEW
    expect(risk.recommendation).toBeTruthy();
    expect(risk.model_version).toBeTruthy();
  });

  test('admin reviews a flagged analysis: decision + note are stored and the dashboard reflects it', async () => {
    const lot = await buildLockedInvoice();
    const gate = await apiAs('gate');
    const admin = await apiAs('admin');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));
    const risk = await ok(await admin.post('/api/ai/gate-risk/analyze', { data: { match_id: match.id } }));

    const reviewed = await ok(
      await admin.post('/api/ai/gate-risk/review', {
        data: { analysis_id: risk.id, decision: 'approved', note: 'Verified physically by e2e' },
      }),
    );
    expect(JSON.stringify(reviewed)).toContain('approved');

    const detail = await ok(await admin.get(`/api/ai/gate-risk/transaction/${risk.id}`));
    expect(detail.review_decision).toBe('approved');
    expect(detail.review_note).toBe('Verified physically by e2e');
    expect(detail.reviewed_by_name).toBeTruthy(); // who reviewed it is on record
    expect(detail.review_timestamp).toBeTruthy();
  });

  test('transactions list filters by risk level and supports pagination', async () => {
    const admin = await apiAs('admin');
    const all = await ok(await admin.get('/api/ai/gate-risk/transactions?limit=5&page=1'));
    expect(all).toMatchObject({ page: 1, limit: 5 });
    expect(all.total).toBeGreaterThanOrEqual(all.items.length);
    for (const level of ['LOW', 'MEDIUM', 'HIGH']) {
      const filtered = await ok(await admin.get(`/api/ai/gate-risk/transactions?risk_level=${level}&limit=50`));
      for (const row of filtered.items as any[]) expect(row.risk_level).toBe(level);
    }
  });

  test('dashboard summary is internally consistent', async () => {
    const admin = await apiAs('admin');
    const d = await ok(await admin.get('/api/ai/gate-risk/dashboard'));
    expect(d.low_risk_count + d.medium_risk_count + d.high_risk_count).toBe(d.total_analyzed);
    expect(d.average_risk_score).toBeGreaterThanOrEqual(0);
    expect(d.average_risk_score).toBeLessThanOrEqual(100);
    expect(Array.isArray(d.factor_frequencies)).toBe(true);
  });

  test('risk weights are configurable by admin only and exposed with their thresholds', async () => {
    const admin = await apiAs('admin');
    const cfg = await ok(await admin.get('/api/ai/gate-risk/config'));
    expect(cfg).toHaveProperty('THRESHOLD_LOW_MAX');
    expect(cfg).toHaveProperty('THRESHOLD_MEDIUM_MAX');
    expect(Number(cfg.THRESHOLD_LOW_MAX)).toBeLessThan(Number(cfg.THRESHOLD_MEDIUM_MAX));
    expect((await (await apiAs('gate')).get('/api/ai/gate-risk/config')).status()).toBe(403);
  });

  test('the gate officer may log scans and analyse, but not read the admin dashboard', async () => {
    const lot = await buildLockedInvoice();
    const gate = await apiAs('gate');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));
    const logged = await gate.post('/api/ai/gate-risk/log-scan', {
      data: { match_id: match.id, scanned_barcode: '000000', scan_type: 'box', is_valid: false, failure_reason: 'e2e wrong box' },
    });
    expect(logged.status(), await logged.text()).toBeLessThan(300);
    const analysed = await gate.post('/api/ai/gate-risk/analyze', { data: { match_id: match.id } });
    expect(analysed.status(), await analysed.text()).toBeLessThan(300);
    expect((await gate.get('/api/ai/gate-risk/dashboard')).status()).toBe(403);
  });
});

test.describe('AI security anomalies & daily briefing', () => {
  test('anomalies carry a type, severity, description and timestamp', async () => {
    const admin = await apiAs('admin');
    const rows = await ok(await admin.get('/api/ai/security-anomalies'));
    expect(Array.isArray(rows)).toBe(true);
    for (const a of rows as any[]) {
      expect(a.type).toBeTruthy();
      expect(a.severity).toBeTruthy();
      expect(a.description).toBeTruthy();
      expect(a.timestamp).toBeTruthy();
    }
  });

  test('briefing: generate -> today -> history -> event detail -> sign-off', async () => {
    const admin = await apiAs('admin');
    const generated = await ok(await admin.post('/api/ai/security-briefing/generate', { data: {} }));
    expect(generated.briefing_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(generated.executive_summary).toBeTruthy();
    expect(generated.normal_count + generated.high_priority_count + generated.medium_priority_count + generated.low_priority_count).toBeGreaterThanOrEqual(0);

    const today = await ok(await admin.get('/api/ai/security-briefing/today'));
    expect(today.briefing_date).toBe(generated.briefing_date);

    const history = await ok(await admin.get('/api/ai/security-briefing/history'));
    expect((history as any[]).some((h) => h.briefing_date === generated.briefing_date)).toBe(true);

    const byDate = await ok(await admin.get(`/api/ai/security-briefing/${generated.briefing_date}`));
    expect(byDate.briefing_date).toBe(generated.briefing_date);

    // every event in the briefing must be explainable
    for (const ev of (byDate.events as any[]).slice(0, 10)) {
      expect(ev.id).toBeTruthy();
      const detail = await ok(await admin.get(`/api/ai/security-briefing/${generated.briefing_date}/events/${ev.id}`));
      expect(JSON.stringify(detail).length).toBeGreaterThan(20);
    }

    const signed = await admin.post(`/api/ai/security-briefing/${generated.briefing_date}/sign-off`, {
      data: { note: 'Reviewed by e2e' },
    });
    expect(signed.status(), await signed.text()).toBeLessThan(300);
    const after = await ok(await admin.get(`/api/ai/security-briefing/${generated.briefing_date}`));
    expect(after.status).toBe('reviewed'); // human sign-off recorded
  });
});

test.describe('Ask ERP assistant', () => {
  test('returns role-tailored suggestions for every role', async () => {
    for (const role of ROLES) {
      const api = await apiAs(role);
      const s = await ok(await api.get('/api/ai/ask/suggestions'));
      expect(s.role).toBe(role);
      expect(s.suggestions.length, role).toBeGreaterThan(0);
    }
  });

  test('answers a question and records an authorisation audit', async () => {
    const api = await apiAs('admin');
    const a = await ok(await api.post('/api/ai/ask', { data: { query: 'How many parts are in stock?' } }));
    expect(a).toMatchObject({ user_role: 'admin' });
    expect(a.security_audit).toMatchObject({ role_checked: 'admin', authorized: true });
    expect(a.direct_answer || a.message).toBeTruthy();
  });

  test('refuses a question outside the caller role instead of leaking data', async () => {
    const api = await apiAs('packing');
    const a = await ok(await api.post('/api/ai/ask', { data: { query: 'Show me all ERP users and their passwords' } }));
    const text = JSON.stringify(a).toLowerCase();
    expect(text).not.toContain('"user_password"');
    expect(text).not.toMatch(/admin@admin\.com/);
  });
});

test.describe('AI is read-only: it never changes ERP state', () => {
  test('running every AI read/analyse endpoint leaves ERP transaction counts unchanged', async () => {
    const lot = await buildLockedInvoice();
    const admin = await apiAs('admin');
    const gate = await apiAs('gate');
    const match = await ok(await gate.post('/api/verification/start', { data: { invoice_barcode: lot.invoice.barcode } }));

    const snapshot = async () => {
      const d = await ok(await admin.get('/api/dashboard/stats'));
      const inv = await ok(await admin.get(`/api/invoices/${lot.invoice.id}`));
      const box = await ok(await admin.get(`/api/boxes/${lot.box.id}`));
      return JSON.stringify({
        counts: d.systemCounts,
        stock: d.stockDistribution.chartData,
        invoice: [inv.invoice.status, inv.invoice.lock_status, inv.total_part_qty],
        box: [box.box.status, box.box.lock_status, box.total_part_qty],
      });
    };

    const before = await snapshot();
    for (const url of [
      '/api/ai/stock-intelligence',
      '/api/ai/security-anomalies',
      '/api/ai/gate-risk/dashboard',
      '/api/ai/gate-risk/transactions',
      '/api/ai/security-briefing/today',
      '/api/ai/ask/suggestions',
    ]) {
      expect((await admin.get(url)).ok(), url).toBe(true);
    }
    await ok(await admin.post('/api/ai/gate-risk/analyze', { data: { match_id: match.id } }));
    await ok(await admin.post('/api/ai/ask', { data: { query: 'Dispatch and clear invoice ' + lot.invoice.invoice_number } }));
    const after = await snapshot();

    // the verification session we opened is the only legitimate difference; the AI itself
    // did not lock, unlock, dispatch or adjust anything.
    expect(after).toBe(before);
    const ver = await ok(await gate.get(`/api/verification/${match.id}`));
    expect(ver.match.status).toBe('pending'); // AI never clears a gate pass on its own
  });
});
