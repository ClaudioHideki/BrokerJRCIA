# Verificação local do incremento de 02/11/2026

Base: `768181bbbcd265c39a9b43c64661f7132ae773cd`, branch `codex/broker-integral-20261102`. Este checkpoint registra código e testes locais. Não representa publicação, implantação nem homologação de uma sessão WhatsApp.

## Regressão unitária e contratos

| Execução | Arquivos | Testes | Aprovados | Falhas | Pendentes |
|---|---:|---:|---:|---:|---:|
| Integral, excluindo backup/recovery e separando PDF de auditoria | 496 | 3.862 | 3.855 | 3 | 4 |
| Reexecução dos quatro arquivos afetados + PDF de auditoria | 5 | 50 | 50 | 0 | 0 |
| Resultado por arquivo mais recente, sem duplicar reexecuções | 497 | 3.868 | 3.868 | 0 | 0 |

A execução integral durou 1.177,50 segundos. O resultado consolidado substitui integralmente cada arquivo reexecutado pelo resultado novo; não soma casos repetidos e não afirma que houve uma segunda execução integral.

Falhas reproduzidas e correções:

1. O inventário OpenAPI não incluía quatro rotas implementadas e verificadas: `GET /v1/executions/{id}/playground`, `POST /v1/executions/{id}/simulate`, `GET /v1/delegated-flows/{id}/executions` e `GET /v1/delegated-flows/{id}/executions/{executionId}`. O inventário passou de 356 para 360 operações.
2. O teste histórico de migrations comparava as cinco últimas entradas, deixando de preservar a referência 0075–0079 quando 0080–0083 foram acrescentadas. Agora valida a posição exata do prefixo histórico e o baseline 0083, sem modificar migrations antigas.
3. O teste de política de auditoria precisava reconhecer os filtros implementados de `GET /v1/executions`: automationId, channelId, cursor, from, nodeId, pageSize, search, status e to. O relatório histórico permaneceu imutável.
4. Quatro testes de socket HTTPS não conseguiam iniciar OpenSSL no sandbox. O binário instalado foi verificado e sua execução local autorizada pela revisão automática. Os quatro passaram; não foi necessária alteração da implementação HTTP.

Esses ajustes finais foram somente nos testes de inventário, sem modificar comportamento produtivo. Evidências brutas locais: `output/integral-full-unit-20261102.{json,log}` e `output/integral-full-unit-repair-20261102.{json,log}`. O manifesto agregado nesta pasta registra hashes e comandos, sem payloads de clientes.

## Demais verificações

- Compilação TypeScript estrita e build web aprovados. Build web final: 7,29 segundos.
- Bundle web: 32 arquivos examinados, zero achados.
- Verificação de segurança da release atual: 360 rotas, zero achados de scanners; segredo efêmero de fingerprint criado apenas em memória, removido após a execução.
- Submódulo Evolution preservado e limpo no pin existente; avisos de terceiros aprovados para sete pacotes.
- PDF da API: oito páginas, 37 operações do contrato público de parceiro, nove testes de proveniência aprovados. As 37 operações públicas não equivalem às 360 operações totais administrativas/internas/públicas.
- Flow: dois E2E desktop/mobile com axe e capturas revisadas. O encerramento do servidor de preview no Windows precisou intervenção limitada aos processos do próprio teste; permanece correção de launcher pendente.
- Migrations 0080–0083 aditivas e gates PostgreSQL focais documentados separadamente. Nenhuma aplicada em produção neste incremento.
- Revisão independente adicional identificou readiness incompleta para colunas operacionais de mídia. RED de 16 asserções, correção do probe (sem nova migration), GREEN 2/2 com 33 corrupções em 22,38s. Esse ajuste posterior à suíte unitária foi novamente compilado e validado nos testes focais de esquema; detalhes em `READINESS-0083-20261102.md`.

## Limites e próximos gates

Backup, dump, restore e políticas permanecem fora de escopo; a exclusão desses testes não comprova recuperação de dados. Não executar `ci:verify`, que agrega rotinas excluídas.

O checkpoint não libera a engine produtiva. A imagem com os onze overlays deve ser reconstruída a partir do commit consolidado e passar pelos gates de admissão e pelo handler real provisionado, crash/restart e correlação. As evidências de imagens anteriores não aprovam automaticamente o novo artefato.

LAB2 continua em ciclo RED/GREEN para permissões NICO e migração de anexos/eventos; não está liberado por estes testes Broker. Ainda faltam suítes integrais PostgreSQL/Redis/Rails, incrementos funcionais restantes, CI dos novos SHAs, imagens, e homologação operacional conforme a autorização de cada etapa. Não houve envio real, replay UNKNOWN, alteração de sessão ou mutação produtiva neste checkpoint.
