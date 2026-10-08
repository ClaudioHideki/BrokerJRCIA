import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const moduleUrl = new URL('../scripts/operations/capacity-report.mjs', import.meta.url);
const run = promisify(execFile);
const input = {
  schemaVersion: 1,
  resources: { cpuCores: 8, ramBytes: 17179869184, diskBytes: 1099511627776 },
  workload: {
    organizations: 500, connections: 10000, monthlyConversations: 250000,
    messagesPerConversation: 12, daysPerMonth: 30, peakMultiplier: 5,
    mediaFraction: 0.2, meanMediaBytes: 1000000, retentionDays: 90,
  },
  pools: {
    maxConnections: 100, reservedConnections: 20,
    components: [
      { name: 'API', replicas: 2, maxPerReplica: 10 },
      { name: 'MESSAGING', replicas: 3, maxPerReplica: 4 },
      { name: 'EVOLUTION', replicas: 1, maxPerReplica: 10 },
    ],
  },
};
const copy = () => structuredClone(input);
const subject = () => import(moduleUrl.href);

it('estimates total supplied conversations without multiplying the volume by every organization', async () => {
  const { estimateWorkload } = await subject();
  const result = estimateWorkload(input);
  expect(result.monthlyMessages).toBe(3000000);
  expect(result.averageMessagesPerSecond).toBeCloseTo(1.1574074074, 9);
  expect(result.peakMessagesPerSecond).toBeCloseTo(5.7870370370, 9);
  expect(result.connectionsPerOrganization).toBe(20);
  expect(result.averageMediaBytesPerDay).toBe(20000000000);
  expect(result.retainedMediaBytes).toBe(1800000000000);
});

it('keeps declared targets separate and never treats a complete inventory as validated capacity', async () => {
  const { buildCapacityReport } = await subject();
  const fixture = copy(); fixture.workload.organizations = 5; fixture.workload.connections = 12;
  const result = buildCapacityReport(fixture);
  expect(result.status).toBe('PLANNING_ONLY');
  expect(result.capacityValidated).toBe(false);
  expect(result.targets).toMatchObject({ organizations: 500, connections: 10000 });
  expect(result.observations.workload.organizations).toEqual({ value: 5, source: 'OPERATOR_INPUT' });
  expect(result.observations.resources.cpuCores).toEqual({ value: 8, source: 'OPERATOR_INPUT' });
  expect(result.missing).toEqual([]);
});

it('calculates SQL headroom from all supplied replicas and reports a negative budget honestly', async () => {
  const { buildCapacityReport } = await subject();
  expect(buildCapacityReport(input).sqlBudget).toMatchObject({
    configuredConnections: 42, availableConnections: 80, headroomConnections: 38, withinConfiguredBudget: true,
  });
  const fixture = copy(); fixture.pools.maxConnections = 50;
  expect(buildCapacityReport(fixture).sqlBudget).toMatchObject({
    configuredConnections: 42, availableConnections: 30, headroomConnections: -12, withinConfiguredBudget: false,
  });
  expect(buildCapacityReport(fixture).capacityValidated).toBe(false);
});

it('marks absent resources or pools as partial instead of turning unknown observations into zero', async () => {
  const { buildCapacityReport } = await subject();
  const fixture = copy(); delete fixture.resources; delete fixture.pools;
  const result = buildCapacityReport(fixture);
  expect(result.status).toBe('PARTIAL');
  expect(result.missing).toEqual(['resources.cpuCores', 'resources.ramBytes', 'resources.diskBytes', 'pools']);
  expect(result.observations.resources).toEqual({});
  expect(result.sqlBudget).toBeNull();
  expect(result.capacityValidated).toBe(false);
  const partial = copy(); delete partial.resources.diskBytes;
  expect(buildCapacityReport(partial).missing).toEqual(['resources.diskBytes']);
});

it('accepts fractional average messages, zero traffic and the media fraction boundaries', async () => {
  const { estimateWorkload } = await subject();
  const fixture = copy(); fixture.workload.messagesPerConversation = 2.5;
  expect(estimateWorkload(fixture).monthlyMessages).toBe(625000);
  fixture.workload.monthlyConversations = 0; fixture.workload.connections = 0; fixture.workload.mediaFraction = 0;
  expect(estimateWorkload(fixture)).toMatchObject({ monthlyMessages: 0, peakMessagesPerSecond: 0, retainedMediaBytes: 0, connectionsPerOrganization: 0 });
  fixture.workload.monthlyConversations = 30; fixture.workload.messagesPerConversation = 1; fixture.workload.mediaFraction = 1;
  expect(estimateWorkload(fixture).averageMediaBytesPerDay).toBe(1000000);
});

