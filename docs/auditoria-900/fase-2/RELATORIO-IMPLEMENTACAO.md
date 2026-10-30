# Broker JRC — fechamento da execução da Fase 2

Data de referência: 29/10/2026. Repositório BrokerJRCIA. Base e HEAD: `9e62ceaf3177979a68bc4985a93e25474de48487`. Branch local: `codex/broker-audit-fixes-20261029`.

**Parecer: incremento local implementado parcialmente, apto a revisão técnica em rascunho; não liberado para publicação, merge ou piloto físico.** A execução atual está encerrada. B02 não foi implementado; B03 é fundação de recibo/guarda, não custódia definitiva homologada. Nenhuma capacidade de 50/400/900 números ou 250.000 mensagens/dia foi demonstrada.

## 1. Status por item e critério de conclusão

| Item | Status | Entregue e comprovado | O que impede conclusão integral |
|---|---|---|---|
| B02 | **Bloqueado** | Diagnóstico da perda antes do HTTP Broker; probes sintéticas do retry extraído da fonte; decisão técnica registrada. | Falta outbox atômica no produtor Evolution, dispatcher durável, integração na imagem derivada/atestada e ensaios reais de queda/restart/ACK perdido. Um spool no receptor não resolve a lacuna. |
| B03 | **Parcial** | Recibo autenticado/idempotente, vínculo tenant/canal/mensagem/mídia/hash/tamanho; política KEEP explícita; SQL e regressões locais. | PostgreSQL/RLS/concorrência e storage do cliente não homologados; falta política bilateral de retenção/órfãos/backup/restore e futura limpeza segura. Não há GC implementado. |
| B05 | **Parcial** | Sanitização de envelopes, identificadores, erros e arrays cíclicos nos componentes JRC; regressões e revisão independente. | stdout/configuração e imagem efetiva Evolution não atestados. Mensagens livres de log ainda exigem eventos estáticos; não existe sanitização infalível de texto arbitrário. |
| B07 | **Parcial** | Watermark por instância/binding, filtro antes dos efeitos de identidade e locks na ordem corrigida; regressões unitárias. | Locks/RLS/concor­rência reais e reconciliação com polling não homologados. Recuo de relógio/fuso no mesmo binding requer tratamento operacional. |
| B12 | **Parcial** | Replay explícito de FAILED preservando eventId/deliveryId/destino, ledger, tentativas acumuladas e agregados sem conteúdo; API/serviço testados. | SQL/fences/grants/lifecycle não executados em PostgreSQL real; faltam interleavings adicionais e perfil de custo dos agregados. O consumidor precisa deduplicar evento após ACK perdido. |
| B13 | **Parcial** | Planejador soma pools partner/history/fontes/rollout; helper history padronizado sem elevar teto/default; validação de entradas. | Inventário real de réplicas/Evolution/fontes e reserva operacional ainda não coletado; quotas e deadlines precisam de SLO aprovado e medições. Não houve aumento arbitrário de limites. |
| B14 | **Parcial** | Risco de bloqueio entre tenants documentado; novos agregados ajudam diagnóstico. | Distribuição justa sob receptor lento/tenant grande não medida. Scheduler/fairness não alterado e nenhum benchmark executado. |

Os status cobrem os critérios originais da auditoria, não apenas a existência de código. Partes locais de B03/B05/B07/B12/B13 estão prontas para **revisão de PR em rascunho**, sem alegação de prontidão para merge/release. B02 e benchmark B14 não estão prontos para aceite.

## 2. Alterações e migrations

Lista exaustiva: [ARQUIVOS-ALTERADOS.md](ARQUIVOS-ALTERADOS.md). Inclui **60 arquivos de código/teste/contrato/artefato** além dos relatórios desta fase. Os dois arquivos anteriores do download Postman estão separados e preservados.

| Migration nova | Alterações principais | Dependência/rollback conservador |
|---|---|---|
| `0075_media_custody.sql` | Recibos imutáveis, RLS FORCE, autoridade, FKs de referência, integridade e catálogo/lifecycle; UNIQUE adicional nas mensagens. | Requer baseline0074 e roles existentes. Retirar exposição do contrato em rollback e preservar recibos/constraints; não apagar evidência nem bytes. |
| `0076_qr_connection_watermark.sql` | Timestamp e fingerprint nullable por instância, checks de escopo/HEX. | Manter colunas ao voltar binário; não inventar backfill. |
| `0077_partner_delivery_replay.sql` | Contadores cumulativos, ledger, funções autorizadas e fences; helper privado de catálogo para readiness. | Suspender novos replays ao voltar binário, preservar ledger/colunas. Remoção física exige tarefa própria. |

