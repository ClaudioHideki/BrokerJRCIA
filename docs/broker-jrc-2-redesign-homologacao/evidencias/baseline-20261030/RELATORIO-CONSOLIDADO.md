# Broker JRC — reconciliação de publicação e prontidão

Data: 30/10/2026. Consultas produtivas aproximadamente 12:06–12:15 UTC (09:06–09:15 Brasília). Parecer: **PARCIALMENTE PRONTO; há bloqueadores internos para homologação e escala.** A publicação da Fase 2 está confirmada. Publicação, saúde de processo, funcionamento de integração e capacidade são provas diferentes.

## 1. O que foi confirmado

| Requisito | Estado | Evidência atual |
|---|---|---|
| Pacote de publicação | VALIDADO | ZIP original, 12 entradas, SHA-256 `93574676DDFB4FB77850B72AD20EECF1C0811196EF136065FC8B197FFED72F55`. |
| Código candidato | VALIDADO | Branch `codex/broker-audit-fixes-20261029`; HEAD `d1b66a56fe6d4f9202969784301abdf61490db45`. Fetch de main/candidata efetuado; main `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`. Produto tracked sem alterações desta auditoria. |
| GitHub Actions | VALIDADO | [Run 40997560465](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/40997560465), job123874158292: sucesso. Logs reconsultados nesta auditoria, não apenas reproduzidos do ZIP. |
| Imagem API em execução | VALIDADO | `ghcr.io/claudiohideki/brokerjrcia-api@sha256:fb54ad27beeb3e7777703959e08a13e0dd5da8b6f101f6d5e56d711d1af484e5`; container `d82eb3c44892`, healthy, RestartCount0. |
| Imagem web em execução | VALIDADO | `ghcr.io/claudiohideki/brokerjrcia-web@sha256:1485c277f2e72d2b85e346d75d77dc5775c262a7cb389ffff16c39fb891059c4`; container `2151025cd209`, running, RestartCount0. |
| Banco após migrations | VALIDADO | Consulta `BEGIN READ ONLY`: 77 migrations, latest1794177600000, fingerprint `0b6c21a5cb58605eee93023a92252341`, igual à publicação. Inclui0075/0076/0077; não reaplicadas. |
| Disponibilidade pública | VALIDADO no recorte | `/ready` HTTP200 `{"status":"ready"}` e `/` HTTP200 HTML. Não prova entrega ou fluxo autenticado. |
| Containers | VALIDADO no recorte | Mesmos13 IDs do pacote; API/worker/PG/Redis healthy; demais running. Isso não substitui heartbeat individual de cada worker. |
| Fonte de Compose no Dokploy | VALIDADO | URL BrokerJRCIA.git, branch main, caminho `./infra/dokploy/compose.yaml`, autodeploy desligado. Seis blobs de Compose/fleet/provision/roles/backup/restore iguais entre main e candidata. |
| Configuração completa resolvida | NÃO VERIFICADO | Não foi exportado ENV nem feita comparação de todas as variáveis/overrides. Digests API/web foram lidos em Config.Image. |
| Engine efetiva | PARCIAL | `evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`; ImageID `385a3c4bedf42c66b46b43d06aae8712620144a84aa3b2c831b30c68435ab27c`; 2CPU/2GiB. Correspondência fonte/binário e retry durável ainda não atestados. |

A engine registra RestartCount46, com uptime mostrado de seis semanas. Esse contador é histórico: não comprova reinício na publicação, OOM ou causa da falha atual. LOG_LEVEL não está explicitamente definido no ambiente do container; defaults do binário precisam ser atestados. Não foram lidos logs brutos de clientes.

Não existe divergência de conteúdo comprovada entre os seis arquivos de infraestrutura comparados. Existe separação de referências (main para Compose, candidata para imagens), que exige um manifesto único de release com SHA de cada fonte, digests, journal e configuração não secreta. Não há motivo comprovado para repetir o deploy atual.

## 2. Incidentes: 373 FAILED não é mais a contagem atual

O indicador vem de `integration_jobs`, fila de integração Chatwoot, não de `partner_event_deliveries` e não equivale a mensagens WhatsApp não entregues. Código: `apps/api/src/modules/observability/service.ts:27-32`. O replay B12 não trata essa fila.