it.each([
  ['root credential', fixture => { fixture.token = 'secret'; }],
  ['nested URL', fixture => { fixture.resources.url = 'https://user:secret@example.test'; }],
  ['unknown workload field', fixture => { fixture.workload.customMetric = 1; }],
  ['credential on a component', fixture => { fixture.pools.components[0].password = 'secret'; }],
  ['unsupported component', fixture => { fixture.pools.components[0].name = 'SECRET_DATABASE'; }],
  ['duplicate component', fixture => { fixture.pools.components.push({ name: 'API', replicas: 1, maxPerReplica: 2 }); }],
  ['wrong schema version', fixture => { fixture.schemaVersion = 2; }],
  ['null resources', fixture => { fixture.resources = null; }],
  ['array workload', fixture => { fixture.workload = []; }],
  ['missing dimension', fixture => { delete fixture.workload.retentionDays; }],
])('rejects %s with a static error instead of copying the supplied value', async (_name, mutate) => {
  const { buildCapacityReport } = await subject();
  const fixture = copy(); mutate(fixture);
  expect(() => buildCapacityReport(fixture)).toThrow('CAPACITY_INVALID_INPUT');
});

it.each([
  ['organizations', 0], ['organizations', 1.5], ['organizations', 100001],
  ['connections', -1], ['connections', 1000001], ['monthlyConversations', 1000000001],
  ['messagesPerConversation', 0], ['messagesPerConversation', Number.NaN], ['messagesPerConversation', Infinity],
  ['daysPerMonth', 0], ['daysPerMonth', 367], ['peakMultiplier', 0.5],
  ['mediaFraction', -0.1], ['mediaFraction', 1.01], ['meanMediaBytes', 1.5],
  ['retentionDays', -1], ['retentionDays', '90'],
])('rejects an invalid workload number for %s (%s)', async (field, value) => {
  const { estimateWorkload } = await subject();
  const fixture = copy(); fixture.workload[field] = value;
  expect(() => estimateWorkload(fixture)).toThrow('CAPACITY_INVALID_INPUT');
});

it('rejects invalid resource and SQL dimensions, including unsafe integers', async () => {
  const { buildCapacityReport } = await subject();
  const variants = [
    fixture => { fixture.resources.cpuCores = 0; },
    fixture => { fixture.resources.ramBytes = Number.MAX_SAFE_INTEGER + 1; },
    fixture => { fixture.pools.reservedConnections = 101; },
    fixture => { fixture.pools.components[0].replicas = 0; },
    fixture => { fixture.pools.components[0].maxPerReplica = 1.5; },
    fixture => { fixture.pools.components = []; },
  ];
  for (const mutate of variants) {
    const fixture = copy(); mutate(fixture);
    expect(() => buildCapacityReport(fixture)).toThrow('CAPACITY_INVALID_INPUT');
  }
});

it('refuses an overflowing media estimate instead of returning an imprecise inventory', async () => {
  const { estimateWorkload } = await subject();
  const fixture = copy(); fixture.workload.monthlyConversations = 1000000000;
  fixture.workload.messagesPerConversation = 1000; fixture.workload.meanMediaBytes = 1000000000;
  fixture.workload.mediaFraction = 1;
  expect(() => estimateWorkload(fixture)).toThrow('CAPACITY_ESTIMATE_OVERFLOW');
});

it('outputs a sanitized report through the real offline CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jrc-capacity-test-'));
  try {
    const file = join(directory, 'inventory.json'); await writeFile(file, JSON.stringify(input));
    const result = await run(process.execPath, [fileURLToPath(moduleUrl), file]);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'PLANNING_ONLY', capacityValidated: false });
    expect(result.stdout).not.toContain(file);
    const serialized = JSON.stringify(input);
    await writeFile(file, serialized + ' '.repeat(65536 - Buffer.byteLength(serialized)));
    const boundary = await run(process.execPath, [fileURLToPath(moduleUrl), file]);
    expect(boundary.stderr).toBe('');
    expect(JSON.parse(boundary.stdout).capacityValidated).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('never prints malformed input, credentials, paths or stack traces on CLI failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jrc-capacity-test-'));
  try {
    const file = join(directory, 'private-inventory.json');
    for (const content of ['{"password":"super-private"', JSON.stringify({ ...input, url: 'https://user:super-private@example.test' })]) {
      await writeFile(file, content);
      const error = await run(process.execPath, [fileURLToPath(moduleUrl), file]).then(() => null, failure => failure);
      expect(error).not.toBeNull(); expect(error.stdout).toBe('');
      expect(error.stderr).toMatch(/^CAPACITY_INVALID_INPUT\n$/);
      expect(error.stderr).not.toContain('super-private'); expect(error.stderr).not.toContain(file);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('bounds CLI file bytes and emits static usage or unreadable-file errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jrc-capacity-test-'));
  try {
    const file = join(directory, 'large.json'); await writeFile(file, ' '.repeat(65537));
    const cases = [
      [[file], 'CAPACITY_INPUT_TOO_LARGE\n'],
      [[], 'CAPACITY_USAGE\n'],
      [[join(directory, 'absent.json')], 'CAPACITY_INPUT_UNREADABLE\n'],
    ];
    for (const [args, expected] of cases) {
      const error = await run(process.execPath, [fileURLToPath(moduleUrl), ...args]).then(() => null, failure => failure);
      expect(error).not.toBeNull(); expect(error.stdout).toBe(''); expect(error.stderr).toBe(expected);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
