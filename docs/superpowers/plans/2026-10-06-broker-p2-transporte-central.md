# P2 D — Transporte central para o runtime único

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, com superpowers:test-driven-development. Não delegar implementação.

**Goal:** Executar a mesma automação publicada para número originalmente conectado na central, com envio exclusivo pela API da central e transição explícita do executor antigo.
**Architecture:** Separar origem física do transporte de mensageria. Eventos autenticados viram mensagens e controles duráveis do runtime atual; não chamar executeFlow do legado. Reutilizar assinatura, cliente seguro, catálogo, controle e operações de atendimento. Transporte central nunca se apresenta como instância QR ou ativo Meta inventado.
**Tech Stack:** TypeScript strict, Zod, Fastify, PostgreSQL/RLS, Redis, React, Vitest.
**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md; parent 2026-10-05-broker-p2-independencia.md.

## Restrições globais
- Um executor por caixa e um caminho autoritativo de envio; central indisponível não vira standalone.
- Escopo organização/canal/integração/origem/Account/Inbox/revisões; não confiar em organização enviada no payload.
- HTTP fora de transação. Credencial, destino, propriedade e estado humano revalidados antes/depois de IO.
- UNKNOWN conserva bloqueio e reconciliação; não repetir POST cujo resultado é desconhecido.
- Pending é observação, nunca autorização de retomada. Humano prevalece sobre efeito não despachado.
- Sem credenciais, telefones ou dados de cliente em testes/documentação. Sem novo executor Rails.
- Número QR/Meta continua funcionando; nenhuma migração automática de transporte.
- Homologação externa permanece NOT_RUN até configuração final acordada com o usuário.

## Evidência de arquitetura e compatibilidade
- messaging_channels hoje exige provider META/BAILEYS e ativo físico; não é correto fabricar esses campos para central nativa.
- flows/chatwoot-service.ts executa executeFlow próprio; o cutover precisa remover essa propriedade por caixa antes do runtime atual.
- attendance-catalog hoje restringe Channel::Api; central nativa deve testar tipos reais sem supor capacidades pelo nome.
- Assinatura HMAC sobre timestamp + bytes originais, janela de cinco minutos, conforme [webhooks oficiais](https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks).
- AgentBot recebe eventos e responde pela API; retorno pending documentado na central não substitui nosso comando coordenado de retomada: [Agent bots](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots).
- A documentação é referência de protocolo, não prova de capacidade da versão instalada. DTO não documentado/ambíguo é rejeitado ou classificado como não verificado.

## Foco da revisão
1. Webhook de bot e webhook de integração do mesmo message ID: uma entrada, nenhuma duplicação de resposta.
2. Credencial/destino/propriedade trocam entre autenticação e gravação: recusar estado antigo.
3. Saída automática com atributo de eco forjado: não aceitar como prova de mensagem enviada pelo Broker.
4. Evento pending depois de tomada humana: não liberar bot nem reiniciar conversa.
5. POST remoto aceito antes de timeout: UNKNOWN e reconciliação, sem envio duplicado direto/central.

## Task 1 — Decodificação autenticada e escopo do evento
**Files:** Create integrations/chatwoot-runtime-event.ts; tests/unit/chatwoot-runtime-event.test.ts. Reuse integrations/secrets.ts e chatwoot-attendance-events.ts sem mudar o comportamento das rotas antigas.
**Interfaces:** decodeChatwootRuntimeEvent({raw, secret, timestamp, signature, binding, current, echo?, now?}). Binding persistido: organização, canal, integração, origem HTTPS normalizada, Account/Inbox, revisões destino/credencial/propriedade, status READY e transport CENTRAL_TRANSPORT. Current precisa coincidir exatamente.
- [x] RED: assinatura ausente/incorreta/replay/bytes alterados, conta/caixa aninhadas divergentes, contexto revogado/trocado, tamanho/JSON inválidos, ID unsafe, private, sender desconhecido, eco forjado e dedupe entre os dois webhooks.
- [x] Confirmar RED; implementar parser limitado, classificação conservadora e dedupe por escopo/mensagem (não por delivery ID, timestamp, token ou revisão transitória).
- [x] Aceitar apenas texto incoming de contact; nota/saída humana e controles são observações para bloqueio/reconciliação, não comandos de execução. Payload nunca fornece organização ou destino HTTP.
- [x] Testes focados e typecheck; nenhuma rota/runtime ativada só por este módulo. 94 focados e 1.842 na suíte final; achados de mídia/UTF-8 corrigidos com RED/GREEN. Evidência: ../../validation/2026-10-06-broker-p2-transporte-central.md.

