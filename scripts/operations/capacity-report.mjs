import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 65536;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const COMPONENTS = new Set(['API', 'AUTH', 'MESSAGING', 'AUTOMATION', 'AUTOMATION_IO', 'SCHEDULER', 'LIFECYCLE', 'MIGRATOR', 'EVOLUTION']);
const RESOURCE_FIELDS = ['cpuCores', 'ramBytes', 'diskBytes'];
const WORKLOAD_FIELDS = ['organizations', 'connections', 'monthlyConversations', 'messagesPerConversation', 'daysPerMonth', 'peakMultiplier', 'mediaFraction', 'meanMediaBytes', 'retentionDays'];
const STATIC_ERRORS = new Set(['CAPACITY_INVALID_INPUT', 'CAPACITY_ESTIMATE_OVERFLOW', 'CAPACITY_USAGE', 'CAPACITY_INPUT_UNREADABLE', 'CAPACITY_INPUT_TOO_LARGE']);
const fail = (code = 'CAPACITY_INVALID_INPUT') => { throw new Error(code); };

function strictObject(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail();
}

function number(value, minimum, maximum, integer = false, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
    (integer && !Number.isSafeInteger(value)) || (positive && value <= 0)) fail();
}

function validate(input) {
  strictObject(input, ['schemaVersion', 'resources', 'workload', 'pools'], ['schemaVersion', 'workload']);
  if (input.schemaVersion !== 1) fail();
  if (Object.hasOwn(input, 'resources')) {
    strictObject(input.resources, RESOURCE_FIELDS, []);
    for (const key of RESOURCE_FIELDS) if (Object.hasOwn(input.resources, key)) {
      if (key === 'cpuCores') number(input.resources[key], 0, 65536, false, true);
      else number(input.resources[key], 1, MAX_SAFE, true);
    }
  }
  strictObject(input.workload, WORKLOAD_FIELDS);
  const w = input.workload;
  number(w.organizations, 1, 100000, true);
  number(w.connections, 0, 1000000, true);
  number(w.monthlyConversations, 0, 1000000000, true);
  number(w.messagesPerConversation, 0, 10000, false, true);
  number(w.daysPerMonth, 1, 366, true);
  number(w.peakMultiplier, 1, 10000);
  number(w.mediaFraction, 0, 1);
  number(w.meanMediaBytes, 0, 1000000000, true);
  number(w.retentionDays, 0, 36500, true);
  if (Object.hasOwn(input, 'pools')) {
    const p = input.pools;
    strictObject(p, ['maxConnections', 'reservedConnections', 'components']);
    number(p.maxConnections, 1, 1000000, true);
    number(p.reservedConnections, 0, p.maxConnections, true);
    if (!Array.isArray(p.components) || p.components.length < 1 || p.components.length > COMPONENTS.size) fail();
    const seen = new Set();
    for (const component of p.components) {
      strictObject(component, ['name', 'replicas', 'maxPerReplica']);
      if (!COMPONENTS.has(component.name) || seen.has(component.name)) fail();
      seen.add(component.name);
      number(component.replicas, 1, 10000, true);
      number(component.maxPerReplica, 1, 1000000, true);
    }
  }
}

function safe(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE) fail('CAPACITY_ESTIMATE_OVERFLOW');
  return value;
}

function estimateValidated(w) {
  const monthlyMessages = safe(w.monthlyConversations * w.messagesPerConversation);
  const averageMessagesPerSecond = safe(monthlyMessages / (w.daysPerMonth * 86400));
  const monthlyMediaBytes = safe(safe(monthlyMessages * w.mediaFraction) * w.meanMediaBytes);
  const averageMediaBytesPerDay = safe(monthlyMediaBytes / w.daysPerMonth);
  return {
    monthlyMessages,
    averageMessagesPerSecond,
    peakMessagesPerSecond: safe(averageMessagesPerSecond * w.peakMultiplier),
    connectionsPerOrganization: safe(w.connections / w.organizations),
    averageMediaBytesPerDay,
    retainedMediaBytes: safe(averageMediaBytesPerDay * w.retentionDays),
  };
}

/** Pure planning arithmetic; monthlyConversations is the supplied total, never a per-tenant assumption. */
export function estimateWorkload(input) {
  validate(input);
  return estimateValidated(input.workload);
}

const observation = value => ({ value, source: 'OPERATOR_INPUT' });
const observations = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, observation(value[key])]));

/** Rebuild from allowlisted fields: no source text, path, endpoint, credential or arbitrary label survives. */
export function buildCapacityReport(input) {
  validate(input);
  const resources = Object.hasOwn(input, 'resources') ? input.resources : {};
  const missing = RESOURCE_FIELDS.filter(key => !Object.hasOwn(resources, key)).map(key => `resources.${key}`);
  if (!Object.hasOwn(input, 'pools')) missing.push('pools');
  let sqlBudget = null;
  const observed = {
    resources: observations(resources, RESOURCE_FIELDS),
    workload: observations(input.workload, WORKLOAD_FIELDS),
  };
  if (Object.hasOwn(input, 'pools')) {
    const p = input.pools;
    const configuredConnections = p.components.reduce((total, component) => safe(total + safe(component.replicas * component.maxPerReplica)), 0);
    const availableConnections = p.maxConnections - p.reservedConnections;
    const headroomConnections = availableConnections - configuredConnections;
    sqlBudget = { configuredConnections, availableConnections, headroomConnections,
      withinConfiguredBudget: headroomConnections >= 0, source: 'OPERATOR_INPUT', kind: 'DERIVED_PLANNING' };
    observed.pools = {
      ...observations(p, ['maxConnections', 'reservedConnections']),
      components: p.components.map(component => ({ name: component.name, ...observations(component, ['replicas', 'maxPerReplica']) })),
    };
  }
  return {
    schemaVersion: 1,
    status: missing.length ? 'PARTIAL' : 'PLANNING_ONLY',
    capacityValidated: false,
    targets: { organizations: 500, connections: 10000, source: 'PLANNING_TARGET' },
    observations: observed,
    estimates: { ...estimateValidated(input.workload), source: 'OPERATOR_INPUT', kind: 'DERIVED_PLANNING' },
    sqlBudget,
    missing,
  };
}

async function readInput(path) {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile()) fail('CAPACITY_INPUT_UNREADABLE');
    if (info.size > MAX_INPUT_BYTES) fail('CAPACITY_INPUT_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_INPUT_BYTES) fail('CAPACITY_INPUT_TOO_LARGE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); }
    catch { fail(); }
  } catch (error) {
    if (STATIC_ERRORS.has(error?.message)) throw error;
    fail('CAPACITY_INPUT_UNREADABLE');
  } finally { await file?.close().catch(() => {}); }
}

async function cli(args) {
  try {
    if (args.length !== 1) fail('CAPACITY_USAGE');
    const report = buildCapacityReport(await readInput(args[0]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const code = STATIC_ERRORS.has(error?.message) ? error.message : 'CAPACITY_INVALID_INPUT';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await cli(process.argv.slice(2));
