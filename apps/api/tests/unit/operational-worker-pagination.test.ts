import { describe, expect, it } from 'vitest';
import * as workerModule from '../../src/commands/automation-worker.js';

describe('varredura de empresas dos workers de automação', () => {
  it('visita todas as empresas quando há mais de mil organizações elegíveis', async () => {
    const scan = (workerModule as unknown as Record<string, unknown>).scanOperationalOrganizations;
    expect(scan).toBeTypeOf('function');
    if (typeof scan !== 'function') return;

    const ids = Array.from({ length: 1001 }, (_, index) =>
      `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, '0')}`);
    const observed: string[] = [];
    const cursors: Array<string | null> = [];
    const queryPage = async (afterId: string | null, batchSize: number) => {
      cursors.push(afterId);
      const start = afterId === null ? 0 : ids.indexOf(afterId) + 1;
      return ids.slice(start, start + batchSize);
    };

    await scan(queryPage, async (id: string) => { observed.push(id); });

    expect(observed).toEqual(ids);
    expect(cursors[0]).toBeNull();
    expect(cursors.slice(1).every(cursor => cursor !== null)).toBe(true);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('continua a página após falha de um tenant quando há tratamento de erro', async () => {
    const scan = (workerModule as unknown as Record<string, unknown>).scanOperationalOrganizations;
    expect(scan).toBeTypeOf('function');
    if (typeof scan !== 'function') return;

    const observed: string[] = [];
    const errors: string[] = [];
    await scan(
      async () => ['tenant-a', 'tenant-b', 'tenant-c'],
      async (id: string) => {
        observed.push(id);
        if (id === 'tenant-a') throw new Error('tenant-a-unavailable');
      },
      undefined,
      (error: unknown, id: string) => { errors.push(`${id}:${(error as Error).message}`); },
    );

    expect(observed).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    expect(errors).toEqual(['tenant-a:tenant-a-unavailable']);
  });
});
