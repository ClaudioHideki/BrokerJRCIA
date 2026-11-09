# Configuração guiada multitenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execução direta pela raiz; uma revisão independente da implementação completa antes da publicação. A implementação, os testes e a implantação já foram aprovados pelo usuário em 09/11/2026.

**Goal:** Configurar empresas, QR/Meta, robôs portáteis, caixas JRC, atendentes, homologação e ativação por uma jornada durável e isolada por tenant.

**Architecture:** Coordenar os serviços atuais com uma operação durável, mantendo autenticação, catálogos e execução canônicos. Acrescentar pacote de grafos com dependências internas remapeadas e referências locais pendentes. Separar importação, publicação, homologação e ativação.

**Tech Stack:** Node 24.19.0, TypeScript strict, Fastify, PostgreSQL/RLS, React, Zod, Vitest e Playwright existentes; sem novo provedor ou motor.

**Spec:** [Desenho aprovado](../specs/2026-11-09-broker-configuracao-guiada-multitenant-design.md).

## Global Constraints

- Não escrever no GLPI real nem enviar avisos/pesquisas durante o piloto.
- Broker compartilhado; piloto restrito à caixa de homologação da Branef. Preservar os demais clientes, vínculos, volumes, agentes e fluxos ativos.
- Não copiar credenciais entre empresas nem guardar tokens, QR, senhas ou conteúdo de conversa em documentos, fixtures ou estado durável do assistente.
- Importação permanece como rascunho; publicação não ativa atendimento. Dependências, referências locais e revisões são conferidas no servidor.
- Reutilizar exclusividade do executor, prioridade humana, idempotência e reconciliação existentes. I/O remoto fora de transações.
- Preservar formatos anteriores e versões imutáveis; migrações aditivas.
- QR e Meta têm provas físicas separadas. Meta física permanece pendente sem rota autorizada.
- Reutilizar o worktree isolado atual. Executar `npm test` e `git diff --check` antes de cada commit; nunca adicionar `tmp/` ou arquivos de clientes.

## Review Focus

- Trocar empresa com upload ou consulta em andamento: descartar arquivo, resposta e intenção de gravação do contexto anterior (tarefas 1, 5).
- Dois IDs numéricos iguais em contas JRC distintas: o contexto completo precisa ser conferido antes de selecionar agente ou ativar (tarefas 3, 4, 6).
- Mesmo subfluxo em duas versões: preservar as versões semanticamente distintas ao importar, sem resolver por nome (tarefas 1, 2).
- Timeout depois de caixa/vínculo/publicação criados: retomar a mesma operação sem duplicar nem promover resultado desconhecido a sucesso (tarefas 2, 3, 4).
- Prova física anterior com número/token/caixa/robô alterado: invalidar a prova e bloquear ativação até nova homologação (tarefas 4, 6).

## Mapa de arquivos e responsabilidades

- `packages/contracts/src/automation-package.ts`: pacote portátil, requisitos tipados e limites; exportar por `index.ts`.
- `apps/api/src/modules/automation-integrations/portable-package.ts`: conversão pura, dependências, remoção de referências locais e correspondências internas.
- `apps/api/src/modules/automation-integrations/package-service.ts`: importação atômica/idempotente, exportação autorizada e publicação retomável via serviço nativo.
- `apps/api/src/http/routes/automation-packages.ts` e `apps/api/src/app.ts`: acesso JWT OWNER/ADMIN e montagem da API.
- `packages/contracts/src/guided-setup.ts`: entrada, progresso, revisões e pendências públicas.
- `apps/api/drizzle/migrations/0085_guided_setup.sql`: operações e evidências privadas por organização, com RLS e índices; incluir registro de migração pelo mecanismo atual.
- `apps/api/src/modules/guided-setup/{repository,service,readiness,proof}.ts`: persistência/CAS, coordenação, leitura autoritativa e prova delimitada.
- `apps/api/src/http/routes/guided-setup.ts`: endpoints de operação, diagnóstico e ações explícitas.
- `apps/web/src/guided-setup/{GuidedSetupPage,SetupSteps,PackageImport,SetupReview}.tsx`: jornada e componentes focados; clientes tipados em `api.ts`.
- `apps/web/src/app/App.tsx`, `pages/Channels.tsx`, `pages/Integrations.tsx`: entradas no assistente; telas avançadas preservadas.
- Testes unitários, HTTP, integração e UI nos diretórios atuais; documentação operacional em `docs/operations/guided-setup.md`.