Journal integrado em sequência, baseline de runtime0077 e schema declarativo atualizados. Leitura offline confirmou77 migrations, índices contínuos, timestamps crescentes e arquivos presentes. **Nenhuma migration foi executada**, nem localmente contra PG nem em produção. Tempo de lock, tamanho do índice UNIQUE e custo do backfill de contadores ainda precisam ser medidos no laboratório antes de planejar manutenção.

### Contratos aditivos preparados, ainda não publicados

| Método/caminho | Uso e autorização | Resultado |
|---|---|---|
| POST `/v1/media-custody/receipts` | API key `media:archive`, UUID Idempotency-Key, corpo estrito schemaVersion1. Credenciais de controle Chatwoot não podem arquivar. | 201; recibo canônico ou replay; nunca prova armazenamento físico. |
| GET `/v1/media-custody/receipts/{id}` | Mesma autorização e isolamento de tenant. | 200; recibo sem segredos. |
| GET `/v1/media-custody/receipts/{id}/retention` | Mesma autorização. | 200; KEEP, eligibleForDeletion:false, physicalStorageVerified:false. |
| POST `/v1/partner-webhook-deliveries/{id}/replay` | API key `webhooks:manage`, UUID Idempotency-Key, corpo{}, somente FAILED retido e destino ativo. | 200; mesmo evento/delivery, uma nova intenção/ciclo. **Não reenvia WhatsApp**. |
| GET `/v1/partner-webhook-delivery-stats` | API key `webhooks:manage`; filtro endpointId opcional. | 200; contagens, leases vencidas, replays e tentativas acumuladas na janela retida30dias. |

Canonical OpenAPI:350→355 operações, **zero removidas**. Comparação após resolver referências encontrou mudanças existentes apenas em GET/POST api-keys, pela inclusão do scope `media:archive` (max8→9). Chaves antigas não ganham esse scope automaticamente; checkbox novo começa desmarcado. Os perfis públicos filtrados e o PDF interno continuam com37 operações anteriores: não foram ampliados para comercializar estes contratos ainda não homologados. O PDF/manifesto interno foi regenerado apenas para sincronizar a proveniência e permitir o build; oito páginas renderizadas e inspecionadas, sem redesenho.

## 3. Verificações e resultados

| Verificação | Resultado final | Evidência no ZIP |
|---|---|---|
| `npm test -- --maxWorkers=2` | Exit0; contagem exata abaixo. Sem PG/Redis/MinIO reais nesta configuração. | `evidencias/npm-test-final.log` |
| `npm run typecheck` | PASS, exit0. | `evidencias/typecheck-final.log` |
| `npm run build` | PASS, exit0; aviso de bundle grande do Vite permanece. | `evidencias/build-final.log` |
| Lint | **Não executado: não existe script lint/configuração de lint no package.json da raiz.** Não foi inventado um linter para encerrar a fase. | package.json na fonte base; `git diff --check` separado. |
| `git diff --check` | PASS, exit0; avisos de normalização LF/CRLF não são erros de whitespace. | `evidencias/diff-check.log` e `.exit` |
| Repetição focada da consolidação |7 arquivos/63 testes PASS. | `evidencias/consolidation-tests-green.log` |
| Compilados |1 arquivo/1 teste PASS;1 arquivo/1 teste SKIP por faltar DSNs PG/Redis. | `evidencias/compiled-final.log` |
| Contratos públicos | PASS. | `evidencias/security-contracts.log` |
| Licenças/avisos frontend | PASS,7 pacotes. | `evidencias/security-notices.log` |
| Submódulo Evolution | PASS; SHA fixado `fa09d37892cdbb1d65a250155d293d92230c5b30`, sem alterações. | `evidencias/security-submodule.log` |
| Bundle web | PASS;32 arquivos, zero achados desse scanner. | `evidencias/security-bundle.log` |
| Gate automatizado local de release | PASS,355 operações, zero achados dos scanners executados. Não é autorização/release nem pentest. | `evidencias/security-release.log` e `security-release.json` |
| OpenAPI | Geração PASS; inventário e segurança das cinco rotas testados. | `evidencias/openapi-final.log`, `openapi-semantic-diff.json` |

