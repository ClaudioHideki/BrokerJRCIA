# 02 — Inventário atual do Broker

## Platform/SaaS — IMPLEMENTED/PARTIAL

Organizações, usuários, memberships, papéis tenant, sessões, Super Admin, limites e auditoria possuem persistência e APIs. Feature flag de Flows existe por organização. Suporte e monitoramento são superfícies iniciais, não uma central completa.

Evidência: migrações `0002`, `0010`, `0011`; `modules/platform`, `modules/memberships`, `modules/audit`; rotas `platform.ts` e `tenant-operations.ts`.

## QR/Evolution — IMPLEMENTED

Provider account, instância, connect/disconnect, challenge QR, status, settings, operações idempotentes, identidade esperada, webhook assinado, mídia e persistência existem. O controle delegado possui status/pair/confirm-identity e auditoria. A UX ainda distribui o conceito entre Conexões, Canais JRC e integrações.

Evidência: `modules/instances`, `modules/integrations/chatwoot-control-*`, `packages/providers/src/evolution`, rotas `instances.ts`, `instance-workspace.ts`, `chatwoot-control.ts`.

## Meta — PARTIAL/CONFIG_ONLY

Embedded Signup, state descartável, troca de code no servidor, validação WABA/phone, cifragem, register, refresh, revoke, webhook HMAC, ingest e envio existem. Produção depende das seis variáveis Meta e homologação externa. Gestão completa do ciclo de templates e inputs interativos não existe.

Evidência: `pages/MetaConnect.tsx`, `modules/meta-onboarding`, `routes/meta-*`, `packages/providers/src/meta`.

## Messaging — IMPLEMENTED/PARTIAL

Contacts, conversations, messages, outbox, leases, retries seguros, UNKNOWN, mídia, templates, modo BOT/HUMAN, ingest deduplicado e worker automático existem. Templates avançados, campanhas e normalização completa de contatos/localização/interativos são gaps.

Evidência: migrações `0009`, `0013`, `0016`, `0017`; `modules/messaging`; `routes/messaging.ts`.

## Chatwoot/JRC — IMPLEMENTED/PARTIAL

Destino por tenant, conta/token cifrado, inboxes, provisionamento, Agent Bot, eventos assinados, controle delegado, onboarding e embed estão implementados e protegidos por flags. A autorização operacional ainda usa grants próprios em parte do caminho e o Dashboard App depende de compatibilidade externa.

Evidência: migrações `0014`–`0023`, `modules/integrations`, `routes/integrations.ts`, `chatwoot-control.ts`, `chatwoot-embed.ts`.

## Flow atual — IMPLEMENTED/PARTIAL

Draft, validação, simulação, versão imutável, publicação, sessões, runs, vínculo direto e Agent Bot existem. Nós: start, message, input, menu, condition, variable, handoff e end. O runtime é textual/síncrono por turno; não possui waits duráveis gerais, credenciais, HTTP, SQL, sandbox, scheduler ou executor por nó persistido.

Evidência: migrações `0024`, `0025`; `modules/flows`; `packages/contracts/src/flows.ts`; `pages/Flows.tsx`.
