// A manual catalogue, never a provisioning/send workflow. Routes and response codes come from OpenAPI.
const prefix = '/v1/integrations/chatwoot/control';
const examples = {
  [`POST ${prefix}/onboarding`]: { flag: 'allow_onboarding', body: '{"name":"{{connection_name}}","source":{"kind":"EXISTING","instanceId":"{{instance_id}}"},"agentIds":{{agent_ids_json}},"replaceExistingWebhook":false}' },
  [`POST ${prefix}/onboarding/{operationId}/recover`]: { flag: 'allow_recovery', body: '{"action":"RECONCILE"}' },
  [`POST ${prefix}/connections/{integrationId}/pair`]: { flag: 'allow_pair', body: '{}' },
  [`POST ${prefix}/connections/{integrationId}/confirm-identity`]: { flag: 'allow_identity_confirmation', body: '{"observedRevision":{{observed_revision}}}' },
  [`POST ${prefix}/connections/{integrationId}/disconnect`]: { flag: 'allow_disconnect', body: '{}' },
  [`PUT ${prefix}/connections/{integrationId}/agents`]: { flag: 'allow_agent_update', body: '{"agentIds":{{agent_ids_json}}}' },
  [`POST ${prefix}/connections/{integrationId}/campaign-intents`]: { flag: 'allow_campaign_reservation', body: '{"conversationId":{{conversationId}},"messageId":{{messageId}},"campaignId":"{{campaign_id}}","kind":"text","text":"{{campaign_text}}","destinationRevision":{{destination_revision}},"identityRevision":{{identity_revision}},"ownerRevision":{{owner_revision}}}' },
};
const abort = "function abort(message) { pm.execution.setNextRequest(null); pm.execution.skipRequest(); throw new Error(message); }";
export function buildControlPostman(contract) {
  const queries = [], mutations = [], flags = [], variables = new Set(['broker_origin', 'jrc_api_key', 'idempotency_key', 'external_actor']);
  for (const [route, methods] of Object.entries(contract.paths)) for (const [method, operation] of Object.entries(methods)) {
    const write = method !== 'get', example = examples[method.toUpperCase() + ' ' + route];
    if (write && !example) throw new Error('CONTROL_POSTMAN_EXAMPLE_MISSING: ' + route);
    const pathVariables = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    const bodyVariables = [...(example?.body ?? '').matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
    for (const name of [...pathVariables, ...bodyVariables]) variables.add(name);
    const required = ['broker_origin', 'jrc_api_key', ...pathVariables, ...bodyVariables, ...(write ? ['idempotency_key'] : [])];
    const campaign = route.endsWith('/campaign-intents');
    if (campaign) required.push('external_actor');
    const headers = [{ key: 'Accept', value: 'application/json' }, { key: 'X-JRC-API-Key', value: '{{jrc_api_key}}' }];
    if (write) headers.push({ key: 'Content-Type', value: 'application/json' }, { key: 'Idempotency-Key', value: '{{idempotency_key}}' },
      { key: 'X-JRC-External-Actor', value: '{{external_actor}}', ...(!campaign ? { disabled: true } : {}) });
    const item = { name: operation.summary, request: { method: method.toUpperCase(), header: headers,
      url: '{{broker_origin}}' + route.replace(/\{([^}]+)\}/g, '{{$1}}'),
      description: operation.description + (write ? `\n\nExecutar somente esta pasta de ação. Defina ${example.flag}=true no ambiente privado; a ação para o Runner após a resposta. Nenhuma matrícula é autorizada por GET.` : '') +
        (method === 'post' && route === prefix + '/onboarding' ? ' O exemplo adota uma instância EXISTING; NEW usa source.kind, instanceName e providerAccountId conforme Swagger. Não substituir webhook sem decisão explícita.' : ''),
      ...(write ? { body: { mode: 'raw', raw: example.body, options: { raw: { language: 'json' } } } } : {}) },
      event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [abort,
        ...(write ? [`if (pm.variables.get('${example.flag}') !== 'true') abort('Ação desabilitada: ${example.flag}.');`] : []),
        `for (const key of ${JSON.stringify([...new Set(required)])}) if (pm.variables.get(key) === undefined || pm.variables.get(key) === '') abort('Preencha a variável privada: ' + key);`,
        ...(write ? ["if (!/^[A-Za-z0-9:_-]{8,128}$/.test(pm.variables.get('idempotency_key'))) abort('Idempotency-Key de controle inválida.');",
          `try { JSON.parse(pm.variables.replaceIn(${JSON.stringify(example.body)})); } catch { abort('Preencha um corpo JSON válido; não use IDs ou revisões fictícios.'); }`] : []),
        ...(campaign ? ["if (!/^[1-9]\\d{0,15}$/.test(pm.variables.get('external_actor'))) abort('A campanha exige o ID numérico real do administrador remoto.');"] : []),
      ] } }, { listen: 'test', script: { type: 'text/javascript', exec: [
        ...(write ? ['pm.execution.setNextRequest(null); // Uma ação explícita por execução; não encadear pair, aprovação ou logout.'] : []),
        `const expected = ${JSON.stringify(Object.keys(operation.responses).filter(code => Number(code) < 300).map(Number))};`,
        "pm.test('Status contratual de sucesso', () => pm.expect(pm.response.code).to.be.oneOf(expected));",
        "if (!expected.includes(pm.response.code)) { pm.execution.setNextRequest(null); throw new Error('Operação não concluída: consultar diagnóstico e conciliar.'); }",
        "const body = pm.response.json(); if (body.state === 'UNKNOWN' || body.reconciliationRequired || body.pending) pm.execution.setNextRequest(null);",
      ] } }] };
    if (write) { flags.push(example.flag); mutations.push({ name: operation.summary + ' - opt-in ' + example.flag, item: [item] }); }
    else queries.push(item);
  }
  return { info: { name: 'JRC Broker - controle Chatwoot por Account (ações manuais)',
    description: '15 operações existentes. Consultas e ações separadas; cada mutação exige sua variável allow_*=true, IDs reais e idempotência. Run All não habilita ações. Use apenas homologação autorizada; esta coleção não instala o CCLX, não publica Flow e não envia diretamente ao WhatsApp. Segredos, QR e respostas não devem ser publicados.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [...variables].map(key => ({ key, value: '', ...(key === 'jrc_api_key' ? { type: 'secret' } : {}) })).concat(flags.map(key => ({ key, value: 'false' }))),
    item: [{ name: 'Consultas (sem matrícula ou mutação)', item: queries }, ...mutations] };
}
