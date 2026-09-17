# Evidências de origem

Data de consulta: 16/09/2026. Leitura estática via conector GitHub e documentação oficial. Relatorios históricos dos repositórios são declaracoes da entrega anterior, não execucoes feitas nesta preparação.

## Revisoes consultadas

- Broker: `9e530170cdda90ee8b9b673a28723180e0b2e1a3`.
- JRC Conversas: `62c14af884c7f45fa640345556f2ffecc22113d8`.

## Broker: pontos existentes e implicacoes

| Arquivo | Evidencia | Consequencia no plano |
|---|---|---|
| `apps/api/src/modules/integrations/chatwoot-service.ts` | Compara conta com `env.origin`; token cifrado; callback por integração | Resolver origem por organização preservando modo gerenciado |
| `apps/api/src/modules/integrations/runtime.ts` | Carrega origem global e configura worker/mídia | Atualizar todos os caminhos, não apenas formulário |
| `apps/api/src/http/routes/integrations.ts` | Guard JWT; escrita OWNER/ADMIN | Adicionar controle S2S específico sem abrir guards legados |
| `apps/api/src/http/plugins/authorization.ts` | OPERATOR pode conectar; API key usa instances:write | Chave do BFF com escopos novos e binding; usuário externo restrito não e OPERATOR |
| `apps/api/src/http/routes/instances.ts` | Create/connect/status/disconnect e Idempotency-Key | Reutilizar InstanceService, não chamar engine pelo frontend |
| `packages/contracts/src/instances/schemas.ts` | QR_CODE / DATA_URL ou BASE64 / expiresAt | Reutilizar o contrato em vez de inventar GET qrcode |
| `apps/api/src/db/integrations-schema.ts` | Uma conta por organização; mappings e jobs | Manter cardinalidade e invariantes existentes |
| `infra/web/server.mjs` | frame-ancestors none; XFO DENY | Excecao restrita a nova rota embed |
| `package.json` | npm workspaces, scripts de teste/build/segurança | Comandos do plano partem dos scripts reais |
| `docs/architecture/2026-09-15-integracao-chatwoot.md` | Mídia cifrada no PostgreSQL; sem homologação implicita | Não impor S3 nem declarar número real validado |

Links imutaveis para consulta do executor:

```text
https://github.com/ClaudioHideki/BrokerJRCIA/tree/9e530170cdda90ee8b9b673a28723180e0b2e1a3
https://github.com/ClaudioHideki/BrokerJRCIA/blob/9e530170cdda90ee8b9b673a28723180e0b2e1a3/apps/api/src/modules/integrations/chatwoot-service.ts
https://github.com/ClaudioHideki/BrokerJRCIA/blob/9e530170cdda90ee8b9b673a28723180e0b2e1a3/apps/api/src/http/routes/integrations.ts
https://github.com/ClaudioHideki/BrokerJRCIA/blob/9e530170cdda90ee8b9b673a28723180e0b2e1a3/packages/contracts/src/instances/schemas.ts
https://github.com/ClaudioHideki/BrokerJRCIA/blob/9e530170cdda90ee8b9b673a28723180e0b2e1a3/infra/web/server.mjs
```

## JRC Conversas

| Arquivo | Evidencia | Consequencia |
|---|---|---|
| `AGENTS.md` | Worktrees, Composition API, Tailwind, i18n e overlays enterprise | Preservar padrões e revisar extensoes |
| `app/policies/inbox_policy.rb` | Criação/atualização administrativas | Não liberar Settings para agentes; criar permissão específica |
| `app/controllers/api/v1/accounts/base_controller.rb` | Current.account e verificação de habilitacao da API | Reutilizar autenticação e escopo existentes |
| `app/controllers/api/v1/accounts/dashboard_apps_controller.rb` | Payload dashboard_app/title/content | Possivel provisionamento do app, condicionado a contrato do destino |
| `app/javascript/dashboard/components/widgets/conversation/ConversationHeader.vue` | Cabeçalho tem inbox/contexto da conta | Ponto de entrada para agente delegado |
| `app/javascript/dashboard/routes/dashboard/settings/inbox/ChannelFactory.vue` | Fabrica de componentes de canal | Acrescentar card/componente JRC sem criar novo transporte |
| `app/models/channel/api.rb` | Channel::Api e secret | Reutilizar caixa API |
| `lib/webhooks/trigger.rb` e `app/listeners/webhook_listener.rb` | Emissao assinada com segredo da inbox | Validar contra corpo bruto; testar entrega quando broker indisponivel |
| `package.json` | Scripts pnpm e versão declarada 4.16.2 | Versão do fork não comprova versão do servidor implantado |

```text
https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado/tree/62c14af884c7f45fa640345556f2ffecc22113d8
https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado/blob/62c14af884c7f45fa640345556f2ffecc22113d8/AGENTS.md
https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado/blob/62c14af884c7f45fa640345556f2ffecc22113d8/app/policies/inbox_policy.rb
https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado/blob/62c14af884c7f45fa640345556f2ffecc22113d8/app/controllers/api/v1/accounts/dashboard_apps_controller.rb
```

## Documentacao externa consultada

```text
https://developers.chatwoot.com/api-reference/introduction
https://developers.chatwoot.com/api-reference/inboxes/create-an-inbox
https://developers.chatwoot.com/api-reference/inboxes/get-an-inbox
https://developers.chatwoot.com/api-reference/webhooks/add-a-webhook
https://www.chatwoot.com/hc/user-guide/articles/1677691702-how-to-use-dashboard-apps
https://www.chatwoot.com/hc/user-guide/articles/1777049915-como-usar-aplicativos-de-painel
https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors
```

Dashboard App e uma aplicacao incorporada no contexto da conversa, não um instalador remoto de novos componentes Vue. A documentação distingue Application, Client e Platform APIs. Os controles de DNS e redirecionamento seguem o problema documentado pela OWASP; as regras operacionais adicionais são decisões desta especificação.
