# Continuação operacional — 12/11/2026

Fechamento adicional da CI ampla: migration aditiva 0094 registra o catálogo de origem e corrige a limpeza dos dois escopos no expurgo explicitamente confirmado de canal/empresa. O probe composto foi reconciliado com a constraint de mídia 0090, preservando parceiro e histórico. RED reproduzido e 59 testes/3 arquivos PG verdes; revisão independente sem P1/P2 nesses trechos. Não reescrever migrations anteriores. Detalhes em `docs/implementation/history-operational-host-20261112.md`. Revalidar a CI do próximo SHA antes da imagem API/web.

Engine `20704a6711c36bb5914b963904b16676d1128fb6` publicada/assinada após gate próprio, digest `sha256:ebfbadb53409f3ec5db87ee8ef0ab508aa4cdc401dcc38385a1cc9986963bc41`; sem ativação produtiva. LAB2 avançou para `0606d0ff17ba6d495c667f723bd0756e8ec62b18`, incorporando schema corrigido e guardas de memória/output do build; CI própria em andamento. Nenhuma produção alterada; acesso Dokploy segue indisponível.

Incremento atual sobre `6522938097781d099e46f594eefc51e9149e783c`, na branch `codex/whatsapp-history-sync-20261111`. Host privado PostgreSQL, principal por engine, capability por socket/epoch, admissão de nova conexão autorizada, journal live+mídia atômico, recuperação física e convergência live/histórico implementados. Migrations novas e ainda não produtivas:0091–0093. Autoridade, revogação até COMMIT, LID, grupos e dedupe nas duas ordens têm regressões. Captura produtiva continua default off/UNPROVEN; não inferir homologação de telefone.

Provas atuais:4363/574 gerais verdes (backup/recovery excluídos);86PG/6 arquivos mais25/25 do host após último ajuste;116 origem; E2E operacional final de duas imagens/tenants com PG/MinIO/Rails/Sidekiq aprovado. Revisão independente confirmou fechamento dos oito achados. CI/imagens/deploy do novo SHA precisam da própria evidência. Detalhes, infraestrutura, migrações, limites e rollback: `docs/implementation/history-operational-host-20261112.md`.

LAB2 consolidou histórico + A–G `cad427d4` + runtime/Scout `d11c879a`, candidata `a3c10814fae79ccea86315d24fc27c231c803422`. CI própria em andamento, com falha do fixture antigo de paginação sendo corrigida sem afrouxar membership. Mains preservadas; nenhuma produção alterada. Controle Dokploy segue indisponível mesmo após reabertura. Usuário autorizou publicação/deploy final, mas nenhum envio, replay ou pareamento real. Backup/dump/restore excluídos.

---

# Continuação local: mídia de origem e progresso, 12/11/2026

Este registro substitui as pendências já implementadas dos checkpoints abaixo, sem transformar evidência antiga em aprovação do novo candidato. Bases preservadas: Broker ece27d13584b8eee661ccc2e8a792308c7fcd827 e LAB2 e919b0ac7eaa95f844880e6f60bb8092d603f94b. Mains reconferidas nesta rodada: Broker29095bea e LAB2d8a83b82, ambas ancestrais; sem merge/push/deploy.

Implementado neste working tree: descritor mínimo de mídia cifrado e atômico com a página no journal; opt-in conservado pelo bootstrap compilado; download estreito abortável e autenticado; hash/tamanho/recibo/lease/retry/KEEP; normalização Opus e separação do upload público; migration Broker0090 aditiva; contagem distinta de chats; progresso somente leitura React/Vue PT-BR, com inbox/revisão/permissão revalidadas e descarte de resposta tardia. LAB2 não recebeu nova migration nesta rodada.

Evidências novas já concluídas: origem/engine113 (inclui SIGKILL após COMMIT de página/mídia), PostgreSQL60 mais8 de estrutura0090, contratos/HTTP/UI Broker38, gates OpenAPI/documentação43, Rails progresso34 e regressão silenciosa/mídia/Minhas63; UI LAB2 focal6 e InboxView4; artefato/empacotamento da engine31. São suítes sobrepostas, não somar como total. E2E HTTP com PostgreSQL/MinIO/Rails/Redis/Sidekiq:12 mensagens/8 mídias, áudio Opus com parâmetro, grupos/LID, ACKs perdidos e recaptura sem duplicidade; Minhas retorna somente as duas conversas da caixa correta. Duas Accounts na mesma instalação, não duas instalações independentes ou WhatsApp real. Componente React também validado em Chromium desktop/mobile com API sintética: sem overflow, mutações ou violações automáticas de acessibilidade; não é navegador E2E operacional.

A execução geral final passou 4363/4363 testes em572 arquivos, sem falhas/skips; somente tests/backup.test.mjs foi excluído por escopo. Também passaram typecheck/build Broker e build LAB2 (5640 módulos,11m41s). A primeira execução ampla teve10 falhas/7 skips: PDF/catálogo anteriores, baseline runtime0089 e restrições de spawn Git/OpenSSL; preservada como tentativa falha, corrigida e substituída pela execução geral completa verde. O runtime agora exige0090 e recusa estruturas/permissões ausentes, com RED PostgreSQL e GREEN. ESLint novo2 arquivos sem erros/avisos;10 avisos antigos de i18n nos arquivos existentes. RuboCop novo parser/spec limpos;9 métricas/nomeações antigas de controller/client/control, incluindo ClassLength ainda acima do limite, não são lint global limpo.

A imagem local da engine pinada foi construída nesta rodada, sem publicação. O gate executado dentro dela passou com a Baileys 7.0.0-rc.9 efetivamente instalada: derivação HKDF independente, download autenticado e rejeição de MAC corrompido para imagem, áudio, vídeo, documento e figurinha. O transporte desse teste é sintético e sem rede; não é sessão WhatsApp real nem host produtivo homologado.

**Não habilitar captura em produção:** host operacional de autoridade/ownership continua pendente e LAB/UNPROVEN. Faltam admissão/política automática persistida por conexão, composição operacional do downloader, convergência live de saída/mídia/grupos e prova de fechamento de cobertura. O painel observa operações admitidas; não implementa start/resume/cancel públicos V2. isLatest/progress100 não provam o telefone completo.

