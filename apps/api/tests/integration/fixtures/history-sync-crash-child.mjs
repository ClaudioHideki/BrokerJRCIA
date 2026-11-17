// Synthetic-only fixture. Exits are controlled by the parent after the PostgreSQL commit.
import { Pool } from 'pg';
import { createHistorySyncStore } from '../../../dist/modules/history-sync/store.js';
import { withOrganizationTransaction } from '../../../dist/db/tenant-transaction.js';

const input=JSON.parse(process.env.HISTORY_SYNC_CRASH_FIXTURE);
const pool=new Pool({connectionString:process.env.HISTORY_SYNC_CRASH_DATABASE,max:1});
const store=createHistorySyncStore({encryptionKey:Buffer.alloc(32,73),maxStagedBytes:2_000_000,
  transact:(org,work)=>withOrganizationTransaction(pool,org,work),assertCurrentScope:async()=>{}});
await store.acceptChunk(input.scope,input.runId,input.chunk,new Date(input.now));
// No correlated HTTP ACK has been sent. Parent kills this process at this boundary.
process.stdout.write('COMMITTED\n');
setInterval(()=>{},1000);
