# 07 — UI/UX atual

## Broker React

Rotas: `/dashboard`, `/conexoes`, `/conexoes/nova`, `/conexoes/:id`, `/providers`, `/provisionamento`, `/mensagens`, `/flows`, `/whatsapp-oficial`, `/integracoes`, `/chaves-api`, `/uso-custos`, `/relatorios`, `/health`, `/brain`, `/minha-empresa`, além de `/jrc/*`, login, seleção de organização e embed.

| Atual | Estado | Alvo |
| --- | --- | --- |
| Conexões + Canais JRC + WhatsApp oficial | conceitos duplicados | consolidar em `/channels` |
| JRC Flows | editor v1 funcional | redirecionar para `/automations/:id/editor` |
| Mensagens e automações | mistura inbox/outbound/Typebot | separar mensagens e Automation Studio |
| JRC Conversas | integração única | `/integrations/jrc-conversas` + `/integrations/chatwoot` |
| Chaves de API | funcional | `/developers/api-keys` |
| Health/Reports/Usage | inicial | manter sob Operação |

## JRC Conversas Vue

O menu expõe `jrc_broker_connections` e `jrc_flows`. O conector mostra gerenciamento e pairing; o Flow local possui editor próprio. A UX alvo mantém apenas status/QR/reconexão por inbox para usuários operacionais. Configuração, bindings, automações e troca de identidade ficam no Broker.

Estados obrigatórios: CONNECTED, DISCONNECTED, PAIRING, QR_EXPIRED, VERIFYING_IDENTITY, IDENTITY_MISMATCH e ERROR com request ID. Tokens e IDs internos não devem aparecer.

Evidência: `apps/web/src/app/App.tsx`, `layout/AppShell.tsx`; JRC `components-next/jrc-broker`, rotas `jrcBroker`, `jrcFlows` e `Sidebar.vue`.