Às12:06:47UTC foram encontrados395 FAILED e4 UNKNOWN. Em consulta posterior havia396 FAILED,4 UNKNOWN,3686 SUCCEEDED e1382 PENDING. As consultas foram sequenciais em um sistema ativo; não são um único snapshot atômico. Nenhum replay foi disparado. A comparação com a publicação identificou23 jobs FAILED atualizados após03:48:55UTC, todos caixa1/GROUP_CENTRAL_SCOPE_CHANGED.

| Código / operação | Contagem às12:06UTC | Diagnóstico e limite |
|---|---:|---|
| GROUP_CENTRAL_SCOPE_CHANGED / MIRROR_MESSAGE | 233 | Bloqueio de escopo de grupo. Caixa1 conectada, catálogo existente porém vencido, `GROUP_MEMBERSHIP_CHANGED`, zero grupos selecionados, webhook CONFIRMED. São pré-condições concretas que impedem o snapshot exigido pelo worker. Na consulta seguinte, +1 falha; total396. |
| CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION / MIRROR_MESSAGE | 119 | Worker exige greeting_enabled=false e enable_auto_assignment=false quando Broker controla atendimento. O código registra esse erro se uma condição não é satisfeita. Campo exato atual do Chatwoot remoto não foi relido; não alterar ambos indiscriminadamente. |
| CHATWOOT_INVALID_RESPONSE / MIRROR_MESSAGE | 19 | Resposta incompatível com schema/parser ou JSON esperado. Não foi coletada resposta HTTP original sanitizada; versão incompatível é hipótese, não causa comprovada. |
| CHATWOOT_REQUEST_REJECTED / MIRROR_MESSAGE | 9 | Rejeição HTTP classificada pelo cliente. Status/body originais não preservados nesta evidência; não atribuir a credencial sem prova. |
| MEDIA_DOWNLOAD_FAILED / MIRROR_MESSAGE | 5 | Falha de obtenção de mídia; distinguir expiração, acesso, DNS e storage com evidência específica antes de correção. |
| CHATWOOT_CONVERSATION_ALREADY_BOUND / CHATWOOT_REPLY | 5 | Proteção de vínculo de conversa; validar histórico/mapeamento, sem reassociar automaticamente. |
| MEDIA_TYPE_UNSUPPORTED / MIRROR_MESSAGE | 2 | Tipo de mídia rejeitado; mapear MIME real sanitizado e suporte antes de ampliar. |
| MEDIA_SIZE_LIMIT / MIRROR_MESSAGE | 2 | Limite de tamanho; não aumentar arbitrariamente. |
| CHATWOOT_CYCLE_CONTACT_CHANGED / CHATWOOT_REPLY | 1 | Contato divergiu durante ciclo; preservar vínculo/histórico até reconciliação. |
| CHATWOOT_OUTCOME_UNKNOWN / MIRROR_MESSAGE | 4 | Todos em SEND_MESSAGE, attempts1. Resultado no destino é incerto, não prova não recebimento. |

Os quatro UNKNOWN: caixa13 em21/10; caixa1 em20/10,26/10 e27/10. `chatwoot-client.ts:110-170` classifica POST com falha de rede/HTTP incerto dessa forma; a condição de rede exata não foi demonstrada. Primeiro pesquisar a mensagem remota por identificador Broker e conferir o ledger. Somente após resultado conclusivo decidir settle/retry explicitamente. Não transformar UNKNOWN em novo envio.

### Chatwoot degradado e backlog

| Caixa | Vínculo | Observação conectado | Callback já verificado | PENDING |
|---|---|---|---|---:|
| 1 | READY | sim | sim | 0 no snapshot |
| 13 | DISABLED | não | não | 1351 |
| 14 | READY | não | não | 5 |
| 19 | READY | não | sim | 26 |

Campos identity_error/access_error estavam nulos. Callback verificado é histórico, não confirmação de entrega recente. A saúde agrega linhas desconectadas inclusive de vínculo desativado: `NOT observed_connected` basta para degradar. Assim a indicação não comprova indisponibilidade global do destino. A métrica exibida usa quantidade de destinos aprovados, não quantidade de conexões degradadas.

