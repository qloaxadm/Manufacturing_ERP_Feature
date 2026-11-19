# Manufacturing ERP – Complete Walkthrough & Check Guide

Everything below was taken from the code in this repo (backend controllers/services, frontend routes/pages).
Items marked **(not verified)** were read in code but not exercised by hand or by the e2e suite.

---

## 1. What the system is

A barcode-driven dispatch tracker for a factory: **Part → Packing → Box → Invoice → Gate verification → Gate-out report**, with an AI layer (stock forecast, security anomalies, gate-risk scoring, daily briefing, "Ask ERP" assistant) that is **read-only** (see AGENTS.md: AI never writes to the DB; humans confirm).

| Layer | Tech | Local port |
|---|---|---|
| Frontend | React 18 + Vite + react-router | 3000 (`/api` proxied to 5001) |
| Backend | NestJS 10, TypeORM, JWT, role guard | 5001 |
| Database | MySQL 8 (Docker `erp-mysql`, db `barcode`) – or Supabase/Postgres via `DB_TYPE=postgres` + `DATABASE_URL` | 3306 |
| Production | Backend on Render (`render.yaml`, health check `/api/health`), frontend on Vercel (`vercel.json`) | – |

## 2. Start it

| # | Where | Command |
|---|---|---|
| 1 | any | `docker start erp-mysql` |
| 2 | `backend/` | `npm run start:dev`  (NOT `npm run dev` – that runs the compiled `dist/`, which needs `npm run build` first) |
| 3 | `frontend/` | `npm run dev` → http://localhost:3000 |

Root shortcuts exist too: `npm run dev:backend`, `npm run dev:frontend`, `npm run build:backend`, `npm run build:frontend`, `npm run migrate:supabase`.
Health check: http://localhost:5001/api/health

## 3. Accounts (seeded)

| Role (`type`) | Email | Password | Sidebar areas |
|---|---|---|---|
| admin | admin@admin.com | admin | everything |
| packing (DPR) | dpr@talbros.com | dpr | Part Master, Part Stock, Packing |
| box (FGS) | fgs@talbros.com | fgs | Box, Customer list (read) |
| invoice | invoice@talbros.com | invoice | Invoice |
| gate | gate@talbros.com | gate | Verify Invoice, Gate-Out Report |

All roles also get: Dashboard, Profile, Settings, Notifications, Activity History, Ask ERP.

**Role switcher (top bar):** the dropdown "Active Role" does not switch a role – it logs in again as the matching demo account using passwords hard-coded in the frontend (`AuthContext.tsx`). Handy for demos, but it only works while those demo accounts keep their default passwords, and it is a security smell for production.

## 4. Role → route → API map

| Route | Page | Roles | Backend |
|---|---|---|---|
| `/login` | Login | public | `POST /api/auth/login` |
| `/index`, `/dashboard` | Dashboard | all | `GET /api/dashboard/stats` |
| `/profile` | My Profile | all | `GET /auth/profile-details`, `PUT /auth/profile`, `PUT /auth/change-password` |
| `/settings` | Settings & Preferences | all (tabs vary) | `GET/PUT /api/settings` (see §9) |
| `/notifications` | Notification & Alert Center | all | `/api/notifications` (list, unread-count, summary, read, mark-all-read, resolve) |
| `/activity_history` | Activity History & Audit Trail | all | `GET /api/activity-log`, `/stats` |
| `/erp_users` | System User Management | admin | `GET/POST/DELETE /api/users` |
| `/part_master` | Part Master | admin, packing | `/api/parts` (list, create, patch, delete[?force], add-stock, history, mark-finished) |
| `/part_stock` | Part Stock | admin, packing | `GET /parts/stock`, `DELETE /parts/:id` |
| `/customer` | Customer | admin (box read-only via API) | `/api/customers` |
| `/create_packing` | Create Packing | admin, packing | `POST /packing/single` |
| `/create_packing_bulk` | Create Packing Bulk | admin, packing | `POST /packing/bulk` |
| `/view_packing` | Packing Ledger | admin, packing | `GET/DELETE /packing` |
| `/view_packing_by_id/:id` | Packing detail + label | admin, packing | `GET /packing/:id` |
| `/create_box` | Create Box | admin, box | `POST/GET /boxes` |
| `/view_box` | View Box | admin, box | `GET /boxes`, `POST /boxes` |
| `/add_packing_to_box/:id` | Scan packings into box, lock | admin, box | `GET /boxes/:id`, `POST /boxes/add-packing`, `POST /boxes/lock` |
| `/create_invoice` | Create Invoice | admin, invoice | `POST /invoices` |
| `/view_invoice` | View Invoice | admin, invoice | `GET/DELETE /invoices` |
| `/add_box_to_invoice/:id` | Scan boxes into invoice, lock | admin, invoice | `GET /invoices/:id`, `POST /invoices/add-box`, `/lock` |
| `/verify_invoice` | Gate verification list | admin, gate | `GET /verification`, `POST /verification/start`, `POST /verification/return` |
| `/add_box_to_invoice_verify/:id` | Gate scanning + gate pass | admin, gate | `GET /verification/:id`, `POST /verification/scan-box` |
| `/gate_out_report` | Gate Out Report | admin, gate | `GET /reports/gate-out` |
| `/ai_stock_intelligence` | AI Stock Intelligence | admin | `GET /ai/stock-intelligence` |
| `/ai_security` | AI Security & Anomaly Detection | admin | `GET /ai/security-anomalies` |
| `/ai_gate_risk` | AI Gate Risk Hub | admin | `/ai/gate-risk/*` (dashboard, transactions, transaction/:id, review, config) |
| `/ai_security_briefing` | AI Daily Security Briefing | admin | `/ai/security-briefing/*` |
| Ask ERP drawer | floating button / Ctrl+K | all | `POST /ai/ask`, `GET /ai/ask/suggestions`, `GET /ai/status` |