Detalhes e rollback: docs/implementation/history-source-media-progress-20261112.md no Broker. Registros privados em .superpowers/sdd/2026-11-05-whatsapp-history-sync/; relatório e pacote de evidências do workspace serão atualizados ao fechar. Nenhum número/sessão real, credencial produtiva, imagem ou banco de produção foi alterado. Nenhuma rotina de backup/dump/restore executada.

---

# Checkpoint ativo - sincronizacao WhatsApp, 12/11/2026

Implementacao local sobre Broker bb438150060a418a7aa36a04beacf0a81a88bc3d e LAB2 ca6e7824842022bcfe4db04d6d5a359994f8540b. Preservados os incrementos e as branches atuais. Nenhum push, merge, imagem publicada, deploy, envio/pareamento/replay real, credencial alterada ou rotina de backup/dump/restore nesta rodada.

## Implementado e exercitado neste incremento

- Broker: writer nativo, peers canonicos e prova do dono; pagina e recibos/obrigacoes de projecao transacionais; migration0089 aditiva com RLS; consumidor HTTP V2 com capability, recibo correlacionado e bootstrap imutavel; lease/retry e reparo da mesma midia. V2 nunca cai no worker/live V1.
- Driver privado headless: uma pagina de origem/nativa e uma entrega por tick; filtro por runId, gate, pausa/cancelamento e ACK somente apos COMMIT. Falha da origem nao congela dados ja persistidos.
- Hook compilado da engine: resolver privado de midia persistida congelado na captura, exigindo persisted=true e scopeKey original; URL/key da origem nao entra no lote. Nao implementa download da midia nem ownership produtivo.
- Recaptura: dedupe exclui somente UUID do objeto do hash do fato; SHA/tamanho/tipo/MIME/nome/legenda continuam estritos. Projecao reutiliza mediaId canonico para manter o request imutavel e evitar anexos duplicados.
- LAB2: multipart privado, reserva antes do PUT, SHA256/MIME/leitura fisica, ATTACH_PENDING PostgreSQL e job/scheduler Sidekiq. Token original e revisao de destino continuam obrigatorios; KEEP preservado.
- Minhas: historico resolvido comprovado por recibo CHAT em caixas de membership nao exclusivas; revisao de prova invalida paginas revogadas. URA/exclusividade/supervisao e responsaveis preservados.

## Evidencias atuais

A suite geral final passou **4355/4355 testes em 570 arquivos**, com um worker. Backup.test foi explicitamente excluido por escopo; nenhuma rotina operacional dessa area foi executada.

Writer/catalogo PostgreSQL24; unidade focada16; origem/journal/engine pinada96; Rails63/7 arquivos; UI43: zero falhas nessas rodadas. Typecheck e build Broker passaram. Vite LAB2 passou com heap4096MiB em8m18s; tentativa anterior3072MiB falhou e permanece registrada. ESLint2 arquivos sem ocorrencias. RuboCop20 arquivos: uma ClassLength preexistente no Finder (208 no HEAD anterior/214 atual; limite175). A nova ocorrencia MethodLength foi corrigida. Nao se declara lint global limpo.

E2E passou com PostgreSQL de origem/Broker, Rails HTTP, Redis/Sidekiq e MinIO reais: duas Accounts/tenants isoladas na mesma instalacao Rails,12 mensagens/8 anexos (imagem+legenda, audio, PDF, video), texto incoming/outgoing e grupos/LID. Compara IDs independentes, texto/direcao/data e hashes dos bytes. Perda de ACK em ambas as fronteiras e recaptura com novas referencias convergem para os mesmos registros/anexos. Minhas retorna somente as duas conversas da caixa do membro e nega acesso cruzado. Nao e navegador E2E, duas instalacoes Chatwoot independentes nem WhatsApp real.

Lote sintetico10001 mensagens individuais/grupos em101 paginas reconciliou todos os IDs em175,14s de teste; origem reconstruida entre leituras e KEEP mantido. Nao mede SLA, projecao em larga escala ou capacidade50/400/900 sessoes. progress100/isLatest nao fabricam fechamento de cobertura.

## Bloqueios internos restantes - nao habilitar em producao

1. Host/ownership operacional e autoridade/revogacao reais ate COMMIT; o host atual e de laboratorio e deliveryOwnership=UNPROVEN.
2. Obter/descriptografar e persistir os bytes de midias da origem antes de fornecer referencias READY. Os testes fisicos iniciam com bytes sinteticos fornecidos ao storage privado.
3. Convergencia completa live/history para outbound/midia e interoperabilidade CENTRAL dos grupos. Texto incoming individual/grupo tem prova/reuso, o restante nao esta homologado.
4. Composicao/scheduler operacional, admissao por conexao e rotas/painel publico V2 de status/retomada/cancelamento. Driver e ports privados nao sao esses endpoints.
5. Browser E2E, duas instalacoes independentes, imagem efetiva da engine/CI do novo SHA e sessao real autorizada com inventario da cobertura disponivel. Nao prometer copia integral do celular.

Mains reconferidas em12/11: Broker29095bea35702893e1a5b80f5131bdd13b901a7e e LAB2d8a83b824b11cc68ddbbce7c79681f368051fb70 continuam ancestrais. Broker compartilhado; LAB2 base completa; Branef/GLPI e GoPure nao alterados. Producao nao inspecionada nem modificada neste incremento.

Relatorio/evidencias locais: C:/Users/DEV02/Documents/ChatGPT/New project/output/broker-whatsapp-sync-20261112.

## Checkpoint anterior de11/11

## Continuação: catálogo e receptor LAB2

Núcleo de origem/staging registrado no commit local `5a396fd1961b341867a4f67884f1e01009ada824`. Subincremento posterior na mesma branch acrescenta `0088_history_catalogue`, catálogo privado de peers e checkpoint atômico por página. A0087 não foi alterada; ambas as migrations foram aplicadas somente em bancos descartáveis. Catálogo não é mensagem persistida, mídia copiada ou histórico entregue ao JRC. Writer canônico, transporte operacional de origem, projeção e custódia física continuam pendentes.