## Task 1: Pacote portátil e pendências de referências locais

**Files:** contratos e `portable-package.ts`; testes `packages/contracts/tests/automation-package.test.ts`, `apps/api/tests/unit/automation-portable-package.test.ts`.

**Interfaces:** `AutomationPackageSchema` e `AutomationPackage` com formato `jrc-broker-package/1`, `rootKey`, `flows[{key,name,graph}]`; chaves lógicas referem entradas do próprio pacote. `preparePortablePackage(input:unknown, allocateId:()=>string): PreparedPackage` retorna grafos com IDs novos, ordem de dependências e requisitos `{flowKey,nodeId,kind,fields}`. Nenhuma função acessa banco ou rede.

- [ ] RED: `remaps_shared_dependencies_without_cross_tenant_references` — importar raiz com dois usos da mesma dependência gera uma definição nova, mantém arestas e reescreve as duas chamadas para o mesmo destino. Duas versões da mesma origem recebem chaves/definições distintas.
- [ ] RED: `requires_local_credentials_handoff_channel_domain_media` — remover somente os campos executáveis de referências conhecidas; preservar texto e objetos de negócio; retornar pendências por nó. Incluir todos os tipos nativos HTTP/SQL/IA, handoff v1/v2, ações de conversa/mídia e comandos de domínio.
- [ ] RED: `rejects_cycles_missing_dependencies_unknown_format_and_limits` — testar profundidade 8, 32 versões únicas e 2 MiB agregados conforme constantes do motor; limites da entrada e duplicação de chaves.
- [ ] Executar os dois arquivos e confirmar falhas funcionais antes da implementação.
- [ ] Implementar esquema, percurso limitado, correspondências e requisitos. Referência ausente permanece bloqueada; não tornar legados executáveis por fallback.
- [ ] GREEN: executar testes novos e testes existentes de importação/credenciais/ações/subfluxos. Conferir zero chamadas externas durante conversão.

## Task 2: Importar, exportar e publicar o pacote com isolamento

**Files:** `package-service.ts`, `automation-packages.ts`, `app.ts`; testes unitário/HTTP e `apps/api/tests/integration/automation-package-persistence.test.ts`.

**Interfaces:** `createAutomationPackageService({transact,repository,automations})` oferece `preview(org,input)`, `import(org,input,key)`, `export(org,automationId,version)` e `publish(org,packageId,expectedRevision,key)`. Reutiliza `AutomationService.create/save/publish` e `AutomationRepository` para as operações que lhes cabem; a importação de múltiplos rascunhos ocorre numa transação. Endpoints `/v1/automation-packages/preview`, `/v1/automation-packages`, `/v1/automation-packages/:id`, `/v1/automation-packages/:id/publish`, `/v1/automations/:id/package?version=N`.

- [ ] RED: importar atomicamente em dois tenants com identidade e catálogos distintos; replay devolve os mesmos IDs, conteúdo diferente com mesma chave conflita e falha de gravação não deixa rascunhos parciais.
- [ ] RED: exportação fecha dependências acessíveis da versão solicitada; dependência de outro tenant não é exportada; arquivo não contém credenciais ou destinos executáveis da origem.
- [ ] RED: publicação resolve pendências por versão/revisão, publica filhos antes da raiz e falha sem vínculo ativo. Interromper após um filho e retomar conserva a versão já confirmada.
- [ ] Executar novos testes e confirmar RED.
- [ ] Implementar persistência do manifesto/progresso e referências tipadas na migração aditiva da tarefa 3, junto aos rascunhos atuais; manter originais no cofre/import-artifact existente quando aplicável. Publicação usa serviços canônicos e reconcilia versão/checksum após resposta incerta.
- [ ] GREEN: testes unitários/HTTP, depois persistência real em banco isolado com RLS. O cliente escolhe recursos locais no Flow; o assistente lista os nós pendentes e abre esse editor.