Redirect shortcuts: `/verification`→`/verify_invoice`, `/gate_risk`→`/ai_gate_risk`, `/security`→`/ai_security`, `/security_briefing`→`/ai_security_briefing`, unknown paths → `/index`.
Backend-only: `GET /api/health` (public), `POST /api/barcode/validate` & `/bulk-validate`, gate-risk `analyze`/`match/:id`/`log-scan`, `POST /ai/test-gemini` (admin), notifications `system-event`/`trigger-test`.

## 5. Main business flow – step by step

**0. Admin master data**
- Customer: add (name, details, optional logo image), edit, export Excel.
- Part Master: add part (number + description must be unique), **Add Stock** (needs quantity > 0 **and supplier name**), **History** (stock added/finished log), edit, delete (if the part already has packings/boxes/invoices the first delete is refused; admin can confirm a **force delete**).
- Users: add/delete users and assign role.
- Part Stock: stock per part (FG rack / box pack / invoice stock), delete.

**1. Packing (DPR)** – `/create_packing` or `/create_packing_bulk`
- Pick part, qty, shift → packing barcode `1xxxxx`; part stock decreases; barcode label view / print.
- Bulk: N packings in one go; Generate is disabled if the total exceeds stock.
- When stock hits 0 a "Stock Depleted" notification is raised.
- Ledger (`/view_packing`): search, date filter, Excel export, delete.

**2. Box (FGS)** – `/create_box` → `/add_packing_to_box/:id`
- Box name = part number, barcode `2xxxxx`.
- Scan packing barcodes in. Rejections: different part ("Part Id Not Matched"), already used, box already locked.
- Cannot lock an empty box. Lock → box turns LOCKED, no more edits.

**3. Invoice (Billing)** – `/create_invoice` → `/add_box_to_invoice/:id`
- Invoice number ≤ **20 characters** and unique; barcode `3xxxxx`.
- **Security hold:** if the requested qty is > 5000 **or** more than current part stock, the invoice is created as `waiting_for_approval`; gate verification is blocked until an admin resolves the alert in the Notification Center (this approves the invoice).
- Scan boxes in. Rejections: box of a different part (405), exceeds invoice qty (406), box used in another invoice, invoice already locked.
- Lock invoice once qty matches. Invoices can be deleted from `/view_invoice`.

**4. Gate (Security)** – `/verify_invoice` → `/add_box_to_invoice_verify/:id`
- Scan/enter invoice barcode or number → creates a verification session. Refused if: invoice not found, on security hold, **not locked**, or already in verification.
- Scan each box. Rejections: box not on this invoice, box already scanned.
- Row shows an **AI Gate Risk** score. When all boxes are scanned, a **Gate Clearance code** (`<invoice_number>4000<match id>`) and a printable **Gate Pass** modal appear.
- **Return Invoice:** deletes the verification session and its box matches, sets invoice back to `pending`, writes an audit row.
- Repeated rejected scans raise a notification and are logged for the AI gate-risk engine.

**5. Gate-Out Report** – `/gate_out_report`: cleared dispatches, date-range filter, Excel export, print report.

## 6. Shared pages & cross-cutting features

| Feature | Where | What to check |
|---|---|---|
| Notifications | `/notifications`, bell in top bar, sidebar blinking dot, toast pop-ups | Filter/resolve alerts, mark all read, unread count |
| Activity history | `/activity_history` | Rows for every action; filters; stats cards; Excel export; detail panel |
| Language | Top bar EN / HI / MR | Sidebar & main labels change (Hindi/Marathi dictionary is in `PreferencesContext.tsx`) |
| Theme / font size / sound / voice prompts | Settings → Preferences | Persisted per browser **(not verified)** |
| Scanner mode (`hardware` / `camera`) + auto-scan | Settings → Scanner | Setting exists in preferences; **no camera-scanning code was found in the pages** (html5-qrcode is a dependency but never imported) – only USB/keyboard scanners are actually supported |
| Profile photo | Profile | Stored in the browser (`localStorage`) only, not on the server |
| Customer logo | Customer add/edit | Image file picker |
| Excel export | Part Master, Part Stock, Customer, Packing, Box, Invoice, Verify, Gate-Out, Activity, AI pages | File downloads |
| PDF export | AI Stock Intelligence ("Production Plan"), AI Daily Briefing | `jsPDF` download |
| Barcode label | `BarcodeCard` (PNG download via html2canvas), packing sheet print (bulk), gate pass print, gate-out report print | Opens print dialogs / saves PNG – needs a real browser & printer |
| Ctrl + K | anywhere | Opens Ask ERP |
| Mobile | < 992 px | Sidebar becomes a drawer; swipe from left edge opens it |

