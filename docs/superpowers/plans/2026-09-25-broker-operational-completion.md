# Broker JRC — conclusão operacional e comercial

**Base aprovada:** `2026-09-22-jrc-platform-v2-completion-design.md`, programa da Fase 9 e auditoria `broker-commercial-readiness-20260925.md`. Este plano registra trabalho restante; nenhum item é considerado homologado pela existência de uma rota ou por testes com fakes.

## Ordem e critérios de saída

1. **Recuperar o ambiente e os erros 503.** Conferir SHA/digest em execução, `db:schema:status` e flags efetivas, correlacionar cada falha de grupos, canais e automações com o `requestId` da API. Corrigir discrepâncias de código/configuração encontradas e testar com PostgreSQL. Sem acesso ao servidor, registrar a checagem como pendente, nunca como aprovada.
2. **Q3 — ciclo QR e inbox.** Broker deve registrar operação idempotente, permitir consulta autenticada da operação até QR/código, conectado ou erro, preservar identidade e histórico ao desconectar, e reconciliar o estado remoto. JRC deve adotar inbox existente com revisão esperada, revalidar grants, exibir QR tardio e revogar/desvincular com estado persistente. Testar concorrência e duas Accounts.
3. **A1/A2 — acesso delegado ao Flow.** Usuário JRC autenticado recebe sessão curta, vinculada a Account, Inbox e papel; o Broker revalida autorização em leitura e escrita. Editor no JRC usa o mesmo grafo/versionamento do Broker. A chave do módulo QR não autoriza editar automações.
4. **A3/A4 — proprietário único e atendimento humano.** Registrar por inbox `LOCAL_LEGACY` ou `BROKER`, com revisão monotônica, drain e fence antes de ligar o novo runtime. Handoff e retomada precisam de callback idempotente, reconciliação e testes para duplicatas, atraso, falha e isolamento entre Accounts. Migrar `jrc_flows` reais por prévia, corte e rollback.
5. **Automation Studio comercial.** Para cada nó suportado, entregar schema, formulário, validação, simulação e executor com semântica coincidente. Priorizar o JSON representativo: condições/switch, HTTP, subflow, espera, variáveis, Redis segregado, IA, webhook e resposta. Nós Code de n8n só migram após conversão segura; nunca executar JavaScript bruto no host. Importar, editar, publicar e executar os três fluxos de teste, sem copiar credenciais de origem. Um rascunho com nó incompatível continua bloqueado para publicação.
6. **Meta e Chatwoot de terceiros.** Completar templates (criar, submeter, acompanhar estado), mídia, revogação e reconciliação; validar com WABA de teste quando o App JRC estiver pronto. Para Chatwoot próprio do cliente, versionar módulo de QR/estado/reconexão com BFF e grants por Inbox; a ponte API Inbox deve funcionar também sem o módulo visual. Homologar na versão exata do host.
7. **Escala e release.** Paginar listas; manter atribuição estável instância→engine QR, limites por tenant e métricas de fila, sessão, reconexão e custo. Medir carga e falha de engine antes de anunciar milhares de números. Validar upgrade de schema, restore, HTTPS em duas empresas e ida/volta real. Só então publicar imagens API/WEB alteradas por digest e preparar implantação no Dokploy.

## Regras de execução

- Usar testes antes de cada correção, contrato entre repositórios versionado e checagem de permissão/isolamento nos limites de Account e organização.
- Preservar NICO, CRM, inboxes, mensagens e flows legados durante migração. Grupo econômico é administrativo e não concede acesso cruzado.
- Separar sempre **implementado localmente**, **testado com dependências reais em homologação** e **implantado**. Não inventar credenciais Meta ou segredos e não usar a base de produção para testes.
