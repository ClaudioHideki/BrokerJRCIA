import { expect, it } from 'vitest';
import { parseHealthSnapshot, healthGroup, healthGuidance, healthDestination } from './health-model.js';
const valid = { observedAt: '2026-10-30T12:00:00Z', overall: 'UP', components: [{ key: 'NEW_COMPONENT', label: 'Novo sinal', state: 'UP', code: 'NEW_OK', observedAt: null }], alerts: [] };
it('keeps disabled binding diagnostics out of infrastructure and preserves uncertainty guidance', () => {
  expect(healthGroup('CHATWOOT_DISABLED_BINDINGS')).toBe('integrations');
  expect(healthGroup('CHATWOOT_DISABLED_HEALTH')).toBe('integrations');
  for (const key of ['DISABLED_INTEGRATION_BACKLOG', 'DISABLED_INTEGRATION_FAILURES', 'DISABLED_INTEGRATION_UNCERTAINTY']) {
    expect(healthGroup(key)).toBe('backlog');
    expect(healthDestination(key)?.to).toBe('/integracoes');
  }
  expect(healthGuidance('DISABLED_INTEGRATION_UNCERTAINTY', 'DISABLED_INTEGRATION_OUTCOME_UNKNOWN')).toContain('Resultado incerto');
  expect(healthGuidance('DISABLED_INTEGRATION_BACKLOG', 'DISABLED_INTEGRATION_BACKLOG_PRESENT')).toContain('desativados');
});
it('preserves forward-compatible additive fields and unknown components', () => {
  expect(parseHealthSnapshot({ ...valid, schemaVersion: 1 }).components[0]?.key).toBe('NEW_COMPONENT');
  expect(healthGroup('NEW_COMPONENT')).toBe('infrastructure');
});
it('preserves signed server ages for clock-skew diagnosis without accepting negative counts', () => {
  const result = parseHealthSnapshot({ ...valid, components: [{ ...valid.components[0], key: 'MESSAGING_WORKER', metric: -2, unit: 'seconds' }] });
  expect(result.components[0]?.metric).toBe(-2);
  expect(() => parseHealthSnapshot({ ...valid, components: [{ ...valid.components[0], metric: -2, unit: 'items' }] })).toThrow();
});
it.each([
  { ...valid, overall: 'HEALTHY' }, { ...valid, observedAt: 'invalid' },
  { ...valid, components: [{ ...valid.components[0], metric: NaN }] },
  { ...valid, components: [{ ...valid.components[0], metric: -1 }] },
  { ...valid, components: [...valid.components, ...valid.components] },
  { ...valid, alerts: [{ component: 'API', state: 'UP', code: null }] },
])('rejects malformed data without asserting it is operational', candidate => {
  expect(() => parseHealthSnapshot(candidate)).toThrow('Invalid operational health response');
});