Gates deste subincremento: **35 testes PostgreSQL/7 arquivos** passaram; typecheck e build passaram; contratos/licenças/submódulo passaram; binário compilado1 passou/1 skipped (sem alvo de container smoke). A suíte geral com `tests/backup.test.mjs` explicitamente excluído terminou com **4338 passados/1 falha**, apenas pela expectativa antiga de migrations em repository-baseline. Corrigido o fixture para incluir0088 e executados novamente **38 focais/5 arquivos, zero falhas**. A aplicação não foi alterada depois desse resultado geral; não se repetiu toda a suíte após a correção apenas do fixture e não se declara uma nova execução integral verde. Uma rodada anterior do mesmo subincremento foi interrompida para aplicar a exclusão de escopo e não conta como aprovação. Nenhuma rotina operacional de backup/dump/restore foi executada.

A revisão reproduziu nome de participante como nome do grupo, nome vazio persistido e policy RLS ausente no definer do lifecycle. Corrigidos com RED→GREEN, inclusive exclusão explícita populada de canal/empresa preservando outro tenant. Não há P1/P2 restante no recorte revisado. Os catálogos novos não alteram mensagens, bots, envio, campanhas, relógios ou atribuições live. Guard de identidade e revogação do host precisa permanecer válido até COMMIT antes de qualquer composição operacional.

LAB2: código em `3f3e2f27c6d84d0722062be718f4686e126f8479`, documentação complementar em `ca6e7824842022bcfe4db04d6d5a359994f8540b`, branch `codex/whatsapp-history-order-20261111`. **228 Rails/15 arquivos e65 JS/5 arquivos, zero falhas**; RuboCop12 arquivos novos e ESLint7 arquivos alterados sem ocorrências. Código UI é o mesmo do build Vite já verificado. Receptor V2 local de texto/grupos, sem mídia V2 anunciada, default off. Documentos correntes: `CONTINUE-AQUI.md` e `docs/jrc-broker/history-sync-v2.md` no LAB2.

Main Broker `29095bea35702893e1a5b80f5131bdd13b901a7e` e main LAB2 `d8a83b824b11cc68ddbbce7c79681f368051fb70` foram reconferidas e já são ancestrais das candidatas; conferir novamente antes de publicação futura. Sem push, merge, imagem publicada, deploy, migration produtiva, credencial nova, pareamento, envio real ou replay. Bancos/Redis e rede descartáveis dos testes foram removidos por seus rótulos; nenhum volume ou container de outros projetos foi removido.

Próximo passo executável: Task3 writer canônico, deduplicação live/history e adoção legada comprovada; depois mídia privada física/KEEP, projeção/capability/recibos, progresso/API/UI e E2E. Não promover estes testes sintéticos a homologação de sessão real. Não usar downgrade de imagem incompatível com schema0088 nem descartar os filtros de privacidade dos grupos no LAB2.

## Evidência anterior do núcleo5a396fd

Branch local `codex/whatsapp-history-sync-20261111`, base preservada `1fed8ffcc68859c717f64a8aae50f29e8345e05b`. Main `29095bea35702893e1a5b80f5131bdd13b901a7e` reconferida após os testes e já ancestral. Checkouts antigos e alterações de áudio alheias preservados. Nenhum push, merge, deploy, alteração produtiva, credencial, pareamento, envio/replay ou backup/dump/restore neste incremento.

Plano aprovado: `docs/superpowers/plans/2026-11-05-whatsapp-history-sync.md`. Ledger privado `.superpowers/sdd/2026-11-05-whatsapp-history-sync/progress.md`. Núcleo recuperado seletivamente do commit `608aee7`; migration nova e ainda não aplicada em produção `0087_history_sync`, depois de `0085_guided_setup`/`0086_automation_box_routing`. Nenhuma migration aplicada foi renumerada.

Implementado localmente: contratos e staging cifrado V2; catálogo de identidade; journal de origem com páginas limitadas; CHAT/CONTACT/MESSAGE/GAP, individuais, grupos, participantes e referências privadas de mídia. Snapshot síncrono cifrado antes de await, sequência transacional, ACK do envelope completo, reserva de memória limitada, retry privado, continuidade após promoção e gates físicos de schema. Ownership da engine continua UNPROVEN e o host é de laboratório.

Gates atuais do Broker: **4.340 testes/567 arquivos passaram**, sem falhas; `npm run typecheck` e `npm run build` passaram. Script real `test:origin-journal`: **93/93**; integração PostgreSQL descartável: **16/16**; contratos focais: **28/28**. `test:compiled`: **1 passou/1 skipped**, pois não houve imagem/container para o teste dependente de CONTAINER_SMOKE_URL. A suíte global foi repetida sequencialmente após duas correções de fixtures/baseline; uma tentativa paralela intermediária foi interrompida por pressão de memória e não conta como aprovação. CI remota e imagens não executadas/publicadas.

LAB2: worktree `C:/Users/DEV02/.codex/worktrees/whatsapp-history-order/consolidacao-core-20261109`, branch `codex/whatsapp-history-order-20261111`, base `126d251dd5d5179783706f4934ba4fabc9d12b19`; main `d8a83b824b11cc68ddbbce7c79681f368051fb70` já incorporada. Preservado o escopo Minhas por membership antes da paginação, relógio monotônico, agrupamento por caixa e permissões exclusivas/URA. Acrescentado receptor Rails V2 local, gated, texto/grupos/LID e recibos pós-commit, sem callbacks, com proteção de grupos no diretório/busca/rotas e reuso comprovado de mensagens. Mídia V2 ainda não é anunciada como suportada. A rodada ampla inicial desse receptor passou **226 exemplos Rails**; ver o checkpoint LAB2 para a revisão exata posterior.

Próximas tarefas internas, sem reiniciar: writer canônico e deduplicação live/history; transporte/autoridade e coverage-close da origem (isLatest não é término); mídias físicas/S3 e custódia KEEP; worker de projeção com negociação V2 e recibos; progresso/API/UI; imagem efetiva da engine e E2E/CI no novo SHA. Nunca habilitar captura produtiva nem afirmar que todo o telefone foi espelhado com esses testes sintéticos.
---

# Continuação ativa — conexões e histórico, 04/11/2026

## Incremento posterior — sessão humana e visibilidade, 05/11/2026

O conjunto `48dd406` foi publicado e implantado no Broker; API/worker saudáveis e três fingerprints compilados conferidos. LAB2 `200b4f1ddd7459ec924e314cfe34cb93f11c5d5e` consolida a main `a92f9bf8`, está implantado no Grupo JRC, Rails e Sidekiq imprimiram o mesmo SHA e init terminou com exit0. Os gates exatos de ambos passaram; os detalhes e recibos sanitizados estão em `output/shared-inbox-history-20261104` na raiz do workspace. Não fazer merge na main por inferência.