**Correções propostas, ainda não aplicadas:** separar saúde de vínculos ativos, backlog legado/desativado e falhas recentes; registrar pré-condição específica de grupo em vez de erro genérico; não gerar continuamente jobs impossíveis para grupos não selecionados; distinguir espera por atualização de catálogo de falha terminal. Não reativar grupos, caixas ou bots automaticamente. Para os1351 jobs da caixa desativada, definir destinação administrativa explícita e auditada, sem apagar ou repetir silenciosamente.

Evidência de código: `chatwoot-group-worker.ts:16-27,64`; `whatsapp-groups/central-group-store.ts:26-57`; `chatwoot-worker.ts:604-609,764-802`; `chatwoot-client.ts:110-170`. Prefixo: `apps/api/src/modules/`.

## 3. Auditoria B02/B03/B05/B07/B12/B13/B14

| Item | Estado integral | Prioridade | Falta / aceite |
|---|---|---|---|
| B02 continuidade Evolution | PENDENTE | P1 bloqueador | Retry da fonte finito/em memória; outbox Broker não recupera evento nunca recebido. Atestar engine e implementar captura durável/dispatcher na origem. Matar processo antes/depois de HTTP/ACK e comprovar recuperação sem perda/efeito duplicado. |
| B03 custódia de mídia | PARCIAL | P1 bloqueador | Recibo autenticado/imutável/idempotente existe. Política KEEP não exclui bytes e physicalStorageVerified=false. Falta protocolo de custódia, restore e política completa de retenção/órfãos. Não chamar recibo declaratório de prova de cópia física. |
| B05 logs sensíveis | PARCIAL | P1 | Redação JRC testada; stdout da engine não coberto. Canários na imagem exata e inventário de coletores/retention; nenhum segredo/conteúdo deve aparecer. |
| B07 ordenação de conexão | PARCIAL | P1 | Watermark protege webhook; falta ordenação comum com polling/clock/binding. Testar webhook t10 aberto→poll fechado→evento atrasado t11 aberto; não declarar que esse caso ocorreu em produção. |
| B12 replay/observabilidade parceiro | PARCIAL | P1/P2 | Replay FAILED parceiro implementado, ledger e estatísticas. Falta homologação operacional real de receptor/lease/revogação/retention. Não resolve integration_jobs. |
| B13 quotas/pools | PARCIAL | Gate de escala | Planner existe; orçamento efetivo por processo/cluster/rollout não medido. Revisar quotas e deadlines conforme SLO, sem subir limites automaticamente. |
| B14 fairness | NÃO VERIFICADO | Gate de escala | Loop sequencial por tenant, até20 processamentos, HTTP10s: risco de espera≈200s por tenant lento, derivado do código. Benchmark multi-tenant antes de corrigir scheduler/concurrency. |

Detalhes, arquivos/linhas, regressões e testes: [code-audit.md](code-audit.md). Nenhum desses sete itens integrais é dependente exclusivamente do CCLX.

## 4. Matriz transversal de pendências

