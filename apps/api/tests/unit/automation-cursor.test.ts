import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';

describe('cursor de automações', () => {
  it('rejeita uma data calendárica inexistente antes de consultar PostgreSQL', async () => {
    const transact = vi.fn(async () => { throw new Error('STORAGE_SHOULD_NOT_BE_QUERIED'); });
    const service = createAutomationService({ transact });
    const cursor = Buffer.from(JSON.stringify({
      updatedAt: '2026-02-31T12:00:00.123456Z', id: '11111111-1111-4111-8111-111111111111',
    })).toString('base64url');
    await expect(Promise.resolve().then(() => service.list('tenant', { cursor }))).rejects.toMatchObject({
      statusCode: 400, code: 'AUTOMATION_CURSOR_INVALID',
    });
    expect(transact).not.toHaveBeenCalled();
  });
});