Após autorização explícita do usuário, o vínculo do AgentBot1 `Teste robo` foi desativado **somente** na inbox1, pela interface normal do JRC. Não reativá-lo para reproduzir o defeito. Não houve desconexão WhatsApp, nova credencial, atribuição em lote ou replay.

A leitura READ ONLY confirmou owner `NONE` revisão5, ponteiros de bot nulos, nenhum binding ativo/remoto, nenhuma execução/job/outbox de automação em risco; uma sessão `HUMAN_ACTIVE` e uma `RESOLVED`. O predicado anterior `state <> RESOLVED` produzia `ROUTED` incorretamente. Há também quatro tentativas mirror incertas e 118 observações de entrega pendentes; seus estados permanecem preservados. Elas não são prova isolada de URA ativa e não autorizam reenvio.

O novo incremento muda **uma linha SELECT**: exclui `RESOLVED`, `HUMAN_ACTIVE` e `ADMIN_PAUSED` do indicador de sessão de bot. Todos os demais guards atuais de configuração, ownership, binding e trabalho de automação permanecem idênticos; nenhum guard de takeover/resume/dispatch foi alterado. `NONE` destina-se à visibilidade já autorizada por permissões/membros, nunca a liberar mutações. Ver `docs/api/shared-inbox-routing.md`.

RED focal reproduzido (6 falhas/23 aprovações); GREEN 34/34, typecheck API e diffcheck passaram. Há 14 casos PostgreSQL preparados (13 novos) com comparação de ledgers antes/depois de leituras. **CI, imagem e implantação desse último incremento ainda precisam de comprovação no novo SHA**. Não usar a CI de `48dd406` para aprová-lo. PostgreSQL local não foi iniciado devido à janela de RAM (~479MiB livre), não por indisponibilidade genérica de Docker.

Pendências distintas continuam: histórico completo individual/grupos/mídia, catálogo limitado pelo provider e vínculo Broker antigo da inbox13 excluída. Inbox51 Thiago é Evolution direta, sem binding Broker e sem membros; não migrar automaticamente. Backup/dump/restore e envios reais continuam fora do escopo.

## Fechamento do incremento de consultas e pool

Sobre `2312ae8`, a descoberta automática CENTRAL aplica espera durável de cinco minutos aos quatro erros de provider, usando `last_error_code`/`last_attempt_at` no due e no claim. Refresh manual e worker de automação preservados; sem migration. RED 5 falhas/9 aprovações; GREEN 44/44 e typecheck API. PostgreSQL do novo SHA ainda deve passar na CI. A imagem de `2312ae8` passou gates (4.080 unitários, 1.671 integrações PG/Redis e demais contratos), mas não deve substituir essa verificação nova.

No LAB2, a candidata posterior a `efa3d0b4` libera conexão SQL ociosa antes das duas leituras HTTP de contexto. Transação aberta é preservada. Harness Ruby com classes reais/pool e HTTP simulados passou; novo spec Rails/WebMock exige o banco descartável exato do CI. Não chamar esse harness de teste Rails.

Revisão independente não encontrou P1/P2 concreto nestes dois diffs. As candidatas anteriores publicadas estão retidas, sem deploy; aguardar gates e imagens dos novos SHAs. As leituras atuais confirmaram inbox 51 do Thiago usando Evolution direta, sem binding Broker, e vínculo Broker antigo apontando para inbox 13 excluída. Não remapear automaticamente. Catálogo Welton retornou `rate-overlimit`; cessar probes repetidos. Cinco minutos não garantem recuperação do provider. Histórico completo do celular continua fora da cobertura destas correções.

Os registros anteriores abaixo são históricos e permanecem preservados. Neste incremento o usuário autorizou correções, publicação de imagens e atualização dos dois produtos; não autorizou novo envio, pareamento, reinício de sessão ou replay de mensagens para teste. Backup/dump/restore continuam fora do escopo.

## Candidata atual e verificações

- Branch Broker: `codex/broker-ura-search-candidate-20261104`. A merge `352b25a` preserva integralmente a URA/CSAT de `2d30a5a`, atualmente na main e implantada, junto à busca por nome. Não substituir por uma candidata antiga que omita URA.
- `dd3d65a`: cronologia das conversas após importação histórica; 40 testes PostgreSQL e 117 focais passaram.
- `67dd0e3`: contexto de roteamento Control, somente leitura, por conta/tenant/revisão. Contrato: `docs/api/shared-inbox-routing.md`. Regressões incluem chave restrita, ausência canônica sem owner row e referência de bot retida após detach falho.
- `0f0754a`: bootstrap de catálogo de grupos sem exigir seleção anterior. Preserva identidade, engine fencing, leases, cooldown, seleção manual e bloqueio por erro. 103 focais passaram; os 5 novos PostgreSQL ainda aguardam a suíte da candidata.
- `f3a430f`: diagnóstico sanitizado por fase e HTTP status não enumerável. 131 focais e compilação API passaram. Sem mudança de retry, envios ou contrato público de erro.
- `835946f`: OpenAPI e PDF sincronizados; 54 testes de documentação e build web passaram. A suíte ampla desse SHA encontrou falta da política explícita da nova rota no inventário de segurança. A entrada e a regressão foram incluídas em seguida; 31 focais passaram. Exigir nova CI do HEAD, não reaproveitar o resultado parcial de `835946f`.
- LAB2: branch `codex/shared-inbox-history-20261104`, candidata `efa3d0b4a3dbaa41c132f13bfb72ac65e34f49da`; CI `41949308893` passou com 327 exemplos Rails, 156 testes JS, 12 jornadas de navegador e build. Inclui visibilidade compartilhada apenas onde não há roteamento comprovado, paginação cronológica retroativa e filtro de abertas/pendentes/todo histórico persistido. Uma conversa continua tendo um agente individual; a visibilidade não altera atribuição.
- As novas imagens e a implantação deste conjunto ainda precisam ser verificadas separadamente. Nenhuma nova migration foi criada. Não alterar a engine nem confundir testes de catálogo com homologação de histórico completo do telefone.

## Diagnóstico operacional e limites

