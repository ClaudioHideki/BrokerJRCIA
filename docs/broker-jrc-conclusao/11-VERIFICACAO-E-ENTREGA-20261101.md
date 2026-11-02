# Broker JRC — verificação do incremento de 01/11/2026

## Resultado

Código e testes incrementais concluídos nos recortes descritos abaixo, a partir de `ea58a897b923fc5889e99ea039b4bd61c385d781`, preservando a PR #6 e a branch `codex/broker-jrc-2-redesign-homologacao-20261030`. A missão integral permanece **PARCIAL**. B02, B03 e o piloto de 50 números não estão homologados integralmente. Este relatório não é autorização de release.

Nenhum deploy, merge, push, mudança de credencial produtiva, migração produtiva, conexão de número real, envio ou replay de UNKNOWN real foi executado. O Dokploy não foi acessado nesta continuação. O trabalho usa bancos, buckets, chaves e payloads sintéticos em laboratório local; os serviços compartilhados foram preservados.

A descrição detalhada das alterações, causas e rollback está em [10-INCREMENTO-ORIGEM-CUSTODIA-20261101.md](10-INCREMENTO-ORIGEM-CUSTODIA-20261101.md). O inventário integral de arquivos e evidências acompanha o pacote. [CONTINUE-AQUI.md](CONTINUE-AQUI.md) e [ESTADO-FINAL.json](ESTADO-FINAL.json) são o ponto de continuidade; não retomar pelos relatórios históricos sem considerar este incremento.

## Reconciliação da base

| Elemento | Observação nesta execução |
|---|---|
| PR #6 | Aberta, rascunho, sem merge; head ea58a897 |
| Base da PR | codex/broker-audit-fixes-20261029 |
| main observada | be1e9441146d3ce8f9bc29b2f1b2fd135daf4371 |
| CI da base | Run 41326586560, sucesso |
| Imagens da base | Run 41326614599, sucesso; digests em reconciliacao.json |
| CI/imagens deste diff | Não publicadas nem executadas remotamente nesta continuação |
| Produção | Não verificada e não alterada |
| Arquivos anteriores | Preservados; auditoria-900, tmp e evidências preexistentes não incorporados indiscriminadamente |

O sucesso do workflow de ea58 não cobre alterações posteriores. O relatório não afirma que a versão hoje instalada corresponda a qualquer imagem citada.

## Entregas de código e situação

| Item | Estado | Entrega comprovada | Pendência para encerramento |
|---|---|---|---|
| B02 | PARCIAL | ACK autenticado correlacionado depois do COMMIT, ledger tenant-scoped, conflito/dedupe, worker finito, transporte exato e SIGKILL do sender com Broker/PG reais | Proveniência notify/append e composição instalada na engine fixada, build e crash/restart desse binário |
| B03 | PARCIAL | Receptor PG + MinIO privado, PUT condicional, readback SHA-256, recibo SQL, recuperação de órfão, KEEP e conflito de modo/destino | Produtor/worker completo, criptografia/chaves, inventário de órfãos, restore conjunto e falha real de processo/host |
| B05 | PARCIAL | Diagnósticos novos do guard usam códigos estáticos; scanners e testes de fronteira passaram | Canários na imagem efetiva da engine e coletores, sem vazamento de payload/token |
| B07 | PARCIAL | Fence polling/webhook existente preservado; regressões gerais e PG reexecutadas | Geração/proveniência comuns e reconexão real; não há ordenação absoluta garantida |
| B12 | PARCIAL | Replay do journal tem identidade estável, ACK explícito, prazo, backoff e reconciliação | Homologação operacional de FAILED do worker parceiro e cenários de receptor real; não confundir com integration_jobs |
| B13 | PARCIAL | Preflight conta todos os pools/processos/replicas/reserva de rollout e recusa inventário incompleto | Inventário efetivo, medição e ajuste justificado por carga; nenhum limite aumentado |
| B14 | PARCIAL | Arquitetura anterior preservada; plano de teste define tenant grande e receptor lento | Justiça entre tenants e starvation não medidas neste incremento |
| LAB2 | PARCIAL | Classe Ruby real de resposta executada, blob confrontado com GitHub; contrato de QR/polling/UNKNOWN e vínculo | Host Rails completo isolado: autenticação, CSRF, DB, credenciais cifradas, TLS, Redis, browser, mensagens e mídia |
| Painéis | PARCIAL | Shells admin/empresa responsivos, teclado, foco, contexto, breadcrumb e atalhos | Redesign e homologação de todos os módulos, leitor de tela e dados/ações reais |
| Dashboards | PARCIAL | Saúde, filas e diagnósticos existentes preservados; nenhuma fila real foi limpa | Semântica operacional completa ligada à engine e ao worker efetivos |
| 50/30 dias, 400, 900 | PENDENTE / NÃO VERIFICADO | Plano progressivo e orçamento explícito | Gates internos, ambiente medido, autorização e tempo real de piloto |

Essas pendências são internas à JRC. Somente o fork/ambiente e a homologação específica do CCLX dependem exclusivamente dele.

