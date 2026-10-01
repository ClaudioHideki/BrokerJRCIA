import type { RuntimeJson, RuntimeState } from './types.js';

export const RUNTIME_VALUE_BYTES = 65536;
export const RUNTIME_STATE_BYTES = 262144;
const invalid = () => new Error('AUTOMATION_STATE_VALUE_INVALID');

/** Reject values JSON.stringify would silently drop or coerce. No getters/toJSON execute. */
function checkJson(value: unknown, parents = new Set<object>(), depth = 0): asserts value is RuntimeJson {
  if (depth > 64) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || parents.has(value)) throw invalid();
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  parents.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw invalid();
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(descriptors).length !== value.length + 1
      || Object.keys(value).length !== value.length) throw invalid();
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
      checkJson(descriptor.value, parents, depth + 1);
    }
  } else {
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
      checkJson(descriptor.value, parents, depth + 1);
    }
  }
  parents.delete(value);
}

export function runtimeJson(value: unknown): RuntimeJson {
  checkJson(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > RUNTIME_VALUE_BYTES) throw new Error('AUTOMATION_STATE_VALUE_LIMIT');
  return JSON.parse(encoded) as RuntimeJson;
}

export function runtimeText(value: RuntimeJson | undefined): string {
  return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

export function assertRuntimeState(state: RuntimeState): void {
  for (const value of Object.values(state.variables)) runtimeJson(value);
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > RUNTIME_STATE_BYTES) throw new Error('AUTOMATION_STATE_TOTAL_LIMIT');
}

export function runtimeStateVersion(previous?: RuntimeState, publishedVersion: 1 | 2 = 1): 1 | 2 {
  if (publishedVersion !== 1 && publishedVersion !== 2) throw new Error('AUTOMATION_STATE_VERSION_UNSUPPORTED');
  const version = previous ? previous.runtimeStateVersion ?? 1 : publishedVersion;
  if (version !== 1 && version !== 2) throw new Error('AUTOMATION_STATE_VERSION_UNSUPPORTED');
  if (version !== publishedVersion) throw new Error('AUTOMATION_STATE_VERSION_MISMATCH');
  return version;
}

export function isRuntimeKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(value)
    && !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
}

/** Text rendering is bounded explicitly; transport length limits are checked at dispatch. */
export function renderRuntimeText(value: unknown, variables: RuntimeState['variables']): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  const rendered = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all: string, key: string) =>
    isRuntimeKey(key.trim()) && Object.hasOwn(variables, key.trim()) ? runtimeText(variables[key.trim()]) : '');
  return runtimeJson(rendered) as string;
}

export function renderRuntimeValue(value: unknown, variables: RuntimeState['variables']): RuntimeJson {
  const reference = typeof value === 'string' ? /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value) : null;
  if (reference && isRuntimeKey(reference[1]?.trim()) && Object.hasOwn(variables, reference[1]!.trim()))
    return runtimeJson(variables[reference[1]!.trim()]);
  return typeof value === 'string' ? renderRuntimeText(value, variables) : runtimeJson(value);
}