Leituras autorizadas no servidor encontraram inboxes obsoletas em um vínculo Broker e uma caixa de nome semelhante que usa Evolution **direta**. Não remapear nem sobrescrever webhook por semelhança de nome. No JRC, grupos já espelhados estavam `pending`, ocultos pela consulta anterior exclusivamente `open`.

Consultas locais, sem envio ou reinício, confirmaram Evolution 2.3.7/Baileys 7.0.0-rc.9 e falhas atuais na leitura de catálogo: HTTP 500 em uma sessão e timeout em outra. O novo diagnóstico permite separar captura, identidade, catálogo, revalidação de engine e commit; ele não resolve sozinho a causa interna da engine.

Sincronização inicial completa de histórico individual, grupos e mídias permanece pendente. Não habilitar `MESSAGES_SET` indiscriminadamente: o contrato existente é limitado e rejeita lotes mistos/grupos. Preservar `availableFrom`, identidade por geração, KEEP e deduplicação. Não prometer cópia integral do celular nem reprocessar UNKNOWN/FAILED cegamente.

Os recibos locais e a conferência sanitizada ficam em `output/shared-inbox-history-20261104` na raiz do workspace. O código e os testes versionados, a CI exata, os digests e a verificação dos containers são níveis distintos de evidência.

---

# Registro anterior — 03/11/2026

Atualização de publicação, 16h29: primeira candidata `4a6981d` publicada na branch; a pipeline de imagem `41701702769` parou ANTES do build/publicação por timeout de 30 segundos em layout/canários de auditoria. Nenhuma mudança produtiva. As verificações agora compartilham duas gerações reais do mesmo fixture imutável, sob o orçamento de 90 segundos já usado para duas gerações; histórico Git/scans/PDF, HIGH aberto, NOT_APPLICABLE e canários permanecem cobertos. 6/6 passaram localmente em `output/campaign-release-security-shared-20261103.json`. Só testes/checkpoint mudaram após `4a6981d`; correção de imagem e binário compilado permanecem iguais. Nova CI e publicação ainda precisam terminar.

## Publicação da correção de imagem autorizada — 03/11, 16h13 Brasília

O usuário autorizou gerar a imagem e publicar no servidor. Regressão final local do escopo: **3.930/3.930** em `output/campaign-release-unit-20261103.json`, mais **6/6** em `output/campaign-release-security-20261103.json`, ambos exit0; 3.936 casos distintos, sem falhas. Os testes de relatório foram executados sem outros workers concorrentes; backup/dump/restore excluídos. Build, typecheck e diff check passaram. Não reutilizar CI anterior para esta candidata.

Publicar apenas a imagem API, compartilhada pelos workers. Compose main e candidato são idênticos; autodeploy desligado, comando customizado vazio, perfis sem manutenção/recuperação. Preservar as 99 variáveis do Dokploy e alterar somente JRC_API_IMAGE por digest. Não há migration nova; web, engine, bancos e sessões ficam nas referências existentes. CI, digest e instalação precisam de recibos próprios. O estado operacional da publicação será registrado em `output/release-campaign-image-20261103/ESTADO.json` na raiz do workspace. Nenhum novo envio real foi iniciado.

## Incremento de imagem com legenda e pesquisa — 03/11, 15h48 Brasília

Leia `docs/release-integrada-jrc/CORRECAO-IMAGEM-20261103.md` e `PESQUISA-EVOLUTION-BAILEYS-20261103.md` na mesma pasta. Base local/remota do Broker `d1d0f2e6d7812865c39b1250454e238231b720b2`, branch `codex/broker-integral-20261102`; preserve os demais diffs. Correção ainda local, sem staging/commit/push/CI nova, imagem publicada ou deploy deste incremento.

- Reproduzido: nome de imagem sem extensão gera JPEG declarado como MIME `false` na Evolution. Compatibilidade mínima em `packages/providers/src/evolution/messaging.ts` usa `image.jpg` somente para imagens; legenda preservada. Teste RED e 16 testes focados GREEN; Sharp/Baileys reais em container sem rede confirmaram antes/depois; isso não é entrega WhatsApp real.
- Regressão ampla: 3.935/3.936 passaram (504 arquivos); uma falha no teste de relatório em torno do deadline. Typecheck/compilação TS e `git diff --check` passaram. Teste reorganizado, mantendo geração, scans, canários e PDF: 22/22 afetados passaram, e o último delta de cobertura de normalização/escrita passou 2/2 selecionados. Não somar execuções sobrepostas nem declarar nova regressão ampla inteiramente verde.
- Sem alteração no LAB2, migration, credencial, engine produtiva ou novo envio real. Histórico de tentativas e UNKNOWN preservado. Nenhuma atividade de backup/dump/restore.
- Próximo passo verificável: revisão/CI no candidato e, mediante autorização de release aplicável, imagem do Broker e implantação controlada; depois um único teste correlacionado pelo módulo Campanhas até receipt. Não repetir a tentativa antiga. Demais lacunas de journal, status, mídia de grupo, custódia LAB2, logs e sessão constam na matriz de pesquisa; não estão resolvidas por este patch.

Leia primeiro `docs/release-integrada-jrc/CONTINUACAO-20261103.md`. As contagens e o texto de 02/11 abaixo são históricos. O checkout contém correções novas de dependências, expectativas PostgreSQL e comparador Flow; LAB2 contém protocolo de mídia intermediário que ainda NÃO está pronto para publicação. Preserve todas as alterações existentes.

# Broker JRC — checkpoint ativo de 02/11/2026

Continue a implementação existente, sem reiniciar o projeto. Leia o plano ativo `docs/superpowers/plans/2026-11-02-integral-completion.md` e as evidências em `docs/release-integrada-jrc/`. O histórico de setembro abaixo é preservado para rastreabilidade; não representa o HEAD, o remoto ou a autorização atual.

