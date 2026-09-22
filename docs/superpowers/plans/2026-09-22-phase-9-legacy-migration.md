# Fase 9 — consolidação e migração legada

> **Spec:** `docs/superpowers/specs/2026-09-22-jrc-platform-v2-completion-design.md`
>
> **Programa:** `docs/superpowers/plans/2026-09-22-jrc-platform-v2-program.md`

## Objetivo

Consolidar o snapshot de 22/09/2026 sobre a branch remota mais avançada, terminar a migração expand-and-contract dos flows legados para Automation Studio JRC e produzir uma árvore Git limpa cuja suíte integral seja verde.

## Restrições

- Preservar IDs, versões, checksums, bindings, estado e origem.
- Execução iniciada no runtime antigo termina nele.
- Cada canal possui exatamente um owner ativo.
- Flow incompatível permanece `LEGACY` com relatório; não é executado pelo runtime novo.
- Rollback muda binding/owner sem apagar schemas ou dados.
- Migrations são aditivas e validadas em PostgreSQL real.
- Typebot/n8n continuam sendo importadores, nunca runtimes implícitos.

## Estrutura de arquivos

- `apps/api/drizzle/migrations/0029_legacy_flow_migration.sql`: tabelas, constraints, RLS, grants e funções de descoberta.
- `apps/api/src/modules/automations/legacy-migration.ts`: conversão, reconciliação, cutover e rollback.
- `apps/api/src/commands/legacy-flow-migrate.ts`: execução em lote por organização.
- `apps/api/src/http/routes/automations.ts`: API tenant da migração.
- `apps/api/src/http/openapi.ts` e `docs/api/openapi.json`: contrato público.
- `apps/api/tests/integration/legacy-flow-migration.test.ts`: upgrade e comportamento com PostgreSQL real.
- `apps/api/src/modules/automations/legacy-migration.test.ts`: regras determinísticas e falhas.
- `apps/web/src/automations/LegacyMigrationPanel.tsx`: estado, relatório, cutover e rollback.
- `apps/web/src/automations/LegacyMigrationPanel.test.tsx`: papéis, estados e ações.
- `docs/implementation/jrc-platform-v2/phase-9-report.md`: evidências, operação e rollback.

## Task 1 — consolidar o snapshot com rastreabilidade

**Produz:** árvore com as mudanças posteriores à migration 0025, sem `node_modules`, `dist`, segredos ou manifestos históricos conflitantes.

1. Gerar inventário comparativo entre a branch e `BROKER_JRC_COMPLETO_ESTADO_ATUAL_20260922.zip`.
2. Escrever teste de baseline que reconheça as migrations 0026–0029 e um único manifesto autoritativo; executá-lo e observar RED.
3. Aplicar somente arquivos fonte/documentação do snapshot, preservando arquivos que existam apenas na branch.
4. Restaurar `upstream/evolution-api/LICENSE`, `NOTICE` e `TRADEMARKS.md` a partir do upstream já fixado.
5. Arquivar o manifesto antigo em `docs/reference` e gerar o manifesto atual sem incluir a si próprio.
6. Executar:
   - `npm ci`
   - `npm run test:baseline`
   - `npm run test:evolution-upstream`
   - `git diff --check`
7. Commit: `chore: consolidate phase 9 source snapshot`.

## Task 2 — fechar o schema expand-and-contract

**Produz:** migration 0029 segura, idempotente no nível do migrator e isolada por tenant.

1. Criar testes de integração RED para:
   - aplicar 0001–0028 e depois 0029;
   - aplicar a cadeia completa em banco vazio;
   - RLS bidirecional para duas organizações;
   - constraints de status e owner transition;
   - grants mínimos para `jrc_app`;
   - descoberta sem expor conteúdo entre tenants.
2. Revisar 0029 e o journal para satisfazer os testes.
3. Atualizar `schema-status.test.ts` para a contagem e os hashes corretos.
4. Executar `npm run build && npm run test:integration`.
5. Commit: `feat(db): finalize legacy flow migration schema`.

## Task 3 — provar conversão idempotente e reconciliação

**Produz:** serviço de migração legada testado.

1. Criar testes RED cobrindo:
   - checksum estável independente da ordem de chaves;
   - preservação de ID, nome, draft, versões e versão ativa;
   - segunda execução sem duplicação;
   - alteração de origem produz conflito;
   - nó incompatível resulta em `LEGACY` e relatório;
   - checksum source/target e contagem por tenant;
   - lote máximo e isolamento entre organizações.
2. Dividir o arquivo se necessário em conversor, repositório e coordenador para manter responsabilidades claras.
3. Implementar o mínimo para tornar os testes verdes.
4. Executar o teste focal e `npm run typecheck`.
5. Commit: `feat(automations): reconcile legacy flows into JRC runtime`.

