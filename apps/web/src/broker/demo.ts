import type { ApiClient } from '../api/client.js';
import { ApiClientError } from '../api/client.js';
import type { BrokerOverview, Instance } from '@jrc/contracts';
// Imported only behind import.meta.env.DEV. No session or bypass is bundled in production.
const org = '11111111-1111-4111-8111-111111111111',
  account = '22222222-2222-4222-8222-222222222222',
  channel = '44444444-4444-4444-8444-444444444444';
const uid = (i: number) => '33333333-3333-4333-8333-' + String(i).padStart(12, '0');
const names = [
  'Comercial · Matriz',
  'Suporte · Rio de Janeiro',
  'Financeiro · Belo Horizonte',
  'Vendas · Curitiba',
  'Atendimento · Salvador',
  'Comercial · Fortaleza',
  'Relacionamento · Recife',
  'Cobrança · Campinas',
];
const statuses: Instance['status'][] = [
  'CONNECTED',
  'AWAITING_ACTION',
  'ERROR',
  'CONNECTED',
  'PROVISIONING',
  'CONNECTED',
  'CONNECTED',
  'DISCONNECTED',
];
const instances: Instance[] = names.map((name, i) => ({
  id: uid(i + 1),
  organizationId: org,
  providerAccountId: account,
  name,
  provider: 'BAILEYS',
  status: statuses[i]!,
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: new Date().toISOString(),
}));
export function demoOverview(days = 30): BrokerOverview {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  const daily = Array.from({ length: days }, (_, i) => ({
    date: new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
    incoming: Math.round(1450 + i * 24 + Math.sin(i * 1.7) * 440),
    outgoing: Math.round(1950 + i * 34 + Math.sin(i * 1.2) * 660),
    delivered: Math.round(1850 + i * 32 + Math.sin(i * 1.2) * 620),
    failed: (i % 4) * 6,
    unknown: i % 3,
  }));
  return {
    observedAt: new Date().toISOString(),
    periodDays: days,
    periodStart: start.toISOString(),
    timezone: 'UTC',
    connections: {
      total: 842,
      online: 791,
      attention: 23,
      disconnected: 11,
      provisioning: 17,
      unobserved: 0,
    },
    providers: [
      { provider: 'BAILEYS', total: 714, online: 673 },
      { provider: 'META', total: 128, online: 118 },
    ],
    messages: daily.reduce(
      (s, d) => ({
        incoming: s.incoming + d.incoming,
        outgoing: s.outgoing + d.outgoing,
        delivered: s.delivered + d.delivered,
        failed: s.failed + d.failed,
        unknown: s.unknown + d.unknown,
      }),
      { incoming: 0, outgoing: 0, delivered: 0, failed: 0, unknown: 0 },
    ),
    daily,
    incidents: [
      {
        id: uid(100),
        instanceId: uid(3),
        name: names[2]!,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
      },
      {
        id: uid(101),
        instanceId: uid(2),
        name: names[1]!,
        status: 'UNKNOWN',
        updatedAt: new Date().toISOString(),
      },
    ],
    billing: null,
  };
}
export function createDemoClient(): ApiClient {
  const activeOrganization = {
    id: org,
    name: 'JRC · Demonstração',
    slug: 'jrc-demo',
    role: 'OWNER' as const,
  };
  const session = {
    user: { id: uid(200), email: 'operador@example.test' },
    activeOrganization,
    organizations: [activeOrganization],
  };
  return {
    restore: async () => session,
    logout: async () => {},
    registerTenantPurge: () => () => {},
    subscribeToSessionExpiration: () => () => {},
    login: async () => {
      throw new ApiClientError('A demonstração já está aberta.', 400);
    },
    selectOrganization: async () => session,
    switchOrganization: async () => session,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const url = new URL(path, 'http://demo.local');
      let value: unknown;
      if (init?.method && init.method !== 'GET')
        throw new ApiClientError(
          'Demonstração visual: alterações reais não estão disponíveis.',
          409,
        );
      if (url.pathname === '/v1/organization/overview')
        value = demoOverview(Number(url.searchParams.get('days') ?? 30));
      else if (url.pathname === '/v1/organization/operations')
        value = {
          status: 'ACTIVE',
          maxInstances: 1000,
          maxUsers: 50,
          messagesPerDay: 100000,
          maxPendingMessages: 5000,
          messagesAcceptedToday: 28410,
        };
      else if (url.pathname === '/v1/instances')
        value = { data: instances, pageInfo: { hasNextPage: false, nextCursor: null } };
      else if (url.pathname === '/v1/provider-accounts')
        value = {
          data: [
            {
              id: account,
              provider: 'BAILEYS',
              name: 'JRC · Ambiente de demonstração',
              createdAt: '2026-08-01T12:00:00.000Z',
            },
          ],
          pageInfo: { hasNextPage: false, nextCursor: null },
        };
      else if (url.pathname.startsWith('/v1/instances/')) {
        const instance = instances.find((i) => i.id === url.pathname.split('/')[3]);
        if (!instance) throw new ApiClientError('Conexão não encontrada.', 404);
        value = url.pathname.endsWith('/workspace')
          ? {
              observedAt: new Date().toISOString(),
              providerAvailable: true,
              profile: { name: instance.name, phone: null, state: 'open' },
              counts: { contacts: 1842, chats: 791, messages: 24820 },
              settings: {
                rejectCall: false,
                msgCall: '',
                groupsIgnore: true,
                alwaysOnline: false,
                readMessages: false,
                readStatus: false,
                syncFullHistory: false,
              },
              operations: [
                {
                  id: uid(110),
                  type: 'CONNECT',
                  status: 'SUCCEEDED',
                  attempts: 1,
                  errorCode: null,
                  updatedAt: new Date().toISOString(),
                },
              ],
              instance,
            }
          : instance;
      } else if (url.pathname === '/v1/messaging/channels')
        value = { data: [{ id: channel, provider: 'META', botPublicId: 'atendimento-demo' }] };
      else if (url.pathname.endsWith('/templates')) value = { data: [] };
      else if (url.pathname.endsWith('/conversations')) value = { data: [] };
      else if (url.pathname === '/v1/api-keys')
        value = { data: [], pageInfo: { hasNextPage: false, nextCursor: null } };
      else throw new ApiClientError('Este recurso não está incluído na demonstração.', 404);
      return value as T;
    },
  };
}
