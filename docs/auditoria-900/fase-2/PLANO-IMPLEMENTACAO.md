# Fase 2 — correções da auditoria

> Execução incremental com TDD, revisão e relatório por item. A missão de implementação de 29/10/2026 é a especificação vinculante; os 14 relatórios registram a base histórica, não devem ser reescritos como se descrevessem as correções.

**Objetivo:** preparar continuidade, custódia de mídia, logs, ordenação, reprocessamento e orçamento de recursos para revisão local, sem publicação ou produção.

**Base:** `9e62ceaf3177979a68bc4985a93e25474de48487`; branch `codex/broker-audit-fixes-20261029`, no worktree isolado existente. Os dois arquivos Postman previamente modificados e os anexos da auditoria são preservados.

**Arquitetura:** conservar outbox PostgreSQL, RLS e autoridade atual. Recebimento de um webhook, ACK de entrega, recibo de mídia e elegibilidade de retenção são fatos distintos. Novos contratos são aditivos, versionados e com autorização explícita. Nenhum coletor de retenção será habilitado por default.

## Decisões de execução

- B02: uma fila no receptor não corrige perda antes de a Evolution emitir o HTTP. Primeiro comprovar essa fronteira e preparar integração durável na origem; manter bloqueada qualquer afirmação de continuidade completa até existir integração com a engine/imagem atestada. Não editar o submódulo fixado nem trocar a engine de produção.
- B03: primeiro incremento funcional de custódia: recibo idempotente autenticado, correspondência de tenant/canal/mensagem/mídia/checksum/tamanho e política de conservação. Default KEEP; nenhum DELETE de bytes. Prazos, destinos e GC destrutivo dependem do acordo bilateral e de homologação do storage. A avaliação de elegibilidade deve declarar essa fronteira, não simular limpeza.
- B05: endurecer logs sob controle JRC e configurações exemplificadas; a sanitização do processo Evolution externo exige imagem/configuração atestadas e continua identificada separadamente.
- B07: watermark por instância e binding antes de qualquer efeito de identidade/estado. Eventos antigos ou conflitantes no mesmo instante não podem regredir uma conexão nova. Legados sem timestamp só conservam comportamento quando ainda não existe watermark.
- B12: replay explícito de FAILED, mesmo eventId/destino e intenção idempotente; preservar evidência de tentativas, revogação e expiração. Nunca reenviar WhatsApp ao reprocessar webhook.
- B13: diagnóstico de pools por processo/réplica/rollout e admissão por quota; não elevar quotas nem tamanhos por suposição de capacidade.

## Restrições globais

- Sem deploy, merge, push, dados reais, ENV produtivo, carga, números reais ou mudanças no LAB2.
- Não substituir PostgreSQL por Redis; não reemitir mensagens de resultado UNKNOWN.
- Migrations apenas aditivas e documentadas, com reversão operacional conservadora. Nunca aplicar em produção nesta tarefa.
- Preservar isolamento, lifecycle, compatibilidade da API pública e atribuições da Evolution.
- Logs/evidências somente sintéticos, sem segredos. Dependências externas indisponíveis ficam NÃO EXECUTADAS; não usar serviços produtivos como alternativa.

## Tarefas e verificação

### 1. B02 — fronteira de continuidade na origem
- [ ] Reproduzir a perda do retry em memória e comparar opções sem inventar garantia no receptor.
- [ ] Implementar somente a parte durável que possa ser integrada e testada com segurança; registrar explicitamente a dependência da engine quando não puder ser fechada.
- [ ] Testes de queda/ACK perdido, deduplicação, replay, autoridade e indisponibilidade do banco antes de confirmar aceitação.
- [ ] Relatório do item com estado completo/parcial/bloqueado, arquivos e limite da prova.

### 2. B03 — custódia de mídia
- [ ] RED: receipt divergente, outra organização/canal/mensagem, mídia incompleta, credencial revogada, replay e conflito.
- [ ] GREEN: tabela com RLS/FKs/lifecycle, serviço e contratos HTTP aditivos; receipt não promove mídia incompleta nem executa exclusão.
- [ ] Política KEEP por default e avaliação conservadora; documentar o que ainda depende do CCLX.
- [ ] Testes unitários/HTTP e integração PostgreSQL preparada ou executada somente em cluster lab exclusivo.

### 3. B05 — logs JRC
- [ ] RED para formatos de eventos/erro/headers que possam escapar da redaction.
- [ ] Correção mínima e regressão, distinguindo logging externo Evolution.

### 4. B07 — eventos de conexão
- [ ] RED para close antigo após open, empate conflitante, timestamp inválido e legado após watermark.
- [ ] GREEN antes de identidade, grupos e UPDATE de instância; migration e testes concorrentes de integração.

### 5. B12 — reprocessamento e observabilidade
- [ ] RED para replay repetido/conflitante, outro tenant, endpoint revogado, delivery ativa e evento expirado.
- [ ] GREEN com ledger, mesmos IDs, contadores preservados e consultas sem payload/segredos.
- [ ] Contratos, OpenAPI e controles de segurança atualizados sem remover rotas existentes.

### 6. B13 — pools e quotas
- [ ] RED para orçamento omitindo history worker, réplicas/rollout e entradas inválidas.
- [ ] GREEN com relatório sem DSNs e sem mudar limites comerciais automaticamente.

### 7. Consolidação
- [ ] Typecheck/build e testes afetados; suíte geral; serviços apenas se realmente disponíveis e isolados.
- [ ] Revisão independente, correções com regressão e `git diff --check`.
- [ ] Relatório final por item, migrations/rollback, riscos residuais e prontidão para revisão de PR; sem criar/publicar PR nesta etapa.

## Foco da revisão

Autoridade que vence durante espera de lock; recibo do cliente que não corresponde aos bytes; mesma mídia referenciada por várias mensagens; efeitos de identidade disparados antes do filtro temporal; replay concorrente ou tardio que apaga evidência. Cada implementação deve testar a classe que lhe cabe. Capacidade física e confirmação de guarda no CCLX real continuam fora da prova local.