## 7. AI features (all read-only)

| Page | Check |
|---|---|
| Stock Intelligence | Per-part trend, reason, risk; Production-plan PDF/Excel |
| Security anomalies | Anomaly list (known gap: no risk score/recommendation) |
| Gate Risk Hub | Transactions with score 0-100, level, primary signal, review status; detail "evidence chain"; admin review; configurable thresholds (`/gate-risk/config`); Excel audit report |
| Daily Briefing | Generate briefing for a date, history, per-event review, sign-off, PDF/Excel |
| Ask ERP | Type a question or use suggestions; answers come from rules, or Gemini if `GEMINI_API_KEY` is set |

Without `GEMINI_API_KEY` everything runs on the deterministic rule engine. With a key, `GEMINI_MODEL` (default `gemini-flash-latest`) is used **(not verified)**.
AGENTS.md rule: every AI result must carry what / why / evidence / score / recommended review – the suite flags places where this is missing.

## 8. Settings page tabs (by role)

Preferences (all) · Scanner (admin, packing, box, gate) · Packing (admin, packing) · Box (admin, box) · Invoice (admin, invoice) · Gate (admin, gate) · Company (admin) · Barcode (admin) · System (admin).
**Known problem:** this page calls the server with plain `axios` and `/api/settings` URLs, so in production-style setups (API on another origin) it cannot reach the backend and **saving does nothing**.

## 9. Deployment & database

- **Render** (`render.yaml`): build `npm install && npm run build`, start `npm start`, health `/api/health`; env: `DB_TYPE=postgres`, `DATABASE_URL` (Supabase *session pooler* string), `DB_SSL=true`, `JWT_SECRET` (auto), `FRONTEND_URL`, `CORS_ORIGINS`, `GEMINI_API_KEY`, `GEMINI_MODEL`.
- **Vercel** (`vercel.json`): builds `frontend/`, outputs `frontend/dist`, SPA rewrite to `/index.html`. Set `VITE_API_URL` to the Render URL.
- **Supabase migration:** `npm run migrate:supabase` copies MySQL data to Postgres. See `DEPLOYMENT_GUIDE.md`.
- Seed data: `Dump20260919.sql` (5 users, parts, customers).

## 10. Existing project docs (already in the repo)

| File | What it is |
|---|---|
| `docs/MANUAL_TEST_EXECUTION_CHECKLIST.md` | 20-category manual UAT sheet (auth, masters, packing, box, invoice, gate, returns, reports, scanners, negatives, sessions) with blank Pass/Fail columns – **use this for hand-testing** |
| `docs/FULL_REGRESSION_TEST_REPORT.md`, `RETEST_REPORT.md`, `MANUAL_ONE_PART_E2E_TEST_REPORT.md`, `BOX_PACKING_BUG_FIX_AND_WORKFLOW_VERIFICATION.md`, `FULL_LEGACY_MODULE_REGRESSION_MATRIX.md`, `LEGACY_VS_NEW_*` | Earlier test/comparison reports against the legacy system |
| `AI_FEATURE_PLAN.md`, `TEAM_AI_ARCH_PLAN.md` | AI roadmap and architecture. The plan also lists **camera OCR bulk packing** and **Face-ID proof of scan** – these are *planned*, not implemented |
| `DEPLOYMENT_GUIDE.md` | Render/Vercel/Supabase steps |
| `DAILY_TASK_REPORT.md` | Daily progress notes |
| `e2e/README.md` | Automated Playwright suite (289 tests) |

## 11. Known bugs (documented as expected-failure tests in `e2e/`)

1. Non-admin actions are attributed to user 3 (admin) in the audit log (`user.id` vs token `userId`).
2. `/api/users` returns plaintext passwords.
3. Barcode validation can't see already-boxed packings.
4. Some empty POST bodies return HTTP 500 instead of 400.
5. Audit rows have no `user_email`.
6. Security anomalies lack risk score / recommendation (breaks AGENTS.md rule 4).
7. Settings page uses raw `axios` and wrong request/response shape; `/api/settings/health` does not exist.
8. Wrong current password on Profile logs the user out.
9. User created as "Gate Security" is stored as type `gate security`, so gate screens reject them.
10. Part Master search can show stale rows when a slow response arrives late.
11. Role switcher relies on hard-coded demo passwords.

## 12. What cannot be checked without hardware / external services

USB barcode scanner behaviour, thermal label printing, browser print dialogs, real Gemini responses, Supabase/Render/Vercel deployment.
