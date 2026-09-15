import { Client } from 'pg';
import { runMigrations } from '../../apps/api/dist/db/migrate.js';

// Explicit one-off maintenance container. Never executed by API or worker startup.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL required');
await runMigrations(url);
const client = new Client({ connectionString: url });
await client.connect();
try {
  for (const [role, variable] of [['jrc_app', 'JRC_APP_PASSWORD'], ['jrc_auth', 'JRC_AUTH_PASSWORD'], ['jrc_platform', 'JRC_PLATFORM_PASSWORD']]) {
    const password = process.env[variable];
    if (!password || password.length < 32) throw new Error(`${variable} requires at least 32 characters`);
    const result = await client.query('select format(\'ALTER ROLE %I PASSWORD %L\', $1::text, $2::text) as command', [role, password]);
    await client.query(result.rows[0].command);
  }
  const enginePassword = process.env.EVOLUTION_DB_PASSWORD;
  if (!enginePassword || enginePassword.length < 32) throw new Error('EVOLUTION_DB_PASSWORD required');
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='jrc_evolution') THEN CREATE ROLE jrc_evolution LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$");
  const secret = await client.query("select format('ALTER ROLE jrc_evolution PASSWORD %L', $1::text) as command", [enginePassword]);
  await client.query(secret.rows[0].command);
  const db = await client.query("select 1 from pg_database where datname='jrc_evolution'");
  if (!db.rowCount) await client.query('CREATE DATABASE jrc_evolution OWNER jrc_evolution');
  process.stdout.write('Schema and dedicated roles provisioned.\n');
} finally { await client.end(); }
