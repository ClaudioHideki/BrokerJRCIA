# Checkpoint — 01/11/2026

Branch codex/broker-jrc-2-redesign-homologacao-20261030, publicado b076e05. Novos agentes H01,B07,UX trabalham sem commits/push. Conferir diff e relatórios output/h01-20261101,output/b07-20261101,output/ux-connections-20261101 antes de consolidar.

Workflow41320633958 aprovou b076 e publicou digests registrados em06. Não usar esse resultado como prova das mudanças posteriores. Environment permanece original; abertura autorizada só para duas imagens. Gateprod:backup/restore.

PG local dedicado localhost15439/db lab_broker_ci. Credenciais são fixture sintética, nunca usar DATABASE_URL real como fallback. Variável de testes obrigatória TEST_DATABASE_ADMIN_URL parahelpers. Container limitado768MiB/1CPU rotulado descartável. Banco restaurado lab_broker_restore_20261101 validou schema/probe; ainda não é restorecompleto.

Próxima ação: reunir agentes, revisar diff, executar npm test dos arquivos afetados,integraçãoPG,typecheck/build e CI completa após commitrevisável. Não enviar mensagens para comprovar sem alvosautorizados. Seguir B02/B03 sem confundir mocks com falhasprocessoreais.

## Checkpoint posterior

PRrascunho https://github.com/ClaudioHideki/BrokerJRCIA/pull/6 . CI049a410run41324109368sucesso(browser37pass+5skip). Novoscomponenteslocais originjournal25testes,receptor12testes,restoreharnessreforçado comRLS/bytes. Novosscripts/workflowsdevemserconsolidadosemoutrocommit, semconfundircomimagem b076jápublicada. Nenhumdeploy.

PróximaintegraçãoB02: adaptadorACKBrokerautenticado comdedupetransacional,bootstrapsource eownershipúnico,buildenginecompinadoecrashrealemlab. PróximoB03: S3/MinIO+workerreal+restoreobjetosekeycustody. Faltam ainda shelladmin/empresa completo,LAb2real,demaismódulos,fairness/pools eensaio50/30dias. Nãofechar essesitens comoprovasdecomponentes.
