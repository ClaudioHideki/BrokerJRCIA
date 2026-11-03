import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { mkdir, writeFile } from 'node:fs/promises';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => {
  db = await attendanceDatabase();
  // Canonical schema-only evidence from this owned fixture, never production data.
  const constraints = (await db.database.pool.query(`SELECT conname,pg_get_constraintdef(oid) AS definition,
    md5(pg_get_constraintdef(oid)) AS hash FROM pg_constraint
    WHERE conrelid IN ('central_runtime_events'::regclass,'central_flow_input_media'::regclass) ORDER BY conname`)).rows;
  const policies = (await db.database.pool.query(`SELECT polname,pg_get_expr(polqual,polrelid) AS using_expression,
    pg_get_expr(polwithcheck,polrelid) AS check_expression FROM pg_policy WHERE polrelid='central_flow_input_media'::regclass ORDER BY polname`)).rows;
  await mkdir('.sessions', { recursive: true });
  await writeFile('.sessions/central-media-schema-baseline.json', JSON.stringify({ constraints, policies }, null, 2) + '\n');
});
afterAll(async () => { await db?.dispose(); });

it('registers canonical attachment references in the lifecycle inventory', async () => {
  const rows = await db.database.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name='central_flow_input_media'");
  expect(rows.rows).toEqual([{ table_name: 'central_flow_input_media' }]);
});

it('refuses readiness for missing or weakened canonical attachment guards', async () => {
  const probe = async (corrupt?: string) => {
    const client = await db.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jrc_migrator');
      if (corrupt) await client.query(corrupt);
      await client.query('SET LOCAL ROLE jrc_app');
      return await probeRequiredRuntimeSchema(sql => client.query(sql));
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  expect(await probe()).toBe(true);
  for (const corruption of [
    'DROP TABLE central_flow_input_media',
    'ALTER TABLE central_flow_input_media NO FORCE ROW LEVEL SECURITY',
    'DROP POLICY central_tenant ON central_flow_input_media',
    'DROP POLICY central_tenant ON central_flow_input_media; CREATE POLICY central_tenant ON central_flow_input_media TO jrc_app USING(true) WITH CHECK(true)',
    'GRANT UPDATE ON central_flow_input_media TO jrc_app',
    'GRANT SELECT ON central_flow_input_media TO PUBLIC',
    'REVOKE INSERT ON central_flow_input_media FROM jrc_app',
    'ALTER TABLE central_flow_input_media DISABLE TRIGGER central_flow_input_media_immutable',
    "CREATE OR REPLACE FUNCTION reject_central_flow_input_media_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$",
    'ALTER TABLE central_flow_input_media DROP CONSTRAINT central_flow_media_event_fk',
    'ALTER TABLE central_flow_input_media DROP CONSTRAINT central_flow_media_conversation_fk',
    'ALTER TABLE central_flow_input_media DROP CONSTRAINT central_flow_media_connection_fk',
    'DROP INDEX central_flow_input_media_scope',
    'DROP INDEX central_flow_input_media_scope; CREATE INDEX central_flow_input_media_scope ON central_flow_input_media(organization_id,id)',
    'ALTER TABLE central_runtime_events DROP COLUMN media_input CASCADE',
    'ALTER TABLE central_runtime_events DROP CONSTRAINT central_runtime_events_media_input_check',
    'ALTER TABLE central_runtime_events DROP CONSTRAINT central_runtime_events_media_input_check; ALTER TABLE central_runtime_events ADD CONSTRAINT central_runtime_events_media_input_check CHECK(true)',
    ...['file_name', 'origin', 'account_id', 'inbox_id', 'contact_id', 'destination_revision', 'credential_version', 'owner_revision', 'kind', 'created_at']
      .map(column => `ALTER TABLE central_flow_input_media DROP COLUMN ${column}`),
    'ALTER TABLE central_flow_input_media ALTER COLUMN file_name TYPE varchar(255)',
    'ALTER TABLE central_flow_input_media ALTER COLUMN credential_version DROP NOT NULL',
    'ALTER TABLE central_flow_input_media ALTER COLUMN created_at DROP DEFAULT',
    'ALTER TABLE central_flow_input_media ALTER COLUMN id DROP DEFAULT',
    'ALTER TABLE central_flow_input_media DROP CONSTRAINT central_flow_input_media_kind_check',
    'ALTER TABLE central_flow_input_media DROP CONSTRAINT central_flow_input_media_credential_version_check; ALTER TABLE central_flow_input_media ADD CONSTRAINT central_flow_input_media_credential_version_check CHECK(true)',
  ]) expect.soft(await probe(corruption), corruption).toBe(false);
});
