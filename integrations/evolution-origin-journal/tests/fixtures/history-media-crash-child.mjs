// Disposable-process verification only. No production configuration is read.
import {Pool} from 'pg';
import {createOriginJournal} from '../../src/journal.mjs';
import {validateTestAdminUrl} from '../lab-database.mjs';

process.once('message',async input=>{
  let pool;
  try {
    const url=validateTestAdminUrl(input.connectionString);
    pool=new Pool({connectionString:url.href,max:1});
    const journal=createOriginJournal({pool,encryptionKey:Buffer.alloc(32,94),history:{maxStagedBytes:2000000,captureMedia:true}}).history;
    await journal.append(journal.prepare(input.scope,input.runId,input.event,{
      provenance:'SOCKET',captureId:input.captureId,capturedAt:new Date(input.capturedAt),startOrdinal:0,
    }));
    process.send({kind:'COMMITTED'});
    // Parent kills this process after COMMIT, before any delivery or ACK.
  } catch {
    process.send?.({kind:'SYNTHETIC_CHILD_FAILED'});
    await pool?.end();process.exitCode=1;process.disconnect?.();
  }
});