## Testes e evidências

Não somar linhas da tabela: há sobreposição entre suítes e retestes.

| Verificação | Resultado | Evidência |
|---|---|---|
| Unitários/HTTP/frontend, rodada final | **3.639 passaram; 0 falharam; 0 ignorados; 467 arquivos** | unit-clean.json e unit-clean.log |
| PostgreSQL/Redis, rodada completa | **1.531 passaram; 24 falharam; 156 arquivos**; causas e reteste abaixo | integration-full.log |
| Reteste PostgreSQL/Redis afetado | **293 passaram; 0 falharam; 9 arquivos**, incluindo os 13 casos novos de readiness estrutural | integration-reviewed.json |
| Journal/origem e crash | **43 passaram; 0 falharam; 0 ignorados** | origin-final.log |
| Receptor PG, benchmark e MinIO | **21 passaram; 0 falharam; 0 ignorados**, após readiness | cclx-minio-ready.log |
| Adaptador privado Broker + PG/MinIO | **5 passaram; 0 falharam**, cifragem no caminho existente, isolamento, PUT incerto e lifecycle sintético | storage-adapter-final.log |
| Runtime compilado com DB/Redis | **2 passaram; 0 falharam; 0 ignorados** | compiled-infra-final.log |
| Consumidor Ruby real LAB2 | **4 passaram**; classe real, host incompleto | integrations/partner-qr/tests/lab2/consumer-run.log |
| Contrato genérico parceiro QR | **34 passaram**; não substitui host LAB2 | integrations/partner-qr/tests/lab2/generic-partner-run.log |
| Shells unitários | **20 passaram**, incluídos na suíte geral | shells-green.log |
| Shells Chromium 320/390/1280px | **6 cenários passaram**, API simulada | shells-browser.json e PNGs |
| Preflight de pools | **11 passaram**; regressão existente **42 passou** | pool-preflight-green.log e pool-baseline-regression.log |
| Segurança/inventário/documentação | **36 passaram**, incluídos na suíte geral | security-final.log |
| Build e typecheck | **PASS**, códigos de saída 0 | build-reviewed.log, typecheck-reviewed.log |
| Bundle público, contratos, notices, submódulo | **PASS** | web-bundle.log, public-contracts-reviewed.log, notices.log, submodule.log |
| Lint | **NÃO DISPONÍVEL:** package.json não define script lint; não declarar eslint aprovado | package.json; diff/sintaxe são verificações distintas |
| Navegador E2E completo | **37 passaram; 5 ignorados por perfil; 0 falhas; 42 previstos**, Fastify/PG/Redis reais, provider sintético | e2e-final.log |

### Falhas preservadas e investigação

A primeira rodada PG completa falhou em 22 casos por autenticação dos roles de laboratório jrc_auth/jrc_platform/jrc_lifecycle. Também falharam duas expectativas antigas de schema/policy; um hook de limpeza atingiu timeout após falha de setup. Corrigiu-se apenas o HBA do PostgreSQL descartável em loopback para esses roles sintéticos, sem mudar senhas, e atualizaram-se as expectativas de migration 0078. O reteste de nove arquivos passou em 293 casos, incluindo todos os arquivos anteriormente falhos e o novo drift de PK/FK. Isso não equivale a uma segunda execução integral limpa.

As rodadas unitárias iniciais tiveram erro de subprocesso Git/OpenSSL do sandbox, uma expectativa OpenAPI desatualizada e leitura durante edição concorrente da revisão. O ambiente de teste foi explicitado e a rodada integral final de 3.639 passou; não se aumentaram timeouts para esconder falhas.

A primeira repetição MinIO final teve 13 passes/8 falhas de socket porque o teste começou antes do readiness do container recém-reiniciado. Após observar HTTP 200 no readiness, a mesma suíte passou 21/21. A falha inicial está preservada em cclx-minio-final.log. O runner Linux de CI já aguarda readiness; não foi alterado para tolerar indisponibilidade silenciosamente.

A rodada anterior de runtime compilado tinha 1 teste ignorado por ausência de TEST_DATABASE/Redis. A rodada final forneceu exclusivamente infraestrutura descartável e passou 2/2. Não usar o skip anterior como aprovação.

### O que não foi executado nesta continuação

- Não faltou Docker: PostgreSQL, Redis, MinIO e Ruby foram usados localmente. O host tem 8 GiB e pressão de memória; testes pesados foram serializados.
- O wrapper de storage de CI exige Linux amd64 e não foi executado nativamente em Windows. O MinIO real correspondente e o novo adaptador/receptor foram testados. CI Linux completa do novo commit, build de container, scan de dependências/imagens e assinatura continuam pendentes.
- Não houve build/boot/crash da engine Evolution já integrada ao journal. SIGKILL de processos Node filhos é prova de processo, mas não dessa engine ou de energia/host.
- Não houve boot E2E de Rails LAB2, pareamento WhatsApp, reconexão de sessão real, envio real, carga de sessões ou recuperação física de toda a infraestrutura.
- Não houve restauração conjunta atualizada de migration 0078 + objetos + chaves + sessão. Os ensaios históricos permanecem evidências limitadas, não herdadas automaticamente.

