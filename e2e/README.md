# ERP end-to-end tests (Playwright)

Two layers against one isolated stack:

| Project | What it covers | Folder |
|---------|----------------|--------|
| `api`   | Every backend module over HTTP: auth, role matrix, parts, customers, users, the packing → box → invoice → gate workflow and its guard rails, barcode validation, dashboard, notifications, settings, audit log, AI (explainability + read-only). | `tests/api` |
| `ui`    | The real React app in Chrome: login, sidebar/RBAC, every page renders without console/5xx errors, master data CRUD, the five-role workflow, profile/settings, notifications/activity, AI pages, dashboards, Ask ERP. | `tests/ui` |

## Isolation (your dev data is never touched)

| | Dev | E2E |
|---|---|---|
| Database | `barcode` | `barcode_e2e`, rebuilt from `Dump20260919.sql` before every run |
| API | `:5001` | `:5101` |
| UI | `:3000` | `:3100` (`VITE_API_URL` set, like production) |

`scripts/reset-db.mjs` refuses to run against any database whose name does not contain `e2e`/`test`, or that equals the `DB_NAME` in `backend/.env`.

## Prerequisites

- Node 18+ and MySQL 8 reachable with the credentials in `backend/.env` (e.g. `docker start erp-mysql`).
- Google Chrome installed (default). To use Playwright's bundled Chromium instead: `npm run install:browsers` and set `E2E_BROWSER=chromium`.

## Run

```bash
cd e2e
npm install
npm test                 # everything (api first, then ui)
npm run test:api         # API only (~2 min)
npm run test:ui          # UI only; add --no-deps to skip re-running the api project
npx playwright test --project=ui --no-deps tests/ui/05-workflow.spec.ts   # one file
npm run test:headed      # watch the browser
npm run report           # open the HTML report
```

Servers are started and stopped by Playwright itself. Set `E2E_DEBUG_SERVERS=1` to stream their stderr when something fails to boot.

Optional overrides: `E2E_DB_HOST|PORT|USER|PASS|NAME`, `E2E_API_PORT`, `E2E_UI_PORT`, `E2E_DUMP_PATH`.

## Conventions

- Tests run serially on a single worker (shared database). Each test creates its own uniquely named data through the API, so files can run on their own.
- Seeded demo accounts: `admin@admin.com`/`admin`, `dpr@talbros.com`/`dpr` (packing), `fgs@talbros.com`/`fgs` (box), `invoice@talbros.com`/`invoice`, `gate@talbros.com`/`gate`.
- UI tests sign in by injecting the token (`helpers/auth.ts`); only `01-login.spec.ts` uses the real form.
- The app reports most outcomes with `window.alert`; `captureDialogs()` records them so tests can assert on the text.
- AI runs on the deterministic rule engine (`GEMINI_API_KEY` is blank in tests).

## Known issues (expected failures)

Bugs the suite found are encoded as tests that assert the **correct** behaviour and are marked `test.fail()`:

- `tests/api/07-known-issues.spec.ts`
- the `Known UI issues` block in `tests/ui/07-profile-settings.spec.ts`
- the `KNOWN ISSUE` tests in `tests/ui/06-master-data.spec.ts`

While the bug exists the test "fails as expected" and the run stays green. **The default list reporter prints `x` for these** - check the final summary line. When a bug is fixed Playwright reports `expected to fail but passed`: delete the `test.fail(...)` line and it becomes a regression guard.

Current list: non-admin actions attributed to admin (`user?.id || user?.sub || 3`); plaintext passwords returned by `/api/users`; barcode validation cannot see already-boxed packings; empty bodies cause HTTP 500; `user_email` missing in audit rows; anomalies lack score/recommendation; Settings page bypasses the shared API client and mismatches the backend contract; `/api/settings/health` missing; wrong current password logs the user out; "Gate Security" users are stored as type `gate security`; Part Master search can show stale rows.
