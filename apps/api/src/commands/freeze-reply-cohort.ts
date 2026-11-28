import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import { freezeReplyCohort } from '../modules/integrations/freeze-reply-cohort.js';

async function run() {
  const { values } = parseArgs({ options: { org:{type:'string'}, integration:{type:'string'},
    manifest:{type:'string'}, apply:{type:'string'} } });
  const org = z.uuid().parse(values.org), integration = z.uuid().parse(values.integration);
  const bytes = await readFile(z.string().min(1).parse(values.manifest));
  const scope = z.object({ organizationId:z.uuid(), integrationId:z.uuid() }).parse(JSON.parse(bytes.toString('utf8')));
  if (scope.organizationId!==org || scope.integrationId!==integration) throw new Error('REPLY_COHORT_SCOPE_CHANGED');
  if (values.apply!==undefined && values.apply!==createHash('sha256').update(bytes).digest('hex'))
    throw new Error('REPLY_COHORT_DIGEST_MISMATCH');
  const review = (process.env.CHATWOOT_DIRECT_TRANSPORT_REVIEW_INTEGRATIONS??'').split(',').map(id=>id.trim());
  if (!review.includes(integration)) throw new Error('REPLY_COHORT_GLOBAL_HOLD_REQUIRED');
  const pool = new Pool({ connectionString:z.url().parse(process.env.DATABASE_URL), max:1, connectionTimeoutMillis:5000,
    statement_timeout:20000, lock_timeout:5000 });
  const preview = new Error('REPLY_COHORT_PREVIEW');
  let summary: Awaited<ReturnType<typeof freezeReplyCohort>> | undefined;
  try {
    await withOrganizationTransaction(pool,org,async tx => {
      summary = await freezeReplyCohort(tx,bytes);
      if (values.apply===undefined) throw preview;
    });
  } catch (error) {
    if (error!==preview) throw error;
  } finally { await pool.end(); }
  process.stdout.write(JSON.stringify({mode:values.apply===undefined?'preview':'applied',...summary})+'\n');
}
run().catch((error:unknown) => {
  process.stderr.write((error instanceof Error && /^REPLY_COHORT_[A-Z_]+$/.test(error.message)?error.message:'REPLY_COHORT_REJECTED')+'\n');
  process.exitCode=1;
});
