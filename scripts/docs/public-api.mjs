import { operationGuide } from './operation-guide.mjs';
export { buildControlPostman } from './postman-control.mjs';
const profiles = {
  messaging: {
    title: 'Mensageria — API JRC para sistemas parceiros',
    description: 'Tenant inferido da chave JRC. Use messaging:read para consultas e messaging:send para texto QR; ativar canal exige também instances:write. media:upload permite carregar/consultar arquivo privado; envio por referência exige messaging:send e media:send. Chaves anteriores não recebem novos scopes automaticamente. Perfil individual WhatsApp QR, sem grupos, templates Meta ou gestão de Flows. Não exige URL, Account ID ou credencial Chatwoot. Upload 201 retorna estado READY/STORING/FAILED; envio 202 confirma fila, não entrega. Nunca repita uma operação UNKNOWN com outra chave de idempotência.',
    operations: [
      ['post','/v1/messaging/instances/{id}/partner-activate'],
      ['get','/v1/messaging/channels'],
      ['get','/v1/messaging/channels/{id}/conversations'],
      ['get','/v1/messaging/conversations/{id}'],
      ['get','/v1/messaging/conversations/{id}/messages'],
      ['get','/v1/messaging/media/{id}'],
      ['post','/v1/messaging/channels/{id}/partner-text'],
      ['post','/v1/messaging/channels/{id}/media'],
      ['get','/v1/messaging/channels/{id}/media/{mediaId}'],
      ['post','/v1/messaging/channels/{id}/partner-media'],
    ],
  },
  events: {
    title: 'Eventos e webhooks assinados — API JRC',
    description: 'Exige webhooks:manage. Endpoint do consumidor pode ser cadastrado depois da emissão da chave. Entrega ao menos uma vez com HMAC-SHA256 e tentativas limitadas; deduplique eventId. Ordem de entrega não é garantida; use cursor e não reverta estados mais recentes. Polling retém 30 dias e retorna 409 quando o cursor expira. O segredo de assinatura é separado da chave de API. Revogar uma chave de API não revoga automaticamente endpoints: revogue-os explicitamente.',
    operations: [
      ['get','/v1/partner-webhooks'], ['post','/v1/partner-webhooks'],
      ['delete','/v1/partner-webhooks/{id}'], ['get','/v1/partner-events'],
      ['get','/v1/partner-webhook-deliveries'],
    ],
  },
  instances: {
    title: 'Conexões WhatsApp — API JRC',
    description: 'Conexões da organização. Use X-JRC-API-Key com instances:read ou instances:write. A chave identifica o tenant; não envie organizationId. A modalidade oficial depende do onboarding Meta. Não são endpoints diretos do motor interno.',
    operations: [
      ['get', '/v1/provider-accounts'],
      ['get', '/v1/instances'], ['post', '/v1/instances'],
      ['get', '/v1/instances/{id}'], ['post', '/v1/instances/{id}/connect'],
      ['get', '/v1/instances/{id}/status'], ['post', '/v1/instances/{id}/disconnect'],
    ],
  },
  chatwoot: {
    title: 'Integração direta Chatwoot — controle JRC',
    description: 'Perfil opcional para uma Account Chatwoot vinculada ao Broker. Origem HTTPS aprovada, Account e revisão pertencem ao vínculo da credencial; não envie organizationId/accountId para escolher outra empresa. Exige chave de controle específica chatwoot:read/manage/pair/disconnect; a chave genérica de instâncias não autoriza esse perfil. Novos vínculos QR criados por administrador/manage podem matricular a primeira identidade automaticamente sob intenção finita e verificação do provider, contexto e inbox. GET não aprova identidade; legado e troca de número conservam confirmação administrativa. Mensagens dos agentes retornam pelo webhook da caixa. Flow possui credencial e contrato separados; este perfil não publica bots nem comprova homologação CCLX.',
    operations: [
      ['get', '/v1/integrations/chatwoot/control/context'],
      ['get', '/v1/integrations/chatwoot/control/resources'],
      ['get', '/v1/integrations/chatwoot/control/onboarding'],
      ['post', '/v1/integrations/chatwoot/control/onboarding'],
      ['get', '/v1/integrations/chatwoot/control/onboarding/{operationId}'],
      ['post', '/v1/integrations/chatwoot/control/onboarding/{operationId}/recover'],
      ['get', '/v1/integrations/chatwoot/control/connections/{integrationId}/status'],
      ['post', '/v1/integrations/chatwoot/control/connections/{integrationId}/pair'],
      ['get', '/v1/integrations/chatwoot/control/connections/{integrationId}/pair-operations/{operationId}'],
      ['post', '/v1/integrations/chatwoot/control/connections/{integrationId}/confirm-identity'],
      ['post', '/v1/integrations/chatwoot/control/connections/{integrationId}/disconnect'],
      ['put', '/v1/integrations/chatwoot/control/connections/{integrationId}/agents'],
      ['get', '/v1/integrations/chatwoot/control/connections/{integrationId}/campaign-transport'],
      ['post', '/v1/integrations/chatwoot/control/connections/{integrationId}/campaign-intents'],
      ['get', '/v1/integrations/chatwoot/control/connections/{integrationId}/conversations/{conversationId}/campaign-messages/{messageId}'],
    ],
  },
};