```text
Test Files  462 passed (462)
Tests  3600 passed (3600)
Duration  495.68s (transform 23.04s, setup 202.12s, import 224.00s, tests 272.59s, environment 141.23s)
```

A primeira rodada geral teve **7 arquivos com falha/455 aprovados;8 testes falhos/3.592 aprovados**. Expec­tativas de inventário de rotas, slices/baseline de migrations, consulta de catálogo e teste estrutural durante a consolidação foram corrigidas; os sete arquivos passaram na repetição focada. A rodada geral final foi iniciada depois de estabilizar código e expectativas. O build inicial falhou com PUBLIC_DOCUMENT_PDF_STALE_REGENERATE e passou após regeneração rastreada do PDF/manifesto. Os logs anteriores também estão incluídos, sem ocultar as falhas.

Regressões direcionadas por frente (rodadas sobrepostas, **não somar** à suíte geral): B03 revisão72 testes distintos; B12 serviço/HTTP31; logger38; B07 normalizador/ordenação25; pools/capacity80; UI de chaves14; guard exclusivo12; readiness/ORM4. Contagens e comandos específicos constam nos relatórios de implementação/revisão.

## 4. Testes não executados e infraestrutura

Docker CLI existe, porém a consulta ao daemon desktop-linux não respondeu e foi encerrada; não se reiniciou o daemon nem se usaram containers do usuário como laboratório. Nenhum PostgreSQL exclusivo foi disponibilizado. Não foram definidos DSNs produtivos ou credenciais para contornar essa ausência.

- B03:7 cenários PostgreSQL preparados/coletados, **não executados**.
- B12:8 cenários PostgreSQL preparados/coletados, **não executados**.
- B07:2 cenários adicionais de ordenação/concorrência em qr-chatwoot-storage, **não executados**; demais integrações PG/Redis também não executadas nesta fase.
- Aplicação/rollback real das77 migrations, readiness contra catálogo real, RLS/ACL/FKs/triggers, bloqueios/leases/purge, S3/MinIO e cópia/restauração do cliente: não executados.
- Entry point compilado com PG/Redis:1 teste explicitamente ignorado. Build de container, restore drill e testes de storage dependentes de Docker: não executados.
- Browser E2E, aparelho WhatsApp, engine efetiva, conector/fork CCLX, crashes físicos e benchmark50/400/900: não executados; nenhum envio de mensagem nem carga real.

**Gate de CI pendente:** os dois suites novos exigem TEST_DATABASE_ADMIN_URL explícita, loopback literal, usuário/database lab_ e a respectiva flag exclusiva (TEST_MEDIA_CUSTODY_EXCLUSIVE_CLUSTER=1 e TEST_PARTNER_REPLAY_EXCLUSIVE_CLUSTER=1). Rejeitam toda query string/fragmento antes de conectar. A flag é declaração do operador, não prova de cluster descartável. A CI existente usa usuário/database postgres e não declara essas flags; portanto precisa de uma etapa/cluster de laboratório exclusivo compatível antes de poder aprovar essas integrações. O workflow não foi alterado nem executado remotamente. Não remover o guard para obter CI verde.

## 5. Revisão final: segurança, compatibilidade e regressões

Três revisões independentes foram registradas em REVISAO-B03.md, REVISAO-B05-B07-B13.md e REVISAO-B12.md. Achados concretos encontrados e fechados localmente:

1. Delegação de escopo com expiração da chave emissora durante espera/escrita: revalida clock_timestamp() após locks e operações, com duas regressões novas.
2. Ordem de locks B07 e schema: lock UPDATE de instância antes de assertions/fleet que tomam SHARE; campos mantidos em instances. Removida comparação incorreta de fuso do produtor contra o relógio Broker.
3. Guard dos testes PG permitia override por query host/user: rejeição de query/hash/protocolo/identidade fora do laboratório, nos dois suites;12 testes offline e revalidação independente.
4. Readiness não detectava trigger condicional/column grants e ORM omitia checks: guard de tgqual/tgattr/policy/ACL de coluna e checks declarativos adicionados; quatro testes estruturais/metadados passaram. Isso **não substitui execução PostgreSQL**.

