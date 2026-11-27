import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { compareMigrationStatus, loadExpectedMigrations } from './schema-status.js';

const previous = '0095_history_retention_guard';
const target = '0096_chatwoot_live_claim_streak';

/** This maintenance entry point accepts precisely the reviewed transition. */
export async function applyLiveClaimStreak(url: string, apply: boolean) {
  const expected = await loadExpectedMigrations();
  const migration = expected.at(-1);
  if (migration?.name !== target || expected.at(-2)?.name !== previous) throw new Error('UNEXPECTED_IMAGE_MANIFEST');
  const sql = await readFile(new URL(`../../drizzle/migrations/${target}.sql`, import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== migration.hash) throw new Error('UNEXPECTED_MIGRATION_HASH');

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query('SET LOCAL ROLE jrc_migrator');
    await client.query('LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE');
    const ledger = await client.query<{hash:string;created_at:string}>(
      'SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at');
    const status = compareMigrationStatus(expected, ledger.rows.map(row => ({hash:row.hash,createdAt:Number(row.created_at)})));
    const column = await client.query(`SELECT a.atttypid='smallint'::regtype AND a.attnotnull AND a.atthasdef
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=a.attrelid
        AND c.conname='chatwoot_connections_live_claim_streak' AND c.convalidated) AS ready
      FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.chatwoot_connections'::regclass
        AND a.attname='live_claims_since_review' AND NOT a.attisdropped`);
    let result: 'CURRENT'|'READY'|'APPLIED';
    if (status.compatible && column.rows[0]?.ready === true) {
      result = 'CURRENT';
    } else {
      if (status.state !== 'PENDING' || status.appliedVersion !== previous || status.pending.length !== 1 ||
          status.pending[0] !== target || column.rowCount !== 0) throw new Error('MIGRATION_PRECONDITION_FAILED');
      result = 'READY';
      if (apply) {
        await client.query(sql);
        await client.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[migration.hash,migration.createdAt]);
        result = 'APPLIED';
      }
    }
    await client.query('COMMIT');
    return {result,migration:target,hash:migration.hash};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const url=process.env.MIGRATION_DATABASE_URL, mode=process.argv[2];
  if (!url || !['--check','--apply'].includes(mode ?? '') || process.argv.length !== 3) {
    console.error('Expected MIGRATION_DATABASE_URL and --check or --apply');
    process.exitCode=2;
  } else {
    try {
      console.log(JSON.stringify(await applyLiveClaimStreak(url,mode==='--apply')));
    } catch (error) {
      const known=['UNEXPECTED_IMAGE_MANIFEST','UNEXPECTED_MIGRATION_HASH','MIGRATION_PRECONDITION_FAILED'];
      const reason=error instanceof Error && known.includes(error.message)?error.message:
        error && typeof error==='object' && 'code' in error && /^[0-9A-Z]{5}$/.test(String(error.code))?String(error.code):'MIGRATION_FAILED';
      console.error(JSON.stringify({migration:target,result:'FAILED',reason}));
      process.exitCode=1;
    }
  }
}