export function buildPublicDocument(document, profile) {
  const selected = profiles[profile];
  if (!selected) throw new Error('PUBLIC_DOCUMENT_PROFILE_UNKNOWN');
  const result = {
    openapi: document.openapi,
    info: { title: selected.title, version: '2026-10-29', description: selected.description },
    servers: [{ url: '/', description: 'Esta instalação do Broker JRC' }],
    paths: {}, components: { securitySchemes: {} },
  };
  for (const [method, route] of selected.operations) {
    const operation = document.paths?.[route]?.[method];
    if (!operation) throw new Error(`PUBLIC_DOCUMENT_OPERATION_MISSING: ${method.toUpperCase()} ${route}`);
    result.paths[route] ??= {};
    result.paths[route][method] = structuredClone(operation);
    const guide = operationGuide[method.toUpperCase() + ' ' + route];
    if (!guide) throw new Error(`PUBLIC_DOCUMENT_GUIDE_MISSING: ${method.toUpperCase()} ${route}`);
    result.paths[route][method].summary = guide.title;
    result.paths[route][method].description = `${guide.purpose}\n\nEscopo da chave: ${guide.scope}. Os schemas abaixo são os da rota real. IDs e permissões são verificados no tenant autenticado.`;
    if (document.paths[route].parameters) result.paths[route].parameters = structuredClone(document.paths[route].parameters);
    for (const requirement of operation.security ?? document.security ?? []) {
      for (const name of Object.keys(requirement)) {
        if (!document.components?.securitySchemes?.[name]) throw new Error('PUBLIC_DOCUMENT_SECURITY_MISSING');
        result.components.securitySchemes[name] = structuredClone(document.components.securitySchemes[name]);
      }
    }
  }
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref && !seen.has(value.$ref)) {
      if (!value.$ref.startsWith('#/components/')) throw new Error('PUBLIC_DOCUMENT_EXTERNAL_REFERENCE');
      seen.add(value.$ref);
      const parts = value.$ref.slice(2).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
      let source = document;
      for (const part of parts) source = source?.[part];
      if (!source) throw new Error(`PUBLIC_DOCUMENT_REFERENCE_MISSING: ${value.$ref}`);
      let target = result;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)] = structuredClone(source);
      visit(source);
    }
    for (const nested of Object.values(value)) visit(nested);
  }
  visit(result.paths);
  return result;
}

export function buildReadOnlyPostman(contract) {
  return {
    info: { name: contract.info.title + ' — consultas', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'broker_origin', value: '' }, { key: 'jrc_api_key', value: '', type: 'secret' }],
    item: Object.entries(contract.paths).filter(([, item]) => item.get).map(([route, methods]) => ({
      name: 'GET ' + route,
      request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-JRC-API-Key', value: '{{jrc_api_key}}' }],
        url: '{{broker_origin}}' + route.replace(/\{([^}]+)\}/g, '{{$1}}'),
        description: methods.get.description + '\n\nPreencha a origem fornecida pela JRC e os IDs reais do seu tenant. O placeholder id tem o tipo de recurso indicado nesta rota; não reutilize um ID de canal como ID de mensagem/anexo. Credencial não incluída. Consulta executada somente ao clicar Send.' },
    })),
  };
}

export const publicProfiles = Object.freeze(Object.keys(profiles));
