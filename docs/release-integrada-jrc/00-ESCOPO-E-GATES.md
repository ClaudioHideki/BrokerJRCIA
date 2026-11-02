# Release integrada JRC — execução de 02/11/2026

A solicitação vigente autoriza commits, push, integração na branch de publicação, imagens e Dokploy após gates. A proibição histórica de merge foi substituída por essa autorização. Não executar backup, snapshot, dump, restore, políticas, carga histórica, conexão/envio real ou replay cego. Preservar dados, sessões e mecanismos existentes. A captura experimental Evolution continua desativada até prova de ownership do artefato final.

## Correção do gate de schema

CI 41478793811 do commit b7a6e19c4f9a18a7a3c3141fc6bfefc492f3d923 executou 3702 testes unitários, 6 de PDF e 777 web com sucesso. Na integração PostgreSQL/Redis houve 1580 passes e duas falhas: assertions de readiness ainda esperavam o literal 0078, embora runtime e migration anterior já exigissem 0079_partner_persistence_receipts. Não era evidência de falha produtiva nem autorização para rebaixar o schema.

Reprodução local das mesmas duas files: 28 passes/2 falhas. Correção limitada aos dois literais; os 28 casos negativos e código de runtime/migration foram preservados. Reteste: 30/30. A tentativa inicial com maintenance database incorreta falhou no setup, não conta como RED funcional. Log externo: broker-readiness-regression.log. Exigir nova CI para o novo SHA, inclusive gates não alcançados na execução anterior.

## Exclusão de rotinas fora do escopo

A exceção antiga dependia do nome da branch e acionaria rotinas excluídas após merge na main. CI e publicação agora preservam esses testes e scripts atrás de include_recovery, booleano manual com padrão false. Push, PR e publicação normal não os executam. Não marcar os testes excluídos como aprovados nem afirmar recuperação de desastre.

## Consolidação e publicação

PR6 contém sua base d1b66a56 da PR5 por ancestralidade. Comparar com main real antes de integrar; não mesclar uma base antiga que dispare workflows fora do escopo. Retarget e merge normais somente após revisão e CI do SHA atual; respeitar checks/revisões obrigatórios, sem bypass. Executar também CI pós-merge. LAB2 usa a branch de release efetivamente confirmada, não uma main inventada.

Imagens API/workers e web usam revisão imutável e digest. O editor nativo LAB2 deve continuar vinculado a fonte commitada do Broker. Aplicar 0079 somente após revisão de ledger/grants e sequência testada compatível; binário 0078 não é contingência segura para schema0079. Nenhum provisionamento que resete credenciais.

## Cobertura não encerrada

Esta candidata contém correções incrementais de QR, menu versionado, callback durável, distribuição por conexão e reconciliação de importação. Não representa conclusão de todas as jornadas WA, Central de Migração de todos os domínios, roadmap Flow P1–P3, engine em sessão real, custódia real integral, CCLX ou capacidade50/400/900. Seguir matriz completa dos documentos e distinguir código, testes, CI, imagem, implantação e homologação operacional.

## Observação produtiva somente leitura

LAB2 observado em 50f7f07d802829dd44a67547fabad3aa77f3d196 e incorporado na candidata local. API Broker observada healthy no container eecdbd70c7ab, referência ghcr.io/claudiohideki/brokerjrcia-api@sha256:e2bba6518304ee5f792c6ee69177ddb2548a07023b7133c60f4b43390f94d8fb. Isso não confirma, sozinho, ledger ou revisão de todos os workers. Nenhuma mudança produtiva aplicada nesta etapa. Metadados de imagem não são backup.
