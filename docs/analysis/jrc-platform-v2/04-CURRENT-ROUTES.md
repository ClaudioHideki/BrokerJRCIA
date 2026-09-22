# 04 — Inventário de rotas atuais

Fonte: `docs/api/openapi.json` da revisão `7e01151` e arquivos em `apps/api/src/http/routes`.

| Família | Métodos/caminhos principais | Auth/papel | Módulo | Alvo |
| --- | --- | --- | --- | --- |
| Auth tenant | `POST /v1/auth/{login,logout,refresh,select-organization}` | pública/cookie conforme ação | auth | KEEP |
| Auth console | `POST /v1/console/auth/*` | credencial delegada | console-auth | KEEP |
| Platform | `/v1/platform/auth/*`, `/v1/platform/organizations*` | Super Admin | platform | KEEP |
| Organização | `GET /v1/organization/{overview,operations}` | JWT tenant | operations | CONSOLIDATE |
| Providers | `GET /v1/provider-accounts` | JWT tenant | provider accounts | LEGACY facade |
| Instâncias | `/v1/instances*` | JWT + papel por ação | instances | REDIRECT para channels |
| Messaging | `/v1/messaging*` | JWT + OWNER/ADMIN/OPERATOR | messaging | KEEP interno |
| Meta | `/v1/meta-onboarding*`, `/v1/webhooks/meta` | tenant admin; webhook HMAC | Meta | CONSOLIDATE em channels |
| Flows | `/v1/flows*` | read/write tenant; feature flag | flows | COMPATIBILITY alias |
| Chatwoot | `/v1/integrations/chatwoot*` | tenant/platform/control key | integrations | KEEP sob Atendimento |
| Embed | `/v1/embed*` | autorização efêmera assinada | embed | KEEP/PARTIAL |
| API keys | `/v1/api-keys*` | tenant admin | api-keys | MOVE para developers |

## Rotas Flow existentes

CRUD parcial, import-preview, export, validate, simulate, publish, channels, bind/unbind, runs, inboxes Chatwoot, bind/disable e webhook Agent Bot estão presentes. Não há delete, versões listáveis, binding resource uniforme, execution explorer, cancel/resume/retry, catálogo de nós ou credentials API.

## Control API

`/v1/integrations/chatwoot/control` possui context, resources, onboarding e conexões com status/pair/disconnect/confirm-identity/agents. Deve manter compatibilidade enquanto um contrato v2 passa a autorizar operações operacionais por prova de account+inbox+membership.

Inventário integral verificável: todas as 95 operações constam no OpenAPI versionado. Antes de implementar v2, gerar CSV automaticamente desse artefato e adicionar colunas `AUTH`, `ROLE` e `TARGET STATUS` validadas contra os preHandlers.
