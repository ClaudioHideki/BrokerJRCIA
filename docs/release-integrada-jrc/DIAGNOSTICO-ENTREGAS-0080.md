# Diagnóstico durável de entregas — incremento em validação

## Defeito reproduzido

O cliente HTTP reconhecia falha de transporte, status HTTP e falha na leitura da resposta, mas o worker guardava somente `last_error`. Um `CHATWOOT_REQUEST_REJECTED` histórico não permite descobrir retrospectivamente se houve HTTP 401, 403 ou 422. Os 436 FAILED e quatro UNKNOWN da fotografia anterior não são uma comprovação da situação atual nem de uma causa única.

## Contrato aditivo

`GET` de jobs existentes recebe `failureDiagnostic`, opcional para compatibilidade com servidores anteriores e `null` sem observação confiável. A observação contém somente versão 1, fase enumerada, método GET/POST/PATCH ou nulo, HTTP 100–599 ou nulo, tentativa, resultado de processamento e horário UTC da falha. Não inclui URL, headers, token, telefone, mensagem, stack, payload ou corpo da resposta remota.

O registro representa a última falha observada, mesmo se uma tentativa posterior recuperar a entrega. `RETRY_SCHEDULED` não prova que o retry já ocorreu. `UNKNOWN` não prova rejeição nem ausência de efeito remoto. Não há nova ação automática de replay, mudança de destinatário ou liberação de UNKNOWN.

## Migration 0080

Adiciona `integration_jobs.failure_diagnostic` JSONB nullable com CHECK de chaves exatas e campos limitados. Linhas antigas permanecem nulas. RLS e grants da tabela existente são preservados. Não há backfill de fatos inexistentes, exclusão de registro, snapshot ou rotina de backup.

O novo binário deve exigir a estrutura em readiness e ser instalado após a migration. O binário anterior compara seu manifesto exato e não deve ser anunciado como rollback automaticamente compatível com um ledger mais novo. Reversão operacional exige uma candidata compatível com o schema que preserve a coluna e suas evidências; não apagar a migration/coluna para tornar verde uma checagem antiga.

## Evidências deste incremento até o momento

- Fronteira HTTP: RED 11/11; após correção, 28/28 com cliente e segurança existentes.
- Projeção limitada: módulo ausente no RED; GREEN 4/4; junto à fronteira HTTP, 15/15.
- Painel: componente ausente no RED; GREEN 3/3; com diagnóstico histórico existente, 11/11.
- Manifesto: teste adicional RED 1 falha/5 aprovados antes de existir 0080.
- Persistência PostgreSQL real: RED com dois casos sem diagnóstico persistido. GREEN 10/10 em `chatwoot-tenants.test.ts` e `runtime-schema-readiness.test.ts`, 47,77 s, exit 0. Inclui HTTP 503 em GET com recuperação, HTTP 503 em POST mantido UNKNOWN sem nova chamada, CHECK de formato, isolamento entre tenants e readiness rejeitando ausência da coluna ou da constraint.
- Manifesto e baseline consolidados de 0080/0081: GREEN 10/10 em três arquivos. A migration 0081 pertence ao incremento de inspeção de execuções Flow.
- Regressão integral e CI do novo commit: ainda não executadas; os resultados acima são locais e de escopo explícito.

### Cancelamento defeituoso do corpo HTTP

Dois novos RED demonstraram que `response.body.cancel()` lançando erro durante uma resposta 503 substituía o diagnóstico limitado por uma exceção arbitrária. A correção ignora somente esse erro de descarte e preserva o status observado e a classificação original: GET pode ser tentado novamente; POST continua incerto. Não guarda o texto da exceção. GREEN: **31/31, três arquivos, 9,74s, exit0**, `output/integral-http-cancel-green.log`. Não é uma explicação retrospectiva para os UNKNOWN de produção.

## Limitação conhecida

Se a resposta é JSON válido, mas não corresponde ao contrato específico de catálogo/efeito, o validador pode lançar um erro sem o contexto HTTP original. Esse caso continua com fase UNKNOWN e campos nulos: não é lícito inferir um status 200. Os novos detalhes cobrem transporte, rejeição HTTP e leitura do corpo; não recuperam metadados ausentes de tentativas históricas.

Nenhuma evidência sintética é declarada como entrega de WhatsApp, causa raiz de jobs históricos ou homologação do CCLX.
