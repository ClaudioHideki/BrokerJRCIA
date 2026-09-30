import { renderRuntimeText, renderRuntimeValue, runtimeJson, runtimeText } from './runtime-state.js';
import type { RuntimeState } from './types.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const textFields = new Set(['url', 'method', 'credentialId', 'target', 'nodeType', 'query', 'code', 'content', 'model']);

export function automationCodeInput(payload: Record<string, unknown>): unknown {
  return Object.hasOwn(payload, 'input') ? payload.input : payload.variables;
}

/** Legacy persisted effects keep their original substitution contract. */
const legacy = (value: unknown, variables: Record<string, unknown>): unknown =>
  typeof value === 'string' ? value.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (_all, key: string) => String(variables[key] ?? ''))
    : Array.isArray(value) ? value.map(item => legacy(item, variables))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, legacy(child, variables)])) : value;

export function renderAutomationIoPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const version = payload.runtimeStateVersion ?? 1, variables = object(payload.variables);
  if (version === 1) return object(legacy(payload, variables));
  if (version !== 2) throw new Error('AUTOMATION_STATE_VERSION_UNSUPPORTED');
  const render = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('AUTOMATION_STATE_VALUE_INVALID');
    if (typeof value === 'string') return renderRuntimeValue(value, variables as RuntimeState['variables']);
    if (Array.isArray(value)) return value.map(item => render(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, render(child, depth + 1)]));
    return value;
  };
  // Values from the customer are data, not a second template program.
  const { variables: _variables, ...parameters } = payload;
  const text = (value: unknown) => typeof value === 'string'
    ? renderRuntimeText(value, variables as RuntimeState['variables']) : runtimeText(runtimeJson(value));
  const rendered = Object.fromEntries(Object.entries(parameters).map(([key, value]) => {
    if (textFields.has(key)) return [key, text(value)];
    if (key === 'headers') {
      // A whole-header reference is already customer data; never evaluate its values again.
      if (typeof value === 'string') {
        const resolved = renderRuntimeValue(value, variables as RuntimeState['variables']);
        if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw new Error('AUTOMATION_IO_HEADERS_INVALID');
        return [key, Object.fromEntries(Object.entries(resolved).map(([name, item]) => [name, runtimeText(item)]))];
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTOMATION_IO_HEADERS_INVALID');
      return [key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, text(item)]))];
    }
    return [key, render(value)];
  }));
  return { ...rendered, variables };
}