| Área / requisito | Estado | Prioridade | Correção/prova e teste de aceite |
|---|---|---|---|
| Código: grupos e saúde Chatwoot | PARCIAL | P1 | Corrigir diagnóstico/admissão por pré-condição e saúde ativa; teste grupo não selecionado/vencido sem avalanche FAILED e sem envio indevido. |
| Banco: migrations0075–77 | VALIDADO | — | Fingerprint atual confere; não migrar novamente. |
| Banco: RLS e concorrência | PARCIAL | P1 | CI SQL passou; ampliar interleavings custódia/replay/revogação/expiração e restore. Proibir acesso cruzado entre tenants. |
| Banco: capacidade/pool | NÃO VERIFICADO | Gate | Medir pg_stat_activity/locks/query plans/IO, orçamento consolidado durante rollout; sem saturação ou starvation. |
| Redis | PARCIAL | P1 | AOF/noeviction declarados; serviço healthy. Provar restart, fila recuperável, pressão de memória; PG continua fonte durável. |
| Evolution origem durável | PENDENTE | P1 | B02; validar fonte versus digest e interrupção controlada em laboratório. |
| Evolution sessões | NÃO VERIFICADO | P1 | Restore de sessão real controlada, sem duplicar sessão ativa; mapear DB/volumes/chaves e reconexão. |
| Workers integração | PARCIAL | P1 | Investigar/segregar1382 pendentes,396 FAILED e4 UNKNOWN; teste sem duplicação e destinos desativados sem crescimento infinito. |
| Workers parceiro | PARCIAL | Gate | Replay e lease existentes, falta fairness e falhas reais do receptor em PG. |
| S3 mídia/custódia | PARCIAL | P1 | Recibo + KEEP existem; testar download tenant-safe, cópia privada, corrupção, expiração, ACK perdido, restore DB+objetos. |
| Frontend empresa/admin | PARCIAL | P2 | Fase2 altera seleção media:archive. Falta jornada visual de recibo/replay/erro acionável e RBAC de operação; testar ambos perfis e tenant adversarial. |
| APIs contrato | PARCIAL | P1 | Rotas reais existentes e testadas; atualizar docs antigas que dizem replay ausente, reconciliar OpenAPI/Postman/PDF com commit e status reais. |
| Autenticação/escopos | PARCIAL | P1 | media:archive explícito, chaves antigas não ampliadas; testar revogação durante I/O, expiração, assinatura e isolamento end-to-end. |
| Logs/segredos | PARCIAL | P1 | JRC sanitizado; engine/coletor/retention e rotação de credenciais previamente expostas exigem revisão privada. Não incluir credenciais no pacote. |
| Infra release | PARCIAL | P2 | Digests conferem; consolidar manifesto de referência Compose+imagens+schema. Checker atual não garante digest em toda variável. |
| Backup | PENDENTE | P1 | Abas Dokploy vazias; cópia externa NÃO VERIFICADA. Definir RPO/RTO, cópia cifrada externa e responsabilidade. Nenhum backup criado nesta tarefa. |
| Restore/rollback | PENDENTE | P1 | Ensaiar recuperação completa com artefatos/chaves/DB/objetos e imagens. Comparador antigo retorna DIVERGED diante77; voltar imagem não é rollback comprovado. Não executar DROP. |
| Monitoramento | PARCIAL | P1 | Health público bom não cobre filas; alarmes por backlog/idade/UNKNOWN/tenant/worker/catalog/storage e histograma de latência. |
| HA/distribuição de nós | NÃO VERIFICADO | Gate | Host único não é HA; definir placement/sessão única/drain e simular falha de nó antes de expandir. |
| Simulador local persistente | VALIDADO no recorte | — | SQLite+arquivo privado, ACK apósCOMMIT, idempotência e smoke8; não equivale a PG/S3/engine real. |
| Harness integrado PG/Redis/S3 | PENDENTE | P1 | Ligar worker real ao receptor por transporte injetado, preservando SSRF; cluster/bucket descartáveis marcados. |
| Benchmark50/100/200/400 | PENDENTE | Gate | Plano preparado; não houve carga real nem comprovação de capacidade. |
| Capacidade900/250mil mensagens-dia | NÃO VERIFICADO | Gate | Somente preparação. 250mil/dia≈2,89mensagens/s em média não dimensiona picos, eventos auxiliares, mídia ou memória de900sessões. |
| CCLX versão/fork/PubSub real | DEPENDENTE EXCLUSIVAMENTE DO CCLX | Integração final | Cliente fornece versão/schema/grants/ambiente. Não bloqueia homologação interna JRC com simulador. |
| Cópia definitiva/restore operado pelo CCLX | DEPENDENTE EXCLUSIVAMENTE DO CCLX | Integração final | Cliente comprova sua retenção e recuperação; contrato e validação conjunta continuam compartilhados. |

## 5. Simulador e benchmark

Pacote executável em [simulador/README.md](simulador/README.md). Usa Node24 nativo, SQLiteWAL/FULL, HMAC, inbox/projeção na mesma transação, ACK202 apósCOMMIT, duplicação/conflito por tenant/eventId, arquivo de mídia com hash/sync/rename e recibo apósCOMMIT. Dois tenants sintéticos. Nenhum endpoint externo configurável, nenhuma credencial real, sem engine ou envio WhatsApp.

36 testes passaram. Smoke fixo de8 eventos confirmou8 registros/8 projeções,1 recibo de mídia e recuperação após ACK perdido/reabertura. Isso comprova o recorte local; faltam crash abrupto no pipeline de arquivo, fsync de diretório/queda elétrica, PG/S3 integrado, schemas de todos os eventos e restore completo. Detalhes e gates50/100/200/400/preparação900 em [simulator-benchmark.md](simulator-benchmark.md).