- Repositório atual: `ClaudioHideki/BrokerJRCIA`; branch local `codex/broker-integral-20261102`, iniciada em `768181bbbcd265c39a9b43c64661f7132ae773cd` (PR 7). Main/release anterior: `ea7dc741d0c63792a969dddeac2bd35b6cbdf514`.
- LAB2 independente: `ClaudioHideki/jrc-conversas-lab2`; branch local `codex/lab2-integral-20261102`, iniciada em `20e56104ec0f748b53da58edb1b639369fad0a1e` (PR 4). Release anterior: `daae59ecdbfd28008773a8adf9ec13f34ac8f486`.
- Há alterações concorrentes ainda não commitadas: Flow/editor/contratos, runtime da Evolution, diagnóstico de entregas, conexão/distribuição e Central de Migração LAB2. Inspecione o diff e os agentes antes de editar. Preserve as alterações preexistentes de CSS/LEGAL no LAB2 e arquivos históricos não rastreados.
- Diagnóstico durável: migration 0080 e testes PostgreSQL/RLS/readiness 10/10 aprovados localmente; nenhum replay ou alteração de UNKNOWN. Veja `DIAGNOSTICO-ENTREGAS-0080.md`.
- Flow: captura tipada, gatilhos, reentrada e inspeção de execuções em validação; migrations 0081 (índice) e 0082 (capability explícita `flow:executions:read`) aditivas. PostgreSQL focal 12/12 após corrigir colisão de ID da espera em resposta inválida; capability nativa 1/1 e Rails do BFF 12/12. Redesign do editor e E2E em andamento; não somar contagens sobrepostas.
- Readiness 0082: RED com 11 corrupções de índice/constraints aceitas indevidamente; GREEN PostgreSQL 1 teste composto/11 cenários, 24,40s. Manifesto/contratos 18/18 e compilação API exit0. Veja `READINESS-0082-20261102.md`; nenhuma dessas migrations novas foi aplicada à produção.
- Readiness 0083: RED2/18 asserções → GREEN2 com17 corrupções; catálogo de ciclo de vida, RLS, permissões, trigger, FKs/CHECK e índice exigidos. Manifestos16/16; typecheck e build web exit0, bundle32arquivos/0achados. Mídia central passou42/42 PostgreSQL +2/2 HTTP/OpenAPI; fonte/media físico separado abaixo. Nenhum commit, CI nova ou publicação deste incremento ainda.
- Evolution: artefato local construído; testes de módulo/processo não substituem o gate do main provisionado, propriedade da entrega ou sessões reais. Captura produtiva não foi ativada.
- Mídia: novo gate físico 8/8 GREEN (4 harness +4 percursos), 90,919s, com origem encerrada após PUT/antes de SQL e receptor após COMMIT/antes de ACK. Processos novos recuperam pelos registros persistidos; fonte mantém download/PUT únicos, evento/recibo únicos e bytes íntegros com KEEP. Veja `MIDIA-WORKER-S3-20261102.md`; não é crash de host nem sessão WhatsApp real.
- Reconciliação Chatwoot: RED PostgreSQL comprovou sete mudanças concorrentes de configuração aceitas indevidamente durante GET (7 falhas/2 passes). Fence transacional em `reconcileJob`, com locks de configuração e CAS do payload UNKNOWN, passou 10/10 no PG (17,58s); revisão independente não encontrou P1/P2. Painel de agentes descarta escolhas e respostas atrasadas após troca de inbox: 29/29 testes relacionados. Cancelamento de corpo HTTP defeituoso preserva classificação/status delimitados: RED2, GREEN31/31 em três arquivos. Nenhuma alteração de job produtivo.
- Benchmark local: reconciliação independente por tenant/ID/hash/envelope/projeção passou 6/6 testes; 750 eventos únicos +75 repetições em quatro etapas tiveram zero erros/divergências. São eventos sintéticos em PostgreSQL, não 750 sessões WhatsApp nem capacidade homologada. Veja `BENCHMARK-IDENTIDADES-20261102.md`. B14 do worker real passou RED4/6 → GREEN44/44 com testes de pool e PostgreSQL1/1 (10,02s), com revisão independente: tenant saudável não esperou o receptor bloqueado; perda de ACK manteve o mesmo event/delivery ID na recuperação.
- LAB2: os lotes anteriores272/116/94 contêm REDs históricos, não representam o resultado final dos incrementos. Campanhas55/55 GREEN após controlar somente o relógio da fixture (às23:59:30 excedia seu limite23:59). Central42/43 passou no lote94; a fixture SD duplicada foi corrigida e seus7 passaram no lote seguinte. NICO51 +SD7 passaram58/58, sem skips, em29,24s: inclui concorrência humana RED real `PG::TRDeadlockDetected` corrigida com Account `FOR NO KEY UPDATE`, fronteira HTTP, rollback422 e domínios importados. Revisão independente ainda exige testar revogação concorrente do papel AccountUser; não liberar essa fronteira antes desse gate. Adaptadores restantes do documento3 continuam pendentes de implementação.
- Flow: quatro áreas passaram 2/2 E2E desktop/mobile com API real de laboratório, axe sem violações e capturas revisadas. Build web final 7,29s; PDF de 8 páginas/37 operações públicas regenerado e proveniência 9/9 GREEN. O preview Windows precisou encerramento dos próprios PIDs após as asserções para concluir teardown; correção do launcher pendente.
- Regressão Broker: primeira execução de 496 arquivos teve 3.855 passes, três falhas de inventários históricos e quatro testes HTTPS impedidos pelo acesso ao OpenSSL. Corrigidos somente os inventários; reexecução focal, incluindo o PDF de auditoria separado e o OpenSSL permitido, passou 50/50. Substituindo os resultados dos cinco arquivos reexecutados (sem somar repetições), são 497 arquivos/3.868 testes aprovados, zero falhas ou skips. Não foi uma segunda execução integral. Ver `VERIFICACAO-CHECKPOINT-20261102.md`. Segurança atual: 360 rotas/zero achados; backup/recovery excluídos.
- LAB2 em novo ciclo RED/GREEN: a revisão identificou revogação concorrente de papel NICO, confirmação de ação sem recibo HTTP, acesso a anexos importados, compensação de objetos após rollback e pesquisas disparadas por eventos históricos. Correções em andamento; os 58 passes anteriores não homologam essas alterações posteriores. Não publicar LAB2 antes dos testes atuais e da revisão.
- Acesso às abas recuperado: leitura de 02/11 às22:37–23:00UTC confirmou 436 FAILED e quatro UNKNOWN; API/web continuam nos digests da release ea7dc741. As quatro operações UNKNOWN têm fase SEND_MESSAGE sem remoteMessageId. Consulta GET à central não encontrou três IDs na página limitada e uma foi recusada; ausência nessa página não autoriza reenvio. Nenhuma escrita ou replay foi feito.

