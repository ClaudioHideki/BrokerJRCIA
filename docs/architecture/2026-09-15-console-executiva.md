# Console executiva — especificação da refatoração

Pedido atual: validar o plano mestre, refatorar o projeto e aproximar a interface da referência de nove telas. Documentos anteriores são evidência histórica, não autorização operacional.

## Decisões
- Preservar Fastify/React/TypeScript/PostgreSQL, autenticação, isolamento e rotas existentes.
- Criar resumo operacional agregado no servidor, com contratos validados, período UTC explícito e contexto da empresa autenticada. Não inferir SLA, entrega ou cobrança a partir de conexão online.
- Layout claro com navegação lateral, cards, tabelas, gráficos acessíveis e detalhes; preservar formulários e permissões existentes.
- Dashboard, provedores, health, relatórios e uso compartilham o resumo; falhas nunca viram zero. Relatórios exportam apenas agregados da empresa ativa.
- Provisionamento CSV limitado a 100 nomes: prévia, validação, criação sequencial com chave idempotente, parada em resultado incerto. A criação não pareia aparelhos. A janela precisa permanecer aberta; fila persistente será etapa posterior.
- JRC Brain apresenta diagnóstico determinístico com evidências; assistente generativo e cobrança não estão habilitados.
- Preview com dados sintéticos exclusivamente em desenvolvimento, removido do build de produção.

## Aceite
Testes de contrato, isolamento HTTP e troca de tenant; parser CSV, quota e parada do lote; regressão existente, typecheck/build e inspeção visual desktop/mobile. Homologação externa depende de ambiente e canais dedicados.