Nenhum achado bloqueante permaneceu aberto **nos recortes offline revisados**. Permanecem os gates de infraestrutura e cobertura abaixo. Não houve pentest, teste de carga nem auditoria completa renovada de dependências. Os13 pacotes moderados eram resultado histórico da auditoria base, não um npm audit novo desta execução; não se declara esse número como estado atual do registry.

Segurança mantida: tenant derivado do principal, autorização explícita de API key, scopes específicos, credenciais de controle excluídas, no-store, problemas HTTP sanitizados, RLS FORCE e grants mínimos nas migrations, UUID/idempotência, hash/tamanho e referências reais. Reprocessar delivery não cria mensagem/outbox de WhatsApp. A outbox PostgreSQL não foi substituída por Redis; nenhum contrato anterior foi removido. Alteração de permissões no banco permanece condicionada à migration futura, ainda não testada no servidor.

## 6. Produção, Git e commits

**Nenhuma alteração foi aplicada à produção nesta Fase2.** Não houve deploy, imagem Docker/GHCR, push, PR, merge, migrations executadas, alteração de Dokploy/Compose/ENV, dados reais, mensagens ou chamadas pagas. Não houve acesso ao servidor para validação live nesta fase. O estado atual de produção não é certificado por estes testes locais.

- Branch: `codex/broker-audit-fixes-20261029`.
- Commit inicial e HEAD final: `9e62ceaf3177979a68bc4985a93e25474de48487`.
- Commits novos entre base e HEAD: **0**. Nenhum commit criado nesta execução.
- Implementação local permanece **não commitada**, com arquivos modificados e novos listados no inventário; main não foi alterada.
- Alterações preexistentes preservadas: infra/web/server.mjs e tests/documentation-runtime.test.mjs; não atribuídas à Fase2.
- Auditoria original não foi reescrita; relatório atual fica em subpasta fase-2. Diretórios temporários e saídas anteriores permanecem no workspace.

## 7. Riscos restantes e próximos gates

1. **Evolution retry:** timers em RAM e fim após número limitado de tentativas não garantem replay após restart; existe janela Message→captura antes do HTTP. Implementar transação/outbox na origem e imagem derivada rastreável, preservando licenças/submódulo, depois testar a imagem exata em laboratório. B02 não está concluído.
2. **Custódia:** o recibo é declaração do cliente. ACK2xx, hash/tamanho ou READY Broker não comprovam fsync, backup/restore, propriedade ou guarda definitiva do objeto no cliente. KEEP impede elegibilidade automática desta feature; exclusão administrativa/lifecycle explícita preexistente continua sendo operação separada. Sem GC novo, pode haver crescimento indefinido e órfãos. B03 não está concluído.
3. **SQL ainda sem prova:** prioridade imediata é CI/laboratório exclusivo para migrations/readiness/grants/RLS/FKs/locks; acrescentar cobertura de bind/revogação de chave/prune concorrentes e purge completo com ledger. Revisão estática não elimina falhas de catálogo ou deadlock.
4. **Ordenação:** timestamp da fonte local marcadoZ exige clock estável por binding; clock regressivo, dois produtores/poll e troca de credencial/epoch precisam de reconciliação operacional homologada.
5. **Replay:** receptor deve deduplicar por tenant/eventId e persistir antes de ACK; falhas incertas não autorizam reenviar WhatsApp. Metadados de replay acompanham prune de eventos de30dias; não substituem histórico definitivo/auditoria externa.
6. **Capacidade/fairness:** volume do agregado, tenant lento, pools por réplica/rollout, disco/WAL/rede e pressão Redis não medidos. B13/B14 e meta50/400/900 continuam sem aceite operacional.
7. **Documentação pública:** canonical contém cinco rotas candidatas; antes de disponibilizá-las ao parceiro, homologar SQL/contrato e ampliar de forma coordenada perfis Swagger/Postman/PDF. Não apresentar os37 endpoints atuais como se já incluíssem a nova custódia/replay.

Encerramento desta execução: candidata local e evidências preservadas para revisão; pendências acima seguem para a próxima tarefa autorizada. **Sem deploy ou merge.**
