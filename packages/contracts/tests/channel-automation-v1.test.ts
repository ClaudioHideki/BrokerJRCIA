import { describe, expect, it } from 'vitest';

import {
  adaptLegacyFlowRecordToAutomationV1,
  AutomationBindingV1Schema,
  AutomationDefinitionV1Schema,
  AutomationExecutionSummaryV1Schema,
  AutomationPublishedVersionV1Schema,
  ChannelV1Schema,
  welcomeFlow,
} from '../src/index.js';

const ids = {
  organization: '04211923-8057-4bf8-9d94-fb26cc67c57f',
  channel: '73dcf81e-0544-4e5c-9830-d9f646b7152d',
  providerAccount: '119498c0-ff0c-40aa-8bdd-1e581c42a884',
  instance: '2ba96098-4e50-4e19-88df-ee2099954f79',
  automation: '519b77a6-a4e5-409a-85c8-d78fc155c525',
  binding: '4f2491a2-6853-4ac2-a7ef-c997813a9182',
  execution: 'ca93ad35-0a3f-48dc-9032-c47780498804',
} as const;

const timestamp = '2026-09-21T12:00:00.000Z';

describe('contrato canônico Channel v1', () => {
  it('mantém os quatro estados independentes e serializa sem identificadores do upstream', () => {
    const channel = ChannelV1Schema.parse({
      schemaVersion: 1,
      id: ids.channel,
      organizationId: ids.organization,
      provider: 'QR',
      identity: { displayName: 'Atendimento JRC', maskedAddress: '*******8433' },
      providerReference: { providerAccountId: ids.providerAccount, instanceId: ids.instance },
      transportStatus: 'CONNECTED',
      providerStatus: 'READY',
      automationStatus: 'PAUSED',
      humanStatus: 'DEGRADED',
      revision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(JSON.parse(JSON.stringify(channel))).toEqual(channel);
    expect(channel).toMatchObject({
      transportStatus: 'CONNECTED',
      providerStatus: 'READY',
      automationStatus: 'PAUSED',
      humanStatus: 'DEGRADED',
    });
  });

  it.each(['accessToken', 'apiKey', 'secret', 'credential'])('rejeita segredo privilegiado %s', (field) => {
    expect(ChannelV1Schema.safeParse({
      schemaVersion: 1,
      id: ids.channel,
      organizationId: ids.organization,
      provider: 'META',
      identity: { displayName: null, maskedAddress: null },
      providerReference: { providerAccountId: ids.providerAccount, connectionId: ids.instance },
      transportStatus: 'CREATED',
      providerStatus: 'PENDING',
      automationStatus: 'UNBOUND',
      humanStatus: 'UNBOUND',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      [field]: 'must-not-leak',
    }).success).toBe(false);
  });

  it('rejeita identidade sem mascaramento', () => {
    expect(ChannelV1Schema.safeParse({
      schemaVersion: 1,
      id: ids.channel,
      organizationId: ids.organization,
      provider: 'QR',
      identity: { displayName: 'Atendimento', maskedAddress: '55115558433' },
      providerReference: { providerAccountId: ids.providerAccount, instanceId: ids.instance },
      transportStatus: 'CONNECTED',
      providerStatus: 'READY',
      automationStatus: 'ACTIVE',
      humanStatus: 'READY',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).success).toBe(false);
  });
});

describe('contratos canônicos Automation v1', () => {
  it('mapeia o Flow atual sem perder grafo, revisão ou versão publicada', () => {
    const graph = welcomeFlow();
    const automation = adaptLegacyFlowRecordToAutomationV1({
      id: ids.automation,
      name: 'Boas-vindas',
      graph,
      revision: 7,
      publishedVersion: 4,
      updatedAt: timestamp,
    }, ids.organization);

    expect(AutomationDefinitionV1Schema.parse(automation)).toEqual(automation);
    expect(automation.draft.graph).toEqual(graph);
    expect(automation).toMatchObject({
      schemaVersion: 1,
      lifecycleStatus: 'PUBLISHED',
      activeVersion: 4,
      draft: { revision: 7 },
    });
  });

  it('valida versão imutável, binding e resumo de execução sem payload ou segredo', () => {
    expect(AutomationPublishedVersionV1Schema.parse({
      schemaVersion: 1,
      automationId: ids.automation,
      organizationId: ids.organization,
      version: 4,
      graph: welcomeFlow(),
      checksum: 'a'.repeat(64),
      publishedAt: timestamp,
    })).toBeTruthy();

    expect(AutomationBindingV1Schema.parse({
      schemaVersion: 1,
      id: ids.binding,
      organizationId: ids.organization,
      automationId: ids.automation,
      version: 4,
      channelId: ids.channel,
      humanDestinationId: null,
      status: 'ACTIVE',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toBeTruthy();

    const execution = AutomationExecutionSummaryV1Schema.parse({
      schemaVersion: 1,
      id: ids.execution,
      organizationId: ids.organization,
      automationId: ids.automation,
      version: 4,
      bindingId: ids.binding,
      channelId: ids.channel,
      status: 'WAITING',
      currentNodeId: 'name',
      correlationId: '85a17103-9f0d-4d86-b55d-4184597e17a8',
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    });

    expect(execution).not.toHaveProperty('input');
    expect(AutomationExecutionSummaryV1Schema.safeParse({ ...execution, accessToken: 'forged' }).success).toBe(false);

    const graphWithSecret = welcomeFlow();
    graphWithSecret.nodes[0]!.data = { accessToken: 'must-not-leak' };
    expect(AutomationDefinitionV1Schema.safeParse({
      schemaVersion: 1,
      id: ids.automation,
      organizationId: ids.organization,
      name: 'Segredo inválido',
      lifecycleStatus: 'DRAFT',
      draft: { revision: 1, graph: graphWithSecret },
      activeVersion: null,
      updatedAt: timestamp,
    }).success).toBe(false);
  });
});