## Task 3: Operação durável e coordenação de QR, Meta, destino, caixa e agentes

**Files:** `guided-setup.ts` nos contratos, migração `0085_guided_setup.sql`, repositório/serviço e rotas; conectar em `app.ts` e verificação de schema; testes unitários/HTTP/integração.

**Interfaces:** `createGuidedSetupService({transact,ports})` oferece `list(org)`, `start(principal,input,key)`, `get(principal,id)`, `update(principal,id,{revision,selection},key)` e `cancel(principal,id,{revision},key)`. `SetupSelection` contém IDs/revisões não secretos de conexão/integração/fluxo/versão/destino humano. `ports` reutiliza destinos, canais, Meta, onboarding QR, catálogo de atendimento e serviço de automação; nenhum adaptador assume organização fornecida pelo corpo.

- [ ] RED: somente OWNER/ADMIN da empresa atual pode criar/consultar/alterar a operação; mesmo ID em outro tenant resulta em não encontrado. CRUD com revisão esperada e chave idempotente.
- [ ] RED: recarga recupera progresso; mudança de seleção invalida conferência/prova; estado desconhecido exige reconciliação antes de nova solicitação equivalente. Cancelamento preserva recursos.
- [ ] RED: QR novo/existente e Meta novo/existente usam os serviços atuais; associação de caixa e de agentes usa instalação/conta/caixa e leitura de retorno, inclusive IDs externos colidentes.
- [ ] Executar novos testes e confirmar RED.
- [ ] Implementar contratos, migração/RLS, persistência e coordenação por etapas. Campo protegido de credenciais continua no serviço/painel atual, nunca no JSON de progresso. Interface expõe ações retomáveis ou tela existente com retorno ao assistente.
- [ ] GREEN: testes unitários/HTTP; migração e RLS em banco isolado; regressões de onboarding QR, Meta e controle Chatwoot.

## Task 4: Conferência autoritativa, homologação delimitada e ativação

**Files:** `readiness.ts`, `proof.ts`, serviço e rotas do assistente; usar `automations/service.ts` e `attendance/transition.ts` sem criar outro executor.

**Interfaces:** `readSetupReadiness(principal,setup): Promise<SetupReadiness>` retorna checks tipados e fingerprint das revisões relevantes. `readSetupProof(principal,setup,executionId): Promise<SetupProof>` confere uma execução nativa e seus recibos/controle humano no escopo selecionado, sem confiar em checkbox de sucesso. `beginTest` e `activate` no serviço recebem revisão/CAS, chave idempotente e confirmação explícita de troca de vínculo quando já houver dono.

- [ ] RED: provedor conectado sem caixa ou robô não é pronto; versão publicada com referência não resolvida não ativa; agentes fora da caixa e destino revogado bloqueiam.
- [ ] RED: homologação exige entrada exclusiva e caixa autorizada; mantém dono único e registra vínculo anterior. A prova exige entrada, saída confirmada, transferência e pausa humana no mesmo contexto.
- [ ] RED: corpo do cliente com provas inventadas, execução de outro tenant, recibo desconhecido, número/credencial/versão/revisão alterados não liberam ativação.
- [ ] RED: interrupção depois da troca de vínculo retorna resultado a conferir; reconsulta vínculo/revisão antes de repetir. Concorrência ou atendimento humano não são sobrescritos pelo guia.
- [ ] Executar os novos testes e confirmar RED.
- [ ] Implementar leitura e ações sobre as APIs/serviços atuais. Separar prova simulada de física, registrar evidência mínima e auditar ativação/desativação sem texto de conversa.
- [ ] GREEN: testes e integração QR/Meta com adaptadores isolados comprovam resposta única e transferência/pausa.

## Task 5: Assistente completo no console

**Files:** novos componentes `apps/web/src/guided-setup/`, `App.tsx`, `Channels.tsx`, `Integrations.tsx`; testes UI correspondentes.

