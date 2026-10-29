import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { probeRequiredRuntimeSchema, RUNTIME_SCHEMA_BASELINE } from '../../src/db/runtime-schema.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 60_000);
afterAll(async () => { await db?.dispose(); });

it('accepts the fully migrated partner API under the actual app role', async () => {
  expect(RUNTIME_SCHEMA_BASELINE).toBe('0074_partner_media');
  const client = await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it.each([
  'DROP TABLE partner_event_cursor_state',
  'ALTER TABLE messaging_messages DROP COLUMN authorizing_api_key_id',
  'ALTER TABLE messaging_messages ALTER COLUMN authorizing_api_key_id SET NOT NULL',
  'ALTER TABLE messaging_messages ALTER COLUMN authorizing_api_key_id TYPE text USING authorizing_api_key_id::text',
  'ALTER TABLE partner_events NO FORCE ROW LEVEL SECURITY',
  'ALTER TABLE partner_event_deliveries DISABLE ROW LEVEL SECURITY',
  'ALTER TABLE partner_webhook_endpoints OWNER TO jrc_lifecycle',
  'DROP POLICY partner_tenant ON partner_event_cursor_state',
  'ALTER POLICY partner_tenant ON partner_events USING (true)',
  'ALTER POLICY partner_tenant ON partner_events WITH CHECK (true)',
  'ALTER POLICY partner_tenant ON partner_event_deliveries TO PUBLIC',
  'DROP POLICY lifecycle_migrator ON partner_events',
  'GRANT SELECT ON partner_events TO PUBLIC',
  'GRANT SELECT ON partner_events TO jrc_auth',
  'GRANT SELECT ON partner_event_deliveries TO jrc_platform',
  'GRANT SELECT ON partner_event_cursor_state TO jrc_lifecycle',
  'REVOKE SELECT ON partner_event_cursor_state FROM jrc_app',
  'GRANT INSERT ON partner_events TO jrc_app',
  'GRANT UPDATE ON partner_event_cursor_state TO jrc_app',
  'GRANT DELETE ON partner_event_deliveries TO jrc_app',
  'REVOKE INSERT ON partner_webhook_endpoints FROM jrc_app',
  'REVOKE UPDATE (encrypted_secret) ON partner_webhook_endpoints FROM jrc_app',
  'GRANT UPDATE (url) ON partner_webhook_endpoints TO jrc_app',
  'REVOKE UPDATE (lease_token) ON partner_event_deliveries FROM jrc_app',
  'GRANT UPDATE (event_id) ON partner_event_deliveries TO jrc_app',
  'ALTER TABLE messaging_messages DISABLE TRIGGER partner_message_event',
  'DROP TRIGGER partner_connection_event ON instances',
  'DROP TRIGGER partner_meta_connection_event ON meta_connections',
  'ALTER FUNCTION partner_capture_event() SECURITY INVOKER',
  'GRANT EXECUTE ON FUNCTION partner_capture_event() TO jrc_app',
  'GRANT EXECUTE ON FUNCTION partner_publish_events() TO PUBLIC',
  'DROP FUNCTION partner_event_catalogue_ready()',
  'ALTER FUNCTION partner_event_catalogue_ready() SECURITY INVOKER',
  'GRANT EXECUTE ON FUNCTION partner_event_catalogue_ready() TO PUBLIC',
  'GRANT EXECUTE ON FUNCTION partner_event_worker_organizations(uuid,integer) TO jrc_auth',
  'REVOKE EXECUTE ON FUNCTION partner_publish_events() FROM jrc_app',
  'ALTER FUNCTION partner_event_worker_organizations(uuid,integer) SECURITY INVOKER',
  'GRANT USAGE ON SEQUENCE partner_event_order_seq TO jrc_app',
  "DELETE FROM lifecycle_purge_catalogue WHERE table_name='partner_event_cursor_state'",
])('rejects a weakened partner API schema: %s', async change => {
  const client = await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(change);
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(false);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