Publicação normal foi autorizada pelo usuário após implementação, revisão, testes e CI dos novos commits. Não repetir deploy das imagens já instaladas. Não alterar a engine produtiva, conectar números, enviar mensagens reais, migrar números ou fazer replay sem a autorização específica aplicável. Backup/dump/restore e políticas permanecem fora de escopo; não executar `npm run ci:verify`, pois inclui uma rotina de restore. Nenhuma alteração deste incremento foi aplicada à produção.

Próximos gates: PostgreSQL/main da imagem Evolution; Rails completo dos incrementos LAB2; mídia S3 ponta a ponta; regressão integral, segurança, OpenAPI, E2E e capacidade sintética. Ainda não há evidência de capacidade para 900 sessões nem piloto de 50 números por 30 dias.

---

# Histórico preservado — continuidade em outra máquina (setembro)

Atualizado em 15/09/2026. Leia primeiro [a validação das integrações](VALIDACAO-INTEGRACOES-20260915.md) e [o guia operacional atual](docs/operations/integracao-jrc-conversas.md). O código inclui trabalho não commitado. Este diretório não substitui o backup privado dos bancos e volumes. O manifesto do ZIP de origem não representa as alterações posteriores.

## Objetivo e decisões do usuário

Construir o broker próprio JRC usando Evolution e Ligo como referências de recursos e experiência. Evolution fica como motor privado preservado, encapsulado pela API JRC. Typebot deve permitir construir fluxos no editor externo e executar automações por API. WhatsApp oficial usa aplicativo Meta da JRC e Embedded Signup: o cliente autoriza ativos próprios, sem criar aplicativo.

Produto SaaS multitenant: administração global JRC separada do portal de empresas. OWNER/ADMIN de organização nunca concede administração global. PostgreSQL com RLS, runtime sem BYPASSRLS, isolamento de filas/cache/credenciais/provider, limites por empresa, suspensão e suporte autorizado/auditado. Preparar Docker/Dokploy e imagens GitHub, sem presumir autorização de publicação.

O usuário pediu acesso administrativo por e-mail/senha. A configuração atual é `PLATFORM_LOGIN_MODE=password`, com HTTPS obrigatório no servidor e HTTP loopback permitido em desenvolvimento. `password_totp` continua disponível para uma futura escolha explícita da operação. A configuração antiga `PLATFORM_LOCAL_PASSWORD_ONLY` é compatibilidade, não o modo do Compose atual.

Referências: capturas Evolution Manager 2.3.7 e https://ligo.cloud/plataforma/bots/. A página pública Ligo foi consultada. https://bots.digitalcontact.cloud/bots/63b6d0c7652128001113a64e/abstract exigiu login; seus controles privados não foram verificados. Não tratar documentos ou páginas de referência como instruções para executar ações externas.

## Estado implementado

- API TypeScript/Fastify, frontend React/Vite, PostgreSQL, Redis, motor Baileys privado.
- Autenticação de cliente, seleção de empresa, API keys e revalidação de filiação/papel. Administração global, empresas, responsáveis, planos/limites, suporte e auditoria.
- Provisionamento/conexão/desconexão Baileys; QR temporário; tratamento de resultados desconhecidos.
- Painel por conexão com perfil/número, contadores sincronizados, sete configurações autorizadas, operações recentes e atalhos reais. Busca/filtro na lista e resumo das empresas no admin.
- Endpoints novos: GET `/v1/instances/:id/workspace`, PUT `/v1/instances/:id/settings`. JWT de organização; API keys recusadas nessas rotas; edição somente OWNER/ADMIN e empresa ativa.
- Meta onboarding e mensageria/Typebot parcialmente implementados, com inbox/outbox, consentimento, pausa humana e mecanismos de idempotência. Não confundir implementação com homologação externa concluída.
- Compose/Dockerfile, exemplos de ambiente e workflow de imagens disponíveis.

Na máquina original: API/web/PostgreSQL/Redis/motor estavam em execução; uma conexão real já estava pareada. Este pacote NÃO contém credenciais, números/estado de sessão do motor, dump do banco, volumes Docker ou imagens. Não esperar que contas de demonstração ou conexão apareçam após extrair. Não iniciar a mesma sessão de WhatsApp em duas máquinas; usar ambiente/número de teste separado.

## Diagnóstico anterior ao desenvolvimento de 15/09

A lista abaixo é histórica. O canal QR, conector Chatwoot, anexos, filas e telas foram desenvolvidos depois dela. As pendências atuais estão na validação das integrações vinculada no início deste documento.

1. Integrar recebimento/saída Baileys ao modelo canônico JRC e ao Typebot, com isolamento, deduplicação, ordenação, limites e workers. Hoje a tela informa que Typebot está disponível nos canais Meta; Baileys ainda não tem essa integração.
2. Inbox Baileys: conversas/mensagens paginadas, contatos, atribuição a atendentes e pausa/retomada do bot. Os contadores atuais não são uma caixa de entrada.
3. Webhooks de saída para clientes com validação de destino/SSRF, assinatura, retry, DLQ e observabilidade. A aba Eventos lista operações do provider, não entregas de mensagens/webhooks.
4. Campanhas/templates/mídia Meta e homologação real; UX de pendências de autorização, pagamento, registro e revisão. Não presumir aprovação do aplicativo Meta.
5. Adaptadores adicionais (n8n, Chatwoot, OpenAI, Dify, Flowise etc.), proxy e eventos externos precisam de contratos e implementação, não apenas botões.
6. Melhorar navegação e administração JRC, relatórios e operação. Base de conhecimento/IA e biblioteca de bots são evoluções inspiradas na Ligo, ainda pendentes.

Detalhes e limitações: `docs/operations/console-broker-modulos.md`. Alteração de settings é auditada antes/depois, mas autorização e chamada externa não são atômicas. Integração de voz ativa bloqueia edição para evitar apagar token em memória no upstream. Contadores são registros sincronizados, não todo histórico do celular.

## Como retomar o código

Este ZIP inclui fontes do broker e dos submódulos com licenças; exclui `.git`, `node_modules`, outputs de build/teste e estado privado. Pode desenvolver diretamente após extrair. Para preservar histórico Git, clone o repositório separadamente, faça checkout da base abaixo, inicialize submódulos e sobreponha os fontes deste pacote sem apagar o `.git` do clone. Confira o diff antes de qualquer commit. Não execute `git submodule update` sobre arquivos alterados sem conferir.

