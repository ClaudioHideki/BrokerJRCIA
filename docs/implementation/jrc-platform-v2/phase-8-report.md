# Fase 8 — Observabilidade e saúde por camada

Data: 2026-09-21  
Branch: `codex/jrc-platform-v2-phase8-observability-20260921`

## Resultado

Falhas de canal, automação, worker, fila, provider e destino humano passaram a ter estados independentes no Health Center. O Execution Explorer reúne a cadeia operacional pelo `correlationId` e permite reconciliar efeitos externos incertos sem reenvio cego.

## Migration 0028

A migration `0028_operational_observability.sql` adiciona:

- heartbeats por organização, componente e instância;
- índice para localizar o heartbeat mais recente;
- decisões de reconciliação auditadas por execução, efeito e operador;
- função tenant-aware para registrar heartbeat;
- descoberta segura das organizações com canais ou automações;
- RLS, menor privilégio e grants específicos.

## Health Center

`GET /v1/operations/health` retorna estados distintos para:

- API;
- banco de dados;
- compatibilidade do schema;
- Redis;
- worker de mensagens;
- worker de automação;
- worker de integrações;
- scheduler;
- Evolution;
- Meta;
- destino Chatwoot/JRC Conversas;
- profundidade da fila;
- idade do item mais antigo da outbox;
- execuções com falha;
- execuções `UNKNOWN`.

Os estados são `UP`, `DEGRADED`, `DOWN` e `UNKNOWN`. Configuração sem observação real não é apresentada como conexão ativa. A interface atualiza automaticamente a cada 30 segundos e permite atualização manual.

## Heartbeats

Messaging Worker, Automation Worker, Automation I/O Worker e Scheduler registram heartbeat por tenant. O estado passa a `DOWN` quando a última observação ultrapassa 45 segundos. A descoberta inclui organizações ociosas que tenham canal ou automação, evitando que ausência de trabalho seja confundida com ausência do worker.

## Execution Explorer

O detalhe consolidado informa:

- execução, automação e versão imutável;
- canal, conversa e contato por UUID interno;
- timeline por node, tentativa e duração;
- duração total, estado e código de falha;
- correlation ID;
- outbox, efeito, tentativas, referência externa e resultado;
- input e output redigidos.

Segredos, senhas, tokens, autorização e credenciais são substituídos por `[REDACTED]`.

## Reconciliação de `UNKNOWN`

- O dispatcher persiste `UNKNOWN` antes da chamada externa.
- Uma queda do processo não provoca reenvio automático.
- `CONFIRMED_SENT` encerra o efeito como enviado.
- `CONFIRMED_NOT_SENT` é a única decisão que libera retry seguro.
- `UNRESOLVED` preserva o bloqueio.
- A decisão registra organização, execução, outbox, operador, evidência padronizada, resultado, referência externa opcional e horário.
- A API responde `automaticResend: false` para deixar explícita a fronteira operacional.

## Logs e alertas

Os logs HTTP JSON passaram a carregar `correlationId` e o UUID interno da organização após autenticação. A redação central continua removendo body, autenticação, cookies, tokens, QR Codes, telefones e credenciais.

As condições e ações locais estão documentadas em `docs/operations/observability-alerts.md`: schema incompatível, heartbeat ausente ou vencido, outbox envelhecida, fila elevada, provider ou destino degradado, crescimento de `UNKNOWN` e falhas repetidas de webhook. Nenhum SLO contratual foi inventado.

## Validação

- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run openapi:generate`: aprovado.
- `npm run security:contracts`: aprovado.
- Teste focado de Health Center e runtime: 2 arquivos e 5 testes aprovados.
- Testes focados de OpenAPI, segurança e observabilidade: aprovados.
- Suíte completa: 180 arquivos e 1.191 testes aprovados.
- `git diff --check`: aprovado.

## Operação e rollback

Após aplicar a migration, todos os quatro processos devem estar ativos para que os heartbeats fiquem verdes. O rollback da interface pode apontar novamente `/health` para a visão histórica anterior, sem remover as tabelas. As tabelas novas são expansivas e não alteram dados legados.

Não houve deploy, migration em produção ou alteração no servidor Dokploy.
