# Broker + JRC Conversas — validação do incremento de 25/09/2026

Este documento descreve código preparado localmente. **Não certifica a jornada comercial de ponta a ponta e não autoriza deploy.** O teste de componentes com PostgreSQL e Redis descartáveis não substitui pareamento WhatsApp real, WABA Meta, JRC Conversas por HTTPS ou carga no Dokploy.

## O que este incremento acrescenta

| Área | Alteração local | Limite atual |
| --- | --- | --- |
| Caixas, automações e administração | Paginação por cursor e carregamento progressivo nas caixas operacionais e administrativas; revisão de vínculo entre grupo econômico e empresas. | A visão geral de empresas e grupos ainda agrega páginas antes de exibir dados; milhares de itens exigem medição e paginação visível. Grupo econômico não compartilha permissões nem dados. |
| Importação de automação | Prévia sem gravação, confirmação explícita, rascunho idempotente e relatório dos nós incompatíveis. | Um JSON n8n com nós não convertidos continua impedido de publicar. O exemplo recebido tem 62 nós, dos quais 27 são `Code`; JavaScript n8n não é executado no Broker. |
| QR e caixa de entrada | Consulta autenticada da operação de pareamento, código temporário de leitura única, revalidação do vínculo/usuário inclusive após a resposta do provedor, e negação após pausa da integração. O JRC consulta a operação e permite nova tentativa explícita após timeout. | O resultado incerto de CONNECT ainda bloqueia reconexão e arquivamento: sem geração/fence do provedor, um `DISCONNECTED` isolado não prova que a chamada anterior terminou. `GETDEL` consome o QR antes da entrega HTTP, portanto uma resposta perdida não é recuperável pelo mesmo ID. Faltam adoção/desvinculação distribuída e pareamento real. |
| Templates Meta | Submissão de texto com chave de idempotência, busca prévia por nome na WABA, leitura de status e tratamento conservador de resposta incerta. Falha antes do POST não reserva o nome; 401/403/429 após o POST não são tratadas como rejeição definitiva. Uma rejeição definitiva libera apenas a reserva do nome e permite corrigir o corpo com nova chave. | A listagem geral e a busca de status por ID ainda param em 20 páginas de 100. Exige App/WABA reais para homologação. |
| Integração Flow JRC | Contrato proposto de sessão delegada distinta da chave QR e teste negativo impedindo usar a chave QR nas rotas de automação. | Sessão positiva delegada, editor único, owner exclusivo por inbox, handoff/retomada e migração real de `jrc_flows` continuam pendentes. |

O Broker deste incremento não altera migrations nem variáveis de ambiente. As tabelas de idempotência existentes e o Redis configurado são reutilizados. A interface WEB também mudou; a release exige validar e publicar **API e WEB** da mesma revisão, cada uma por digest, junto com sua compatibilidade de schema. O push do código não implanta as imagens no Dokploy.

## Verificações locais

Na revisão atual, `npm test` aprovou **205 arquivos e 1.330 testes** após `npm run build` e regeneração do OpenAPI. Também passaram `npm run test:web:bundle`, `npm run security:contracts`, `npm run security:notices`, `npm run security:submodule`, `npm run security:release` (189 rotas, zero achados com chave sintética local), `npm audit --audit-level=high` (zero vulnerabilidades) e `git diff --check`. A integração anterior com PostgreSQL e Redis descartáveis aprovou **49 arquivos e 286 testes**, mas **não foi repetida após estas alterações**: o Docker deste computador não iniciou. O E2E desta revisão também não pôde começar sem `TEST_DATABASE_ADMIN_URL`. O workflow de imagens executa a integração com PostgreSQL/Redis antes do build; status do GitHub Actions e digests publicados devem ser registrados separadamente. Testes focados de QR e Meta não comprovam fluxo externo real.

O módulo QR do JRC foi enviado separadamente na branch `codex/jrc-qr-pair-status-20260925`, commits `8e2245e` e `61b120a`. Ele não está implantado no servidor somente por ter sido enviado ao GitHub.

## Diagnóstico dos avisos 503 no Dokploy

As capturas mostram uma resposta genérica para grupos, caixas e automações; não demonstram uma causa única. A configuração Meta ausente não explica, por si só, a falha da lista de grupos. A versão do schema, as flags do runtime e a imagem efetivamente em execução precisam ser conferidas antes de alterar ENV ou banco.

1. No serviço Compose **broker** do Dokploy, registrar a branch, o caminho do Compose e os digests efetivos de API e WEB exibidos no deploy. Uma build verde no GitHub não troca os contêineres em execução.
2. Reproduzir um único 503 e anotar horário, rota e `requestId` mostrado na tela. Abrir **Logs** do contêiner `api` e localizar esse identificador; capturar o código/stack da falha com tokens e dados de clientes ocultos.
3. No contêiner de manutenção, executar `db:schema:status` usando a credencial migradora já configurada, sem imprimir o `.env` ou `docker compose config` expandido. Conferir se a migration esperada `0031_economic_groups` consta como aplicada antes de concluir que o painel de grupos está compatível.
4. Verificar a flag efetiva `AUTOMATION_RUNTIME_V2_ENABLED` e a saúde dos workers, Redis e PostgreSQL. Não ativar o runtime apenas para ocultar um 503: primeiro confirmar schema, cofre, sandbox e workers.
5. Só com causa correlacionada, preparar backup, aplicar migration pendente se necessária, promover imagens compatíveis e repetir o teste de grupos, caixas, automações e pareamento.

Prints úteis, sem segredos: visão dos serviços e status; configuração Git (branch e Compose Path); digests dos contêineres; trecho do log da API que contém o `requestId`; saída de status do schema com senhas mascaradas. Não compartilhar o `.env`.

## Saída necessária antes de venda/deploy

- Q3 completo entre Broker e JRC: adoção de inbox existente, QR assíncrono, confirmação de identidade, revogação, reconexão e reconciliação de operações incertas.
- A1/A2: sessão de Flow delegada e editor JRC sobre o grafo Broker. A3: um único motor por inbox com fence/drain. A4: transferência humana e retomada idempotentes. Migrar `jrc_flows` reais por prévia e corte reversível.
- Catálogo de nós com formulário, validação e execução coincidentes; converter o JSON piloto sem nós `unsupported` antes de publicar. Blocos `Code` exigem migração segura de lógica, não execução direta do código de origem.
- App Meta, WABA, webhook, templates e mídia testados com ativos próprios; módulo versionado para QR/reconexão em Chatwoot de terceiros testado na versão do cliente.
- Jornada HTTPS com duas empresas isoladas; carga, falha de engine, restore e rollback ensaiados antes de anunciar milhares de conexões ou publicar imagens.