## Task 4 — garantir owner único, drain e rollback

**Produz:** transições atômicas sem duplo bot.

1. Criar testes RED em PostgreSQL real para:
   - execução viva mantém owner legado e retorna `WAITING_FOR_DRAIN`;
   - cutover depois do drain ativa um binding e troca owner na mesma transação;
   - conflito de owner não altera canal;
   - chamadas concorrentes não criam dois bindings ativos;
   - rollback é recusado com execução v2 viva;
   - rollback seguro restaura owner legado e desativa binding;
   - toda transição registra ator, motivo e timestamp.
2. Implementar locks, constraints/índice parcial e transações necessários.
3. Executar testes focais e `npm run test:integration`.
4. Commit: `feat(automations): enforce single owner cutover and rollback`.

## Task 5 — concluir CLI, API e autorização

**Produz:** operação repetível por lote e endpoints tenant seguros.

1. Criar testes RED para CLI com paginação real por cursor; mais de 200 flows devem concluir em múltiplos lotes.
2. Testar retomada após falha, logs sanitizados e código de saída.
3. Testar HTTP para OWNER/ADMIN, negar VIEWER, exigir idempotency key em mutações e impedir tenant cruzado.
4. Corrigir o comando para não processar apenas o primeiro lote.
5. Registrar auditoria em migrate, cutover e rollback.
6. Executar testes focais e `npm run typecheck`.
7. Commit: `feat(api): expose controlled legacy migration operations`.

## Task 6 — atualizar contrato OpenAPI

**Produz:** contrato gerado e inventário de segurança coerentes.

1. Atualizar primeiro os testes esperados com as quatro operações de migração.
2. Executar o teste OpenAPI e observar RED pelo artefato antigo.
3. Executar build e `npm run openapi:generate`.
4. Revisar schemas, autenticação, idempotência, respostas de conflito e ausência de operações internas do provider.
5. Executar:
   - `vitest run apps/api/tests/http/openapi.test.ts`
   - `npm run security:contracts`
6. Commit: `docs(api): publish legacy migration contract`.

## Task 7 — oferecer operação segura na interface

**Produz:** painel de migração no Automation Studio JRC.

1. Criar testes de interface RED para estados `CONVERTED`, `WAITING_FOR_DRAIN`, `MANAGED`, `LEGACY`, `CONFLICT` e `ROLLED_BACK`.
2. Exibir checksum, versões, bindings, execuções vivas e erros de conversão.
3. Permitir cutover/rollback somente a papéis autorizados, com confirmação contextual e resultado acessível.
4. Não esconder flows incompatíveis e não oferecer ativação insegura.
5. Executar `npm run test:web && npm run build:web`.
6. Commit: `feat(web): add legacy migration control panel`.

## Task 8 — tornar auditoria e pacote reproduzíveis

**Produz:** artefatos verificáveis no Git e no ZIP.

1. Criar teste RED que gere o hash de fonte tanto em checkout Git quanto em diretório empacotado com manifesto.
2. Adaptar `generate-security-audit.mjs` para usar Git quando presente e manifesto verificado quando ausente.
3. Regerar e verificar relatório/PDF sem incorporar segredo ou timestamp instável.
4. Executar:
   - `vitest run tests/security-audit-artifacts.test.mjs tests/security-audit-pdf-verification.test.mjs`
   - `npm run security:audit:verify-pdf`
5. Commit: `fix(audit): support reproducible packaged source verification`.

## Task 9 — relatório, matriz de aceite e gate completo

**Produz:** Fase 9 encerrada e pronta para iniciar segurança/Fase 10.

1. Escrever `phase-9-report.md` com código implementado, testes locais, integrações não homologadas, operação, rollback e riscos.
2. Executar com Node 24.19.0:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
   - `npm test`
   - `npm run test:integration`
   - `npm run test:e2e`
   - `npm run security:contracts`
   - `npm run security:notices`
   - `npm audit --audit-level=high`
   - build e smoke da imagem Docker.
3. Validar migration sobre cópia sanitizada de uma base 0028.
4. Confirmar árvore limpa, manifesto único e OpenAPI sem diff.
5. Commit: `docs: close JRC Platform V2 phase 9`.

## Interfaces entre tarefas

- Task 1 fornece a árvore 0026–0029 consumida pelas demais.
- Task 2 fixa o schema usado por Tasks 3–5.
- Task 3 fornece o serviço chamado por Tasks 4–5.
- Task 5 define rotas consumidas por Tasks 6–7.
- Task 8 define o empacotamento verificado por Task 9.

## Revisão final

Revisar deliberadamente: concorrência de cutover, execução viva, paginação de lotes, tenant cruzado, falsificação de owner, rollback parcial, divergência de checksum, pacote sem `.git` e vazamento de segredo em relatório.
