import { expect, it } from 'vitest';
import { buildBrokerOverview } from '../../src/modules/broker/overview.js';
it('normaliza timestamp com offset retornado pelo jsonb do PostgreSQL', () => {
  const result = buildBrokerOverview({
    connections: [], daily: [],
    incidents: [{
      id: '11111111-1111-4111-8111-111111111111',
      instanceId: '22222222-2222-4222-8222-222222222222',
      name: 'Teste', status: 'FAILED', updatedAt: '2026-09-15T10:00:00-03:00',
    }],
  }, 7, new Date('2026-09-15T14:00:00Z'));
  expect(result.incidents[0]!.updatedAt).toBe('2026-09-15T13:00:00.000Z');
});
it('agrega estados distintos, completa dias UTC e mantém custo desconhecido', () => {
  const result = buildBrokerOverview(
    {
      connections: [
        { provider: 'BAILEYS', status: 'CONNECTED', count: 7 },
        { provider: 'BAILEYS', status: 'ERROR', count: 2 },
        { provider: 'META', status: 'READY', count: 3 },
        { provider: 'META', status: 'PENDING', count: 1 },
      ],
      daily: [
        { date: '2026-09-15', incoming: 3, outgoing: 5, delivered: 2, failed: 1, unknown: 1 },
      ],
      incidents: [],
    },
    7,
    new Date('2026-09-15T12:00:00Z'),
  );
  expect(result.connections).toMatchObject({
    total: 13,
    online: 10,
    attention: 2,
    provisioning: 1,
  });
  expect(result.daily).toHaveLength(7);
  expect(result.daily[0]?.date).toBe('2026-09-09');
  expect(result.messages).toEqual({
    incoming: 3,
    outgoing: 5,
    delivered: 2,
    failed: 1,
    unknown: 1,
  });
  expect(result.billing).toBeNull();
});
it('preserva estado desconhecido para não inflar conectadas', () => {
  const result = buildBrokerOverview(
    {
      connections: [{ provider: 'META', status: 'UNOBSERVED', count: 2 }],
      daily: [],
      incidents: [],
    },
    7,
    new Date('2026-09-15T12:00:00Z'),
  );
  expect(result.connections.total).toBe(2);
  expect(result.connections.unobserved).toBe(2);
  expect(result.connections.online).toBe(0);
});
