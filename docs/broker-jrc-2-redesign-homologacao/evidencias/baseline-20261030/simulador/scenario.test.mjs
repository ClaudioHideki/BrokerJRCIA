import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenario = new URL('scenario.mjs', import.meta.url);
test('plan adds progressive 50/100/200/400 gates and keeps 900 preparation only', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(scenario), '--lab-only', '--plan'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.capacityValidated, false);
  assert.deepEqual(plan.gates.map(g => g.sessions), [50, 100, 200, 400, 900]);
  assert.equal(plan.gates[4].state, 'PREPARATION_ONLY');
  assert.equal(plan.logicalMessagesPerDay, 250000);
});
test('smoke persists real bytes, survives ACK loss/restart and keeps all counts reconciled', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(scenario), '--lab-only', '--smoke'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.capacityValidated, false);
  assert.equal(report.acceptedUnique, 8);
  assert.equal(report.inbox, 8);
  assert.equal(report.projections, 8);
  assert.equal(report.mediaReceipts, 1);
  assert.equal(report.recoveredLostEventAck, true);
  assert.equal(report.recoveredLostMediaAck, true);
  assert.equal(report.bytesReadbackVerified, true);
});
test('scenario refuses production, external target, missing lab flag and unknown options', () => {
  for (const args of [[], ['--lab-only', '--smoke', '--url=https://example.com'], ['--lab-only', '--load'], ['--plan']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(scenario), ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAB_ONLY_REQUIRED|LAB_ARGUMENTS_ONLY/);
  }
  const production = spawnSync(process.execPath, [fileURLToPath(scenario), '--lab-only', '--smoke'],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  assert.notEqual(production.status, 0); assert.match(production.stderr, /PRODUCTION_REFUSED/);
});
