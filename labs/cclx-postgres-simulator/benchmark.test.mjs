import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from './benchmark.mjs';

test('finite event benchmark refuses missing lab flag, excess count, excess concurrency and external options',async()=>{
  for(const options of [{},{labOnly:true,counts:[401]},{labOnly:true,counts:[0]},{labOnly:true,counts:[3],concurrency:5},{labOnly:true,counts:[3],url:'https://example.test'}])
    await assert.rejects(runBenchmark(options),/LAB_ONLY_REQUIRED|INVALID_BENCHMARK_OPTIONS/);
});

test('three real PostgreSQL events reconcile response totals with persisted inbox and projections',async()=>{
  const report=await runBenchmark({labOnly:true,counts:[3],concurrency:2});
  assert.equal(report.kind,'CCLX_PG_FINITE_SYNTHETIC_EVENT_BENCHMARK');
  assert.equal(report.countsAre,'SYNTHETIC_EVENTS_NOT_SESSIONS');
  assert.deepEqual(report.totals,{uniqueEvents:3,requests:3,accepted:3,duplicates:0,errors:0});
  assert.deepEqual(report.rows,{inbox:3,projections:3,mediaReceipts:0});
  assert.equal(report.reconciled,true);
  assert.equal(report.endingBacklog,null);
  assert.equal(report.backlogMeaning,'NO_QUEUE_IN_THIS_LAB');
  assert.equal(report.concurrency,2);
  assert.equal(report.capacityGo,false);
  assert.equal(report.stages.length,1);
  for(const key of ['p50Ms','p95Ms','maxMs','totalMs'])assert.ok(Number.isFinite(report.stages[0][key])&&report.stages[0][key]>=0);
  assert.ok(report.stages[0].maxMs>=report.stages[0].p95Ms);
});