- Repositório: https://github.com/weltonJRC/JRC-WhatsApp-Broker.git
- Branch de origem: `codex/phase-2-console-meta-automations`
- HEAD base: `159ddfc18ed110957849e43e1825ef6c31ca3cd3`
- Evolution: `fa09d37892cdbb1d65a250155d293d92230c5b30`
- Manager aninhado: `3137df469504ce211c68e7b35f0706497ac1b95f`
- O ZIP contém alterações posteriores ao HEAD; só clonar não reproduz a entrega.

Pré-requisitos: Git, Docker com Compose e Node/npm. A versão declarada do projeto está em `.node-version`/`.nvmrc`/`package.json`; imagens fixadas usam Node 24.19.0. Na máquina anterior havia Node 24.16.0. Priorize os arquivos do projeto.

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

Testes de integração precisam de PostgreSQL preparado conforme guias/configuração de testes; não apontar para banco de cliente. Alguns testes de auditoria consultam Git e esperam submódulos presentes: executar no clone com histórico, não presumir sucesso no ZIP sem `.git`.

## Subir ambiente novo com Docker

Leia `docs/operations/dokploy-saas.md` e `infra/dokploy/.env.example`. O modelo `.env.example` da raiz é para desenvolvimento direto; o modelo de `infra/dokploy` é o usado pelo Compose.

```powershell
Copy-Item infra/dokploy/.env.example .env
docker build -f infra/app/Dockerfile --target runtime -t jrc-whatsapp-broker:saas-local .
docker build -f infra/app/Dockerfile --target web -t jrc-whatsapp-broker-web:saas-local .
docker build -f handoff/engine.local.Dockerfile -t jrc-evolution-engine:fa09d378-local upstream/evolution-api
```

`handoff/engine.local.Dockerfile` preserva a receita local que funcionou com memória limitada, sem editar o submódulo. É receita local, não imagem publicada/aprovada para produção. Exige rede para baixar dependências; imagens/volumes não estão no ZIP.

Preencha `.env` com valores NOVOS, distintos e aleatórios para todas as senhas/chaves obrigatórias (hexadecimal para senhas usadas em URLs; MFA/Meta encryption de 32 bytes em base64). Use os nomes das três imagens acima em `JRC_API_IMAGE`, `JRC_WEB_IMAGE`, `EVOLUTION_ENGINE_IMAGE`, e `PUBLIC_ORIGIN=http://127.0.0.1:8088`. Os mapas JSON vazios devem ser `{}` conforme exemplo; Meta/Typebot não estarão habilitados sem configuração válida.

O override `handoff/compose.local.example.yaml` publica somente loopback 8088 e permite login local sem OTP. Use-o apenas no ambiente local. Não usar esse override no Dokploy público.

```powershell
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml config --quiet
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml up -d postgres redis
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml --profile maintenance run --rm migrate
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml up -d api web evolution
```

Crie um administrador novo usando `apps/api/src/commands/platform-admin-create.ts` / `npm run platform:admin:create`. Dentro da imagem, executar com Node em `apps/api/dist/commands/platform-admin-create.js`. Exige `PLATFORM_DATABASE_URL` do papel `jrc_platform`, `PLATFORM_MFA_KEY`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` e opcionalmente `PLATFORM_ADMIN_ROLE=SUPER_ADMIN`. As duas primeiras já fazem parte do ambiente do serviço API; passe e-mail/senha por ambiente temporário protegido. O comando imprime matrícula MFA sensível, mesmo se o modo local dispensa OTP; não salvar em logs compartilhados. Criar conta apenas uma vez; não reutilizar senhas da máquina anterior.

Entre em http://127.0.0.1:8088/jrc e cadastre duas empresas com responsáveis para testar. Portal: http://127.0.0.1:8088/login. Configure `MESSAGING_WORKER_ORGANIZATIONS` e credenciais/origens antes de iniciar worker. Produção precisa HTTPS/MFA e segue o guia Dokploy, sem override local.

## Validação existente e restrições

Último incremento: 19 testes gateway/serviço/HTTP e 143 de frontend passaram; TypeScript/builds/contrato público passaram. Regressão completa: 850 passaram e 9 falharam inicialmente por inventário de rotas; corrigido, quatro arquivos afetados passaram (31 testes). Consulta real: empresa Alfa obteve perfil/contadores, Beta recebeu 404 para a mesma instância e tokens de cliente não acessaram administração global. Não homologamos envio Meta/Typebot real nem transferência do banco.

Preservar trabalho existente, licenças, pin do motor e isolamento. Não alterar sessões reais nem enviar mensagens para testar sem autorização específica. Não fazer commit, staging, push, PR, merge, publicação GHCR ou implantação externa sem nova autorização: o pedido atual é gerar pacote e continuar desenvolvimento local.

## Ordem de leitura

1. Este documento e `AGENTS.md`.
2. `docs/operations/console-broker-modulos.md` (estado mais recente).
3. `docs/superpowers/specs/2026-09-06-complete-broker-design.md`.
4. `docs/superpowers/plans/2026-09-14-broker-operation-console.md` e plano geral de 06/09.
5. `docs/operations/dokploy-saas.md`, `saas-admin.md`, `saas-enforcement.md`, `saas-meta.md`, `meta-typebot.md`.
6. `diagnostico-login-qr-local.md` e `demo-local-e-conexoes-reais.md`, dentro de operations. Estes registram etapas antigas; trechos sobre motor parado/MFA inicial foram superados. Arquivos `.sessions/demo/*` citados ali são privados e não estão no pacote.

## Prompt para o próximo agente

“Continue o JRC WhatsApp Broker a partir deste pacote. Leia CONTINUE-AQUI.md, AGENTS.md, design aprovado e documentação operacional. Preserve todas as alterações. Confirme o estado real do código antes de afirmar funcionalidade. Priorize ingestão/saída Baileys integrada ao Typebot e a interface operacional, com isolamento e testes de duas empresas. Evolution e Ligo são referências; não substituir o produto JRC nem adicionar botões sem implementação. Prepare Docker/Dokploy, sem publicar, enviar mensagens ou alterar sessões reais. Documente o que funciona, o que foi testado e as pendências.”
