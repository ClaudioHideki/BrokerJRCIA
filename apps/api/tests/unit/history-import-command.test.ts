import {describe,expect,it} from 'vitest';
import {runHistoryImportWorker} from '../../src/commands/history-import-worker.js';
describe('isolated history worker entrypoint',()=>{
 it('rejects privileged database identities before opening a connection',async()=>{
  await expect(runHistoryImportWorker({DATABASE_URL:'postgresql://postgres@127.0.0.1:1/fixture'})).rejects.toThrow('HISTORY_WORKER_REQUIRES_APP_ROLE');
 });
 it('does not connect or execute historical work when no source is configured',async()=>{
  await expect(runHistoryImportWorker({DATABASE_URL:'postgresql://jrc_app@127.0.0.1:1/fixture'})).resolves.toBeUndefined();
 });
});
