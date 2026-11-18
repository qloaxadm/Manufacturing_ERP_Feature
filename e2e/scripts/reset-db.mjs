/**
 * Recreates the isolated E2E database from the repo's MySQL dump.
 *
 * Runs as part of the test-backend start command (see playwright.config.ts), i.e. BEFORE the
 * backend connects, so the backend always boots against a fresh, known baseline.
 *
 * SAFETY: refuses to touch any database that is not clearly an E2E database, and never the
 * database configured as the dev DB in backend/.env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// Dev credentials are reused only as a convenience fallback for host/user/password.
const devEnvPath = path.join(root, 'backend', '.env');
const devEnv = fs.existsSync(devEnvPath) ? dotenv.parse(fs.readFileSync(devEnvPath)) : {};

const cfg = {
  host: process.env.E2E_DB_HOST || devEnv.DB_HOST || '127.0.0.1',
  port: Number(process.env.E2E_DB_PORT || devEnv.DB_PORT || 3306),
  user: process.env.E2E_DB_USER || devEnv.DB_USER || 'root',
  password: process.env.E2E_DB_PASS ?? devEnv.DB_PASS ?? '',
  database: process.env.E2E_DB_NAME || 'barcode_e2e',
};

if (!/e2e|test/i.test(cfg.database)) {
  console.error(`[reset-db] Refusing to reset "${cfg.database}": the name must contain "e2e" or "test".`);
  process.exit(1);
}
if (devEnv.DB_NAME && devEnv.DB_NAME.toLowerCase() === cfg.database.toLowerCase()) {
  console.error(`[reset-db] Refusing to reset "${cfg.database}": it is the dev database in backend/.env.`);
  process.exit(1);
}

const dumpPath = process.env.E2E_DUMP_PATH || path.join(root, 'Dump20260919.sql');
if (!fs.existsSync(dumpPath)) {
  console.error(`[reset-db] SQL dump not found: ${dumpPath}`);
  process.exit(1);
}

const admin = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  multipleStatements: true,
});

try {
  await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
  await admin.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${cfg.database}\``);
  await admin.query(fs.readFileSync(dumpPath, 'utf8'));
  const [rows] = await admin.query('SELECT COUNT(*) AS n FROM userinfo');
  console.log(`[reset-db] "${cfg.database}" rebuilt from ${path.basename(dumpPath)} (${rows[0].n} users).`);
} catch (err) {
  console.error('[reset-db] Failed:', err.message);
  process.exitCode = 1;
} finally {
  await admin.end();
}