**Interfaces:** `GuidedSetupPage` usa sessão/tenantRevision e API tipada; URL `/configuracao-guiada` e `/configuracao-guiada/:id`. Passos exibem empresa/destino, transporte, caixa/agentes, robô/correspondências, conferência/teste/ativação. Importação suporta pacote novo e encaminha JSON antigo ao conversor atual com suas pendências.

- [ ] RED: percorrer as duas jornadas QR e Meta, retomar operação salva e apresentar uma ação concreta para cada pendência. Selecionar recursos por nome/contexto, sem exigir copiar UUID.
- [ ] RED: troca de empresa durante upload/consulta limpa arquivo e intenções; resposta antiga não salva, não publica e não ativa no novo tenant. Botão desabilitado durante ação incerta impede duplicação.
- [ ] RED: importação com subfluxos mostra o conjunto; pendências abrem o nó no Flow; publicação e ativação têm ações distintas; sucesso técnico não vira selo de prova física.
- [ ] Executar os testes novos e confirmar RED.
- [ ] Implementar componentes acessíveis reutilizando painéis de destino/QR/Meta/atendentes e editor atual. Não embutir segredos no estado persistido. Adicionar links de entrada nas telas atuais, preservando as antigas.
- [ ] GREEN: testes UI e build/typecheck; conferir visualmente em navegador isolado os estados vazio, retomada, bloqueio e pronto, em desktop e largura estreita.

## Task 6: Regressão completa, revisão e documentação operacional

**Files:** testes integração/E2E do assistente, `docs/operations/guided-setup.md`, artefatos públicos de validação sem segredos.

- [ ] Exercitar duas empresas isoladas com colisão de IDs externos, pacote compartilhado importado duas vezes e ambos os adaptadores QR/Meta. Conferir trilha entrada/resposta/handoff/pausa e ausência de duplicações/contaminação.
- [ ] Cobrir concorrência, revogação, resultados desconhecidos e troca de tenant durante cada mutação relevante.
- [ ] Executar `npm test`, build/typecheck, integração, E2E, schema/migração, contratos e gates existentes. Docker local indisponível: usar CI isolado sem mudar o servidor de clientes para testar.
- [ ] Fazer revisão independente completa conforme skill de revisão, corrigir achados com RED/GREEN e registrar limites. `git diff --check` sem erros; commitar somente arquivos autorizados após gates obrigatórios.
- [ ] Documentar campos e procedimento repetível, reconciliação, formatos suportados, limites, desativação e retorno de vínculo. Atualizar OpenAPI pelo gerador existente.

## Task 7: Release aprovado e piloto Branef

- [ ] Preservar a base de código implantada e verificar imagem/compose antes de publicar. Pipeline do SHA final precisa passar, registrar digests imutáveis API/WEB e artefatos do editor quando afetados.
- [ ] Implantar imagem compartilhada com exposição inicial controlada, migração aditiva e verificação de saúde/SHA. Não alterar configurações dos demais tenants. Não copiar ENV completo ou credenciais.
- [ ] Recuperar sessão autenticada da empresa Branef; importar/publicar/vincular pelo assistente, usando a caixa de teste e a palavra exclusiva já autorizadas. Manter GLPI real sem escritas e notificações desligadas.
- [ ] Pedir ao usuário somente a mensagem física necessária e conferir resposta, navegação e transferência/pausa na caixa correta. Não declarar teste Meta físico concluído sem número autorizado e evidência independente.
- [ ] Entregar relatório com versões/digests, como cadastrar nova empresa, como importar/vincular/testar/ativar e pendências reais. Separar fonte/CI/runtime/canal físico.

## Verificação do plano

As tarefas 1–2 cobrem pacote e compatibilidade, 3 cobre coordenação e retomada, 4 cobre autoridade/prova/ativação, 5 cobre a jornada visível e 6–7 cobrem regressão, rollout e evidência. As cinco classes do Review Focus têm testes explícitos nas tarefas donas. A aprovação do desenho e da execução já foi recebida; este plano detalha esse trabalho e não adiciona outra autorização de implantação.
