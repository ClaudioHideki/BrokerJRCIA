import { expect, it } from 'vitest';
const org = '11111111-1111-4111-8111-111111111111', channel = '22222222-2222-4222-8222-222222222222', integration = '33333333-3333-4333-8333-333333333333';
const snapshot: any = { organizationId: org, channelId: channel, provider: 'QR', identity: { fingerprint: 'identity', revision: 2, confirmed: true },
  destination: { origin: 'https://central.example.test', integrationId: integration, accountId: 7, inboxId: 8, destinationRevision: 1, credentialRevision: 1 },
  agents: { target: { agentId: 3, teamId: null } }, flow: { id: org, version: 1, checksum: 'a'.repeat(64) } };
it('rechecks identity, destination and the original published root under the native binding transaction', async () => {
  const mod = await import('../../src/modules/guided-setup/binding-scope.js').catch(() => null); expect(mod).not.toBeNull();
  let credential = 1, identityRevision = 2;
  const statements: string[] = [];
  const tx = { query: async (sql: string) => { statements.push(sql);
    if (sql.includes('AS "integrationId"')) return { rows: [{ integrationId: integration, destinationRevision: 1, accountId: '7', inboxId: '8', connectionStatus: 'READY', accountStatus: 'READY', approvalStatus: 'APPROVED' }] };
    if (sql.includes('chatwoot_accounts')) return { rows: [{ baseUrl: 'https://central.example.test', credentialRevision: credential }] };
    if (sql.includes('chatwoot_connection_health')) return { rows: [{ approved_fingerprint: 'identity', observed_fingerprint: 'identity', identity_revision: identityRevision, observed_connected: true, identity_error: null }] };
    if (sql.includes('automation_versions')) return { rows: [{ checksum: 'a'.repeat(64) }] };
    throw new Error(sql);
  } } as never;
  await mod!.assertSetupBindingScope(tx, org, snapshot);
  credential = 2; await expect(mod!.assertSetupBindingScope(tx, org, snapshot)).rejects.toMatchObject({ code: 'GUIDED_SETUP_CONFIGURATION_CHANGED' });
  credential = 1; identityRevision = 3; await expect(mod!.assertSetupBindingScope(tx, org, snapshot)).rejects.toMatchObject({ code: 'GUIDED_SETUP_CONFIGURATION_CHANGED' });
  expect(statements.every(sql => /^\s*select/i.test(sql))).toBe(true);
  expect(statements.find(sql => sql.includes('automation_versions'))).not.toMatch(/FOR SHARE OF d,v/u);
});
it('rejects a flow that would hand off to a different agent or channel than the wizard displays', async () => {
  const mod = await import('../../src/modules/guided-setup/graph-scope.js').catch(() => null); expect(mod).not.toBeNull();
  const data = { handoffVersion: 1, destination: { integrationId: integration, accountId: 7, inboxId: 8, destinationRevision: 1, credentialRevision: 1 }, target: { agentId: 3, teamId: null } };
  const graph = { nodes: [{ id: 'handoff', type: 'handoff', label: 'Handoff', position: { x: 0, y: 0 }, data }], edges: [] };
  expect(mod!.matchesSetupGraphScope(graph, snapshot)).toBe(true);
  graph.nodes[0]!.data.target.agentId = 9; expect(mod!.matchesSetupGraphScope(graph, snapshot)).toBe(false);
});
