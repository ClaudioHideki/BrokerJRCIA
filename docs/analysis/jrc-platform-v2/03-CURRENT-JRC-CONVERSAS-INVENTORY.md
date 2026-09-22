# 03 — Inventário atual do JRC Conversas

## Conector Broker — IMPLEMENTED/PARTIAL

O Rails armazena integração cifrada por conta, binding por inbox e grant por usuário. O browser chama Rails; Rails chama a Control API do Broker com chave server-to-server. Rotas de status, pair, disconnect, confirm-identity, grants e agentes existem. A tela `/accounts/:accountId/whatsapp-connections` é exposta pelo menu `jrc_broker_connections`.

Gap: `status`, `pair`, `disconnect` e `confirm_identity` passam por `JrcBroker::Control`, cuja autorização operacional combina membership e grant. O alvo elimina grant individual para status/pair no caminho gerenciado e proíbe disconnect/confirm replace ao operador.

Evidência: `jrc_broker_controller.rb`, `services/jrc_broker/*`, modelos `jrc_broker_*`, `components-next/jrc-broker`, rotas `jrcBroker`.

## Flow local — LEGACY, funcional

O motor JRC suporta message/note/media, variable, input com timeout, delay, condition, switch, contact, labels, status, assign, webhook, CRM, Nico e end. Há import/export, simulação, conexões Agent Bot, execução remota e histórico. O `workflow_engine.rb` interpreta subconjunto n8n: webhook/trigger/noOp, if, switch, Redis, set, HTTP Request, subworkflow e agent.

Componentes genéricos candidatos a portar como conceito: waits, switch, HTTP seguro, subflow, transformação JSON, QuickJS/sandbox e IA. Componentes que devem permanecer JRC ou ser adaptadores: contact/labels/status/assign e ações de CRM/Nico.

Evidência: `app/services/jrc_flows/*`, `jrc_flows_controller.rb`, modelos `jrc_flow*`, rotas `jrcFlows`, `services/flows-sandbox`.

## Propriedade futura

JRC Conversas permanece dono de inbox, agentes, equipes, atribuição, atendimento humano e CRM. Seu Flow local entra em modo LEGACY/migração; o Broker passa a ser o runtime novo canônico.
