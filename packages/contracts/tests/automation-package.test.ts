import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const graph = { nodes: [{ id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 }, data: {} }], edges: [] };
describe('portable automation package contract', () => {
  it('exposes a versioned strict package without tenant or credential context', () => {
    expect(contracts).toHaveProperty('AutomationPackageSchema');
    const schema = (contracts as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>).AutomationPackageSchema!;
    const value = { format: 'jrc-broker-package/1', rootKey: 'root', flows: [{ key: 'root', name: 'Root', graph }] };
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, organizationId: 'source-tenant' }).success).toBe(false);
    expect(schema.safeParse({ ...value, format: 'jrc-broker-package/2' }).success).toBe(false);
  });
});
