import {beforeEach,describe,it,expect,vi} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {scanJrcHistory} from '../scripts/security/scan-jrc-history.mjs';
import {TEST_SECRET_CANARIES} from '../scripts/security/secret-canaries.mjs';

vi.mock('node:child_process',()=>({execFileSync:vi.fn(),spawnSync:vi.fn()}));
const commits=Array.from({length:131},(_,i)=>(i+1).toString(16).padStart(8,'0')+'a'.repeat(32));
const fingerprintSecret='isolated-history-scanner-test-secret';
beforeEach(()=>{vi.clearAllMocks();vi.mocked(execFileSync).mockReturnValue(commits.join('\n'));});
describe('bounded complete Git history scan',()=>{
 it('retains findings at both ends of a history that cannot fit one grep invocation',async()=>{
  const visited=new Set();
  vi.mocked(spawnSync).mockImplementation((_command,args)=>{
   const refs=args.filter(x=>/^[0-9a-f]{40}$/.test(String(x)));
   if(refs.length>64)return {status:null,error:new Error('ETIMEDOUT')} as any;
   refs.forEach(x=>visited.add(x));
   const hits=refs.filter(x=>x===commits[0]||x===commits.at(-1));
   return {status:hits.length?0:1,stdout:hits.map(x=>x+':app.ts:1:'+TEST_SECRET_CANARIES.apiKey).join('\n')} as any;
  });
  const findings=await scanJrcHistory({rootDirectory:process.cwd(),fingerprintSecret});
  expect(visited).toEqual(new Set(commits));
  expect(new Set(findings.map(x=>x.sha))).toEqual(new Set([commits[0],commits.at(-1)].map(x=>x.slice(0,12))));
  expect(JSON.stringify(findings)).not.toContain(TEST_SECRET_CANARIES.apiKey);
 });
 it('fails closed without exposing subprocess stderr when any batch fails',async()=>{
  vi.mocked(spawnSync).mockReturnValue({status:2,stderr:TEST_SECRET_CANARIES.apiKey} as any);
  await expect(scanJrcHistory({rootDirectory:process.cwd(),fingerprintSecret})).rejects.toThrow(/^Sanitized Git history scan failed$/);
 });
});