## Task 2 — Canal central, persistência e ingresso durável
**Files:** Create migration 0046_central_transport.sql, messaging/central-transport.ts e integrations/chatwoot-runtime-ingress.ts; update messaging/types.ts, repository.ts, db/runtime-schema.ts, lifecycle inventory, contracts/channels-v1.ts e messaging/schemas.ts, channels/facade.ts, HTTP channels/integrations e app.ts.
**Interfaces:** transport discriminado BROKER_TRANSPORT/CENTRAL_TRANSPORT; central sem provider account/instance/Meta asset fictícios. Vínculo persistido aponta para destino aprovado e conta, versão/owner esperados. UNIQUE de origem/account/inbox controla reivindicação. Ingresso reserva message ID de ambos callbacks sob lock org+canal; registra contexto/revisões; materializa conversa/contact/message e encaminha somente ao createEventRouter atual.
- [ ] RED PostgreSQL: RLS/tenant, binding corrente, suspensão, credencial revogada, duplicate callback, troca concorrente e rollback; registry de migration e schema probe obrigatórios.
- [ ] Implementar persistência/ingresso sem HTTP em transação e sem autorizar bot pelo payload.
- [ ] Atualizar triggers de mirror: central-origin não gera MIRROR_MESSAGE nem CHATWOOT_REPLY para enviar novamente.
- [ ] Guardar entradas não autorizadas sem iniciar automação. Histórico não dispara bot.

## Task 3 — Saída exclusiva, recibo e reconciliação
**Files:** Create messaging/central-dispatcher.ts; update dispatcher.ts, worker.ts, commands/messaging-worker.ts, commands/automation-worker.ts e integração de catálogo/readiness.
**Interfaces:** resolver explícito para transporte central, sem else que caia no Meta. Reutilizar ChatwootClient.sendText/consulta canônica, outbox durável, mapping de IDs e revalidação de controle. SEND_TEXT local ACCEPTED não é entrega; recibo remoto observado não promete leitura no aparelho.
- [ ] RED: menu/pergunta/resposta/handoff no runtime real, transporte sintético identificado; token/destino trocados antes/depois IO; um só POST, nenhum envio QR/Meta/mirror.
- [ ] Implementar reserva → HTTP → confirmação; timeout/lease expirada = UNKNOWN, sem replay automático.
- [ ] Provar eco persistido e takeover antes de envio/entre ACK e commit; conflito bloqueia conclusão falsa.
- [ ] Catálogo remoto revalida membership/capacidade do tipo de inbox efetivo, sem paridade presumida.

## Task 4 — Cutover e configuração guiada
**Files:** Create central cutover operation service/HTTP/UI; reuse flows/chatwoot-service.ts revogação/reconciliação e attendance/transition.ts, onboarding/control auth e ChannelOperationSetup.
**Interfaces:** revisão esperada, operação idempotente, exclusividade por caixa, observar remoção do bot antigo antes de READY; preservar sessões antigas e rollback explícito. Wizard oferece origem de transporte somente após adaptador funcional; nunca troca webhook em silêncio.
- [ ] RED: executor legado ativo, desligamento incerto, duas empresas mesma caixa, webhook existente e rejeição de permissões atuais; teste de troca de tenant com operação pendente.
- [ ] Implementar transição/readback/revalidação, sem reutilizar token/binding de outra conta e sem execução paralela.
- [ ] Integrar perfil C: capacidades/callback individuais atuais e readiness sem confundir disponibilidade/publicação/entrega.

## Task 5 — Verificação e preparação do release
- [ ] Unit + PostgreSQL + HTTP/UI + build/OpenAPI + contratos/bundle/audit + diffcheck e revisão independente.
- [ ] Publicar branch, integrar main após gates; CI E2E e imagens vinculadas ao mesmo SHA/digests. Não repetir E2E completa local recusada.
- [ ] Registro de instalação/rollback/migrations/flags não secretas para usuário executar no Dokploy.
- [ ] Manter testes reais JRC A/B/Chatwoot externo pendentes e seguir fases P3–P10 do programa; D local não prova homologação externa.