O teste com sessões reais permanece sujeito a autorização específica em ambiente controlado. Carga de eventos deve ser sintética; nenhuma carga foi iniciada contra produção. Não usar esta CLI para receber dados de clientes.

## 6. Testes e níveis de prova

| Origem | Resultado | Limite |
|---|---|---|
| CI do commit publicado | 3596 unit +6 PDF +1526 SQL/Redis +34 parceiroQR +5 MinIO =5167 execuções aprovadas | Soma das etapas, não alegação de5167 casos únicos independentes. Nenhuma falha no run final. Run inicial anterior com21 falhas não é este run. |
| Revisão atual de código | 14 arquivos/173 testes aprovados | Unit/HTTP in-process/frontend; não soma como testes novos à CI. |
| Revisão atual infraestrutura | 13 testes aprovados | Backup criptográfico/Compose render/pins/pools; não houve restore produtivo. |
| Receptor original | 28 testes aprovados | Baseline local antes da extensão. |
| Seleção parceiro adicional | 20 testes aprovados | Sobreposição parcial com173; não somar para inflar cobertura. |
| Simulador final | 36 testes aprovados | Inclui28 herdados; oito eventos no smoke, sem benchmark. |
| Lint/typecheck/build | Sucesso nas etapas do workflow publicado conforme jobs/logs | Não reexecutados integralmente nesta auditoria somente leitura do produto. |
| Git diff | Tracked intacto / diff --check sem erro | Artefatos novos estão em output; sem commit/push/merge. |

Docker local: CLI existe, porém daemon retornou permission denied e leitura config.json negada; não se conclui que Docker esteja ausente. Portanto PG/Redis/MinIO/recovery/carga não foram reexecutados localmente nesta auditoria. Evidências SQL/Redis/MinIO da CI foram reconsultadas no GitHub e mantidas separadas.

## 7. Ordem recomendada de execução

1. **P1, incidente interno:** preservar ledger; abrir diagnóstico por caixa/código/idade. Corrigir grupos/saúde e política de atendimento somente com configuração comprovada. Reconciliar4UNKNOWN por leitura do destino antes de qualquer replay. Decidir backlog da caixa desativada com trilha de auditoria.
2. **P1, recuperação e segurança:** planejar backup/restore completo e rollback77; canários de logs na engine fixada; fechar lacunas de segredos/redação. Sem recuperação comprovada, não promover escala.
3. **P1, integridade:** fechar B02 e B03; consolidar ordenação B07. Testar falha antes/depois de commit, ACK perdido, restart, revogação, corrupção e isolamento.
4. **P1/P2, operação:** completar B12 com receptor real do laboratório, métricas e UI; corrigir documentação do contrato e distinguir receipt/replay/evento/envio.
5. **Gate de escala:** medir B13/B14, orçamento de pool/quotas e SLOs; executar50→100→200→400 somente ao passar cada etapa. Preparar900 sem alegar capacidade.
6. **Integração externa:** homologar conector/grants/recepção/retention no CCLX real, depois das provas internas. Acesso ao CCLX não é desculpa para deixar testes internos pendentes.

## 8. Escopo da execução e arquivos

Esta execução não fez deploy, merge, push, migrations, reset de fila, replay, envio de WhatsApp, alteração de ENV/Compose, criação de backup ou modificação de dados de clientes. Consultas no PostgreSQL foram encapsuladas em transações READ ONLY e finalizadas com ROLLBACK. Abertura de terminal/consultas produz a telemetria normal de acesso, não alteração funcional do sistema.

Documentos auxiliares: [evidência de servidor](servidor-evidencias.md), [diagnóstico SQL](diagnostico-readonly.sql), [código](code-audit.md), [infraestrutura](infra-release.md), [simulador/benchmark](simulator-benchmark.md), [trecho sanitizado da CI](ci-verificado.log). Os relatórios auxiliares declaram seus próprios escopos; verificações produtivas estão neste documento e no arquivo de servidor. O conteúdo do produto permanece no commit d1b66a; o simulador complementar e esta documentação são artefatos locais para revisão, não parte da imagem implantada.

**Conclusão:** release reconciliada e operacional como processo; homologação funcional/integridade/recuperação/escala ainda parcial. Bloqueadores internos JRC permanecem. Não declarar900conexões,250mil mensagens/dia ou JRC100% pronta.