## Revisão do diff e segurança

A revisão identificou e corrigiu quatro riscos reproduzidos: recibo para conteúdo diferente sob o mesmo ID do provider; deadlock ao promover locks do canal; readiness que não detectava PK/FK inválidas; disputa filesystem/S3 devolvendo recibo de outro modo. Também foi corrigida a propagação de erro do guard para destinos independentes e demais transportes da engine. Os relatórios RED/GREEN e a revisão independente estão no pacote.

Os recibos do Broker não guardam corpo, telefone, token ou chave. RLS é forçada, o vínculo tenant/canal/instância usa FKs compostas, e a aplicação possui SELECT/INSERT sem UPDATE/DELETE. O catálogo de exclusão foi atualizado, sem executar exclusão de dados. O ACK é posterior ao COMMIT; hash dos bytes não substitui autenticação. O parser limita corpo e escopo, e a resposta legada permanece compatível quando os headers novos não são usados.

O guard permanece desabilitado para implantação: bootstrap retorna UNPROVEN. A preparação de overlay valida hashes do upstream e não modifica o submódulo. A captura de texto individual não promete suporte a grupos, história, mídia ou todos os eventos Evolution. Não há garantia de recuperar fatos que não foram persistidos ou sequer recebidos da origem.

S3 e SQL não formam transação atômica. Objetos órfãos são conservados e verificados em retry; nenhum expurgo automático foi implementado. O receptor de laboratório não cifra os bytes; `.cipher` no nome de objeto não é evidência de cifragem. Nenhuma resposta desta prova autoriza excluir a origem.

A extensão de protocolo reutiliza a rota existente e seu Bearer de canal/frota. Não altera API keys públicas, escopos ou permissões. O PDF e o OpenAPI foram regenerados; oito páginas do PDF foram renderizadas e inspecionadas, sem corte ou sobreposição observados; a rota interna documentada não foi adicionada automaticamente ao catálogo público de parceiro. Os shells preservam os contextos de autenticação e permissões existentes.

## Migration e compatibilidade

Criada **0078_qr_origin_receipts.sql**, aditiva, aplicada apenas em bancos descartáveis. Ledger de origem possui schema separado pertencente à engine; não inserir esse DDL no banco Broker como atalho.

Rollback futuro deve preservar ledgers e obrigações já aceitas. Parar captura/worker de forma controlada antes de voltar binário; ACK legado não pode liquidar obrigação do protocolo novo. Não há autorização para DROP da tabela ou perda de histórico. Migração produtiva depende de homologação, restore verificável e release autorizada separadamente.

## Benchmark e capacidade

Benchmark funcional: 750 eventos únicos, 825 requisições, 75 duplicatas, 0 erros, 750 linhas inbox e 750 projeções. Lotes de 50/100/200/400 são **eventos**, não sessões. Concorrência 4; total 4.227 ms incluindo infraestrutura do harness. Não há fila, engine ou WhatsApp nesse receptor. Resultados de latência e limitações estão em benchmark-final.json; não constituem SLO ou GO para 250.000 mensagens/dia.

O plano atualizado em 07-PILOTO-50-30-DIAS-ESCALA.md exige medição por camada, backlog/idade, latência/erro, reconexão, fairness, capacidade e reserva de rollout. Depois dos gates internos: poucas sessões controladas, piloto de 50 durante 30 dias, progressão 100/200/400 e preparação para 900. O tempo real de piloto não pode ser simulado.

## Ordem de execução seguinte

1. Engine: preservar proveniência notify/append e instalar capture/worker/guard/autoridade/pool/chave juntos antes de eventHandler; reproduzir build do pin e crash/restart real em laboratório.
2. Mídia: conectar produtor e worker ao contrato de custódia, criptografia recuperável, inventário de órfãos e restore SQL+objetos+chaves; KEEP até aceite.
3. LAB2: provisionar Rails real isolado no SHA reconciliado; executar autorização/revogação, fluxo bidirecional/mídia, reconexão e UNKNOWN sem reenvio cego.
4. Operação: canários de logs na imagem efetiva, replay seletivo de FAILED, fairness e orçamento medido de todos os pools; completar telas por jornada.
5. CI da nova revisão, revisão de PR, benchmark progressivo e proposta de piloto. Não fazer deploy nem conectar número real sem autorização explícita.

As correções de API, transporte, custódia de laboratório, testes de consumidor, shells e preflight estão aptas a revisão de código como incrementos limitados. **O Broker integral ainda não está homologado para liberação de capacidade.**

## Registro Git e pacote

A revisão local está no commit que contém este relatório e o ESTADO-FINAL.json. O manifesto externo do pacote registra o hash completo sem criar autorreferência no commit. Nenhum push foi executado; a PR remota continua na revisão reconciliada ea58 até uma publicação autorizada. O diff foi revisado e git diff --check passou. Arquivos preexistentes fora do escopo continuam no workspace.
