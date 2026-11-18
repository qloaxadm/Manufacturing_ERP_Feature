import { test, expect, request as pwRequest } from '@playwright/test';
import { API_URL, apiAnon, apiAs, json, ok, ROLES, uid, USERS } from '../../helpers/api';

test.describe('Auth: login', () => {
  for (const role of ROLES) {
    test(`${role} can log in and receives a JWT + profile`, async () => {
      const anon = await apiAnon();
      const res = await anon.post('/api/auth/login', {
        data: { user_email: USERS[role].email, user_password: USERS[role].password },
      });
      expect(res.status()).toBe(201);
      const body = await json(res);
      expect(body.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(body.user).toMatchObject({ user_email: USERS[role].email, type: role });
      expect(body.user).not.toHaveProperty('user_password');
    });
  }

  test('also accepts the short {email, password} body shape', async () => {
    const anon = await apiAnon();
    const res = await anon.post('/api/auth/login', { data: { email: USERS.admin.email, password: USERS.admin.password } });
    expect(res.status()).toBe(201);
  });

  test('wrong password -> 401 with a generic message', async () => {
    const anon = await apiAnon();
    const res = await anon.post('/api/auth/login', { data: { user_email: USERS.admin.email, user_password: 'nope' } });
    expect(res.status()).toBe(401);
    expect((await json(res)).message).toBe('Email and Password Invalid');
  });

  test('unknown user -> 401 with the same message (no user enumeration)', async () => {
    const anon = await apiAnon();
    const res = await anon.post('/api/auth/login', { data: { user_email: `ghost-${uid()}@x.com`, user_password: 'x' } });
    expect(res.status()).toBe(401);
    expect((await json(res)).message).toBe('Email and Password Invalid');
  });

  test('empty body is rejected, not a 500', async () => {
    const anon = await apiAnon();
    const res = await anon.post('/api/auth/login', { data: {} });
    expect([400, 401]).toContain(res.status());
  });

  test('SQL-injection style input does not authenticate', async () => {
    const anon = await apiAnon();
    const res = await anon.post('/api/auth/login', {
      data: { user_email: "admin@admin.com' OR '1'='1", user_password: "' OR '1'='1" },
    });
    expect(res.status()).toBe(401);
  });

  test('3 failed logins raise an admin security notification with evidence', async () => {
    const anon = await apiAnon();
    const victim = `brute-${uid().toLowerCase()}@talbros.com`;
    for (let i = 0; i < 3; i++) {
      const r = await anon.post('/api/auth/login', { data: { user_email: victim, user_password: `bad${i}` } });
      expect(r.status()).toBe(401);
    }
    const admin = await apiAs('admin');
    await expect
      .poll(async () => {
        const list = await json(await admin.get('/api/notifications?limit=50&search=' + encodeURIComponent(victim)));
        return (list.items as any[]).filter((n) => n.type === 'SECURITY_LOGIN_FAILED').length;
      })
      .toBeGreaterThan(0);
    const list = await json(await admin.get('/api/notifications?limit=50&search=' + encodeURIComponent(victim)));
    const n = (list.items as any[]).find((x) => x.type === 'SECURITY_LOGIN_FAILED');
    // AGENTS.md explainability: what / why / evidence / priority / next step
    expect(n.title).toContain(victim);
    expect(n.reason).toMatch(/3 consecutive failed login attempts/);
    expect(n.priority).toBe('HIGH');
  });
});

test.describe('Auth: token protection', () => {
  test('protected endpoints reject missing tokens with 401', async () => {
    const anon = await apiAnon();
    for (const url of ['/api/auth/me', '/api/dashboard/stats', '/api/parts', '/api/settings', '/api/notifications']) {
      expect((await anon.get(url)).status(), url).toBe(401);
    }
  });

  test('protected endpoints reject garbage / tampered tokens', async () => {
    const anon = await apiAnon();
    for (const token of ['garbage', 'a.b.c', 'Bearer']) {
      const res = await anon.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status(), token).toBe(401);
    }
  });

  test('a validly-formatted token signed with another secret is rejected', async () => {
    const anon = await apiAnon();
    // header.payload.signature signed with "wrong-secret" (HS256) for {sub:3,type:"admin"}
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjMsImVtYWlsIjoiYWRtaW5AYWRtaW4uY29tIiwidHlwZSI6ImFkbWluIn0.Zm9yZ2VkLXNpZ25hdHVyZQ';
    const res = await anon.get('/api/users', { headers: { Authorization: `Bearer ${forged}` } });
    expect(res.status()).toBe(401);
  });

  for (const role of ROLES) {
    test(`/auth/me returns the ${role} identity`, async () => {
      const api = await apiAs(role);
      const me = await ok(await api.get('/api/auth/me'));
      expect(me).toMatchObject({ user_email: USERS[role].email, type: role });
    });
  }
});

test.describe('Auth: profile & password', () => {
  test('profile-details returns department and employee id', async () => {
    const api = await apiAs('packing');
    const p = await ok(await api.get('/api/auth/profile-details'));
    expect(p).toMatchObject({ type: 'packing', department: 'Finished Goods Packing Line', status: 'Active' });
    expect(p.employee_id).toMatch(/^EMP-\d+$/);
  });

  test('update profile name persists, blank name is ignored', async () => {
    const admin = await apiAs('admin');
    const created = await ok(
      await admin.post('/api/users', {
        data: { user_name: 'Prof', user_email: `prof-${uid().toLowerCase()}@x.com`, user_password: 'pw1', user_role: 'box' },
      }),
    );
    const anon = await apiAnon();
    const login = await json(
      await anon.post('/api/auth/login', { data: { user_email: created.user_email, user_password: 'pw1' } }),
    );
    const me = await pwRequest.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}` },
    });
    const updated = await ok(await me.put('/api/auth/profile', { data: { user_name: 'Renamed Person' } }));
    expect(updated.user.user_name).toBe('Renamed Person');
    const blank = await ok(await me.put('/api/auth/profile', { data: { user_name: '   ' } }));
    expect(blank.user.user_name).toBe('Renamed Person');
    expect((await ok(await me.get('/api/auth/profile-details'))).user_name).toBe('Renamed Person');

    // change password: wrong current -> 401, too short -> 401, valid -> old pw stops working
    expect((await me.put('/api/auth/change-password', { data: { currentPassword: 'wrong', newPassword: 'abcd' } })).status()).toBe(401);
    expect((await me.put('/api/auth/change-password', { data: { currentPassword: 'pw1', newPassword: 'x' } })).status()).toBe(401);
    await ok(await me.put('/api/auth/change-password', { data: { currentPassword: 'pw1', newPassword: 'pw2new' } }));
    expect(
      (await anon.post('/api/auth/login', { data: { user_email: created.user_email, user_password: 'pw1' } })).status(),
    ).toBe(401);
    expect(
      (await anon.post('/api/auth/login', { data: { user_email: created.user_email, user_password: 'pw2new' } })).status(),
    ).toBe(201);
    await me.dispose();
    await ok(await admin.delete(`/api/users/${created.id}`));
  });
});
