# Continuidade da PR #6 — incremento local de 01/11/2026

Base reconciliada: ea58a897b923fc5889e99ea039b4bd61c385d781. Reusar a branch codex/broker-jrc-2-redesign-homologacao-20261030 neste checkout. Não reiniciar, resetar, limpar ou descartar arquivos anteriores.

Leia primeiro 10-INCREMENTO-ORIGEM-CUSTODIA-20261101.md, 11-VERIFICACAO-E-ENTREGA-20261101.md e ESTADO-FINAL.json. A seção histórica abaixo registra etapas anteriores e não descreve automaticamente o diff atual.

Entregas locais: ACK correlacionado/ledger0078 e gates estruturais; transporte/worker de origem e SIGKILL contra Broker real; guard seletivo preparado sobre source pinada; receptor PG+MinIO/hash/KEEP; contrato do parser Ruby real LAB2; shells responsivos/acessíveis; orçamento explícito de pools; gates CI/documentação atualizados.

Restrições vigentes: não implantar, não fazer merge na main, não alterar credenciais nem conectar números reais. Nenhum envio/replay real. Imagens ea58 permanecem evidência da base, não deste diff. Nenhum estado atual do Dokploy foi confirmado nesta execução.

B02 e B03 seguem PARCIAIS. A flag da origem deve continuar rejeitando deliveryOwnership UNPROVEN. Não promover ACK legado a recibo durável. Não usar receipt de mídia/arquivo .cipher como prova de criptografia ou autorização de expurgo. Não reenviar operações UNKNOWN cegamente.

Próximos gates internos: composição real da engine com proveniência notify/append e bootstrap/guard instalados juntos; build/crash/restart de engine; pipeline de mídia com worker e restore conjunto; LAB2 Rails isolado completo; canários de logs na imagem efetiva; fairness/pools medidos. Depois disso, piloto real somente autorizado. Nenhum teste sintético comprova 50/30dias,400 ou900 sessões.

O laboratório dedicado usa PG loopback15439, Redis15441 e MinIO15440. Não usar contêineres compartilhados nem DATABASE_URL real. Use TEST_DATABASE_ADMIN_URL explicitamente; o runner cria bancos aleatórios descartáveis. Evite rodar suítes PG pesadas simultaneamente. A revisão de readiness acrescentou qr-origin-receipt-readiness.test.ts (drift de PK/FK/RLS/grants com rollback).

## Histórico preservado — anterior ao incremento corrente

# Checkpoint — 01/11/2026

Branch codex/broker-jrc-2-redesign-homologacao-20261030, publicado b076e05. Novos agentes H01,B07,UX trabalham sem commits/push. Conferir diff e relatórios output/h01-20261101,output/b07-20261101,output/ux-connections-20261101 antes de consolidar.

Workflow41320633958 aprovou b076 e publicou digests registrados em06. Não usar esse resultado como prova das mudanças posteriores. Environment permanece original; abertura autorizada só para duas imagens. Gateprod:backup/restore.

PG local dedicado localhost15439/db lab_broker_ci. Credenciais são fixture sintética, nunca usar DATABASE_URL real como fallback. Variável de testes obrigatória TEST_DATABASE_ADMIN_URL parahelpers. Container limitado768MiB/1CPU rotulado descartável. Banco restaurado lab_broker_restore_20261101 validou schema/probe; ainda não é restorecompleto.

Próxima ação: reunir agentes, revisar diff, executar npm test dos arquivos afetados,integraçãoPG,typecheck/build e CI completa após commitrevisável. Não enviar mensagens para comprovar sem alvosautorizados. Seguir B02/B03 sem confundir mocks com falhasprocessoreais.

## Checkpoint posterior

PRrascunho https://github.com/ClaudioHideki/BrokerJRCIA/pull/6 . CI049a410run41324109368sucesso(browser37pass+5skip). Novoscomponenteslocais originjournal25testes,receptor12testes,restoreharnessreforçado comRLS/bytes. Novosscripts/workflowsdevemserconsolidadosemoutrocommit, semconfundircomimagem b076jápublicada. Nenhumdeploy.

PróximaintegraçãoB02: adaptadorACKBrokerautenticado comdedupetransacional,bootstrapsource eownershipúnico,buildenginecompinadoecrashrealemlab. PróximoB03: S3/MinIO+workerreal+restoreobjetosekeycustody. Faltam ainda shelladmin/empresa completo,LAb2real,demaismódulos,fairness/pools eensaio50/30dias. Nãofechar essesitens comoprovasdecomponentes.
