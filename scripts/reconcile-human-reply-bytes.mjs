import { readFile } from 'node:fs/promises';
import pg from 'pg';

const mode = process.argv[2] ?? '--review';
if (process.argv.length > 3 || !['--review', '--apply'].includes(mode)) {
  throw new Error('Expected --review or --apply and one sanitized proof on stdin');
}
const apply = mode === '--apply';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const proof = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const full = await readFile(new URL('./reconcile-human-reply-bytes.sql', import.meta.url), 'utf8');
const [review, mutation] = full.split('-- APPLY_RECONCILIATION');
if (!mutation) throw new Error('Reconciliation SQL incomplete');
const query = apply ? full : review + ' SELECT EXISTS(SELECT FROM eligible) AS eligible, false AS resumed';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SELECT set_config('app.organization_id',$1,true)", [proof.organization_id]);
  const result = await client.query(query, apply ? [proof, true] : [proof]);
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify(result.rows[0]) + '\n');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  process.stderr.write('Reconciliation failed (' + (error.code ?? 'ERROR') + ')\n');
  process.exitCode = 1;
} finally {
  await client.end();
}
