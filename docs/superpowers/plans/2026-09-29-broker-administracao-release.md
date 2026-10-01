# Broker — administração, canais e release — plano de implementação

> **Para execução por agentes:** usar `superpowers:subagent-driven-development` ou `superpowers:executing-plans`. Reutilizar funcionalidades existentes, corrigir com teste de regressão e revisar cada tarefa.

**Objetivo:** concluir a gestão comercial/administrativa e provar o Broker operacional antes dos módulos externos.
**Arquitetura:** portais tenant/plataforma, roles e serviços existentes; lifecycle persistente para exclusões; central mantém seus ativos; release imutável com evidência por jornada.
**Stack:** TypeScript/React, PostgreSQL/RLS, Redis, Vitest/Playwright, Docker/GitHub Actions/Dokploy.
**Spec:** [Escopo](../specs/2026-09-29-broker-first-completion-design.md).
**Programa:** [Plano principal](2026-09-29-broker-first-completion.md).

## Restrições globais

- Não apagar automaticamente Account, Inbox, histórico remoto ou WABA ao excluir no Broker.
- Cada nova alteração deve verificar papel atual e empresa/caixa.
- Não há deploy de produção ou exclusão de recursos reais como parte da execução de testes.
- Nenhum segredo, payload de cliente, telefone real ou estado de autenticação entra em Git.
- Grupo econômico não concede acesso cruzado nem faturamento consolidado.
- Módulos Flow/QR no host começam depois de BROKER_READY; QR no console Broker faz parte desta etapa.

## Foco da revisão

Associação ao grupo durante exclusão (A1/A2); usuário compartilhado entre empresas (A2/A3); downgrade concorrente com criação/envio (A4); callback/token alterado durante envio (A5); restore de banco com exclusões e sessões antigas (A7/A8). Cada caso tem aceite abaixo.

## A1 — grupos e organização das empresas

**Dependência:** B0. Criar/listar/associar já existem; não reimplementar paginação pronta.
**Modificar:** `packages/contracts/src/economic-groups.ts`, `apps/api/src/http/routes/platform.ts`, `apps/api/src/modules/platform/service.ts`, `apps/web/src/platform/{EconomicGroups,CompanyWorkspace}.tsx`.
**Testes:** ampliar `apps/api/tests/integration/platform.test.ts`, `apps/web/src/platform/EconomicGroups.test.tsx`, `apps/web/tests/e2e/platform.spec.ts`.
**Interface nova:** `updateEconomicGroup(actor, {id, name, expectedRevision, reason})`; `previewEconomicGroupRemoval(actor, id)` retorna revisão e empresas vinculadas; `removeEconomicGroup(actor, {id, expectedRevision, detachCompanies, reason})` remove só agrupamento/vínculos administrativos. Reutilizar tipo de ator da plataforma, sem autenticação no body.

- [ ] Testar criar Grupo JRC sintético com GoPure, Operadora e Construtora; renomear sem mudar IDs; mover/desagrupar empresa sem alterar Account/membership.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/platform.test.ts`; novos testes de rename/delete devem falhar antes da implementação.
- [ ] Implementar edição e exclusão do grupo vazio; com empresas, mostrar prévia e escolha explícita de preservar/desagrupar ou iniciar seleção de exclusão de empresas por A2. Nunca apagar empresas como efeito oculto da remoção do grupo.
- [ ] Serializar remoção versus associação; revisão antiga recusa. Alteração de grupo não transfere dados/credenciais nem concede acesso.
- [ ] Testar SUPPORT sem permissão de alterar grupo, mais de 200 registros e duas alterações concorrentes; corrigir documentação antiga que afirmava falta de paginação.
- [ ] Rodar UI/E2E e revisar/commit. Aceite: estrutura administrativa utilizável sem cadastrar JRC Conversas como empresa apenas para representar o produto.

## A2 — exclusão completa no Broker e dependências

**Dependência:** A1/R1/R4; o lifecycle de empresa/conexão já existe.
**Modificar:** `apps/api/src/modules/lifecycle/{service,purge-order}.ts`, `apps/api/src/commands/lifecycle-worker.ts`, rotas channels/platform, `apps/web/src/channels/ChannelDeletion.tsx`, `apps/web/src/platform/CompanyDeletion.tsx`.
**Criar:** `apps/api/src/modules/lifecycle/group-removal-service.ts` e `group-removal-repository.ts` para orquestrar seleção explícita de empresas; migration aditiva de operação agregada/filhos; `apps/web/tests/e2e/lifecycle.spec.ts`.
**Testes:** ampliar `apps/api/tests/integration/lifecycle-deletion.test.ts`, testes locais de service/purge-order e componentes de exclusão.
**Interface:** preservar preview/operation atuais; novo `requestGroupCompanyRemoval(actor, {groupId, expectedRevision, previewId, previewRevision, selectedCompanyIds, confirmation: {companies: [{id, typedName}], removeGroupIfEmpty}, reason, idempotencyKey})` valida confirmação contra snapshot autorizado e cria operações de empresa existentes. `getGroupCompanyRemoval(actor, operationId)` consulta resultado agregado durável. Não criar purge em cascata fora do worker dedicado.

- [ ] Testar empresa com bot, caixa, mensagens pendentes, recurso remoto legado e usuário compartilhado. Assert: outra empresa/usuário compartilhado permanece; ativos remotos preservados aparecem na prévia.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/lifecycle-deletion.test.ts`; reproduzir apenas lacunas demonstradas.
- [ ] Completar UX de impedimentos, inclusive FLOW_REMOTE_BOT_ATTACHED: identificar dependência e oferecer caminho autorizado de pausa/desvinculação. Não mandar o usuário executar SQL.
- [ ] Testar dois workers, lease vencido, revogação durante operação, timeout externo, UNKNOWN de envio e evento tardio. Falha não vira SUCCEEDED; retomar não repete limpeza já confirmada.
- [ ] Para seleção de empresas de um grupo, prévia lista cada empresa e impacto. Confirmação nominativa e revisão devem cobrir a lista. Estado parcial é visível; remover agrupamento apenas após reavaliar vínculos, sem tocar empresas não selecionadas.
- [ ] Persistir operação agregada com seleção original, snapshot, confirmação recebida, chave idempotente, ator, operação-filha única por empresa e etapa final do grupo. Retry/reload retoma os mesmos filhos. Rejeitar nome ausente/incorreto, seleção alterada e prévia obsoleta; não preencher a confirmação em nome do usuário consultando o banco.
- [ ] Testar reinício entre duas exclusões e empresa vinculada posteriormente: somente as selecionadas são processadas, a nova permanece. Remover o grupo somente se a opção confirmada exigir isso e ele ainda estiver vazio; com vínculos restantes, preservar grupo e informar impedimento da etapa final. A remoção padrão de grupo em A1 continua preservando todas as empresas.
- [ ] Testar purge de novos dados R1/R2/R5 e todas as referências/FKs adicionadas. Auditoria mínima de operação preserva identidade técnica/resultado conforme política existente; conteúdo de cliente não é duplicado no log.
- [ ] Rodar E2E com banco/provedor descartáveis, nunca cliente real; revisar/commit.

## A3 — suporte recebido, permissões e auditoria de operação

**Dependência:** B0; matriz transversal é repetida após A1/A2/A4.
**Modificar:** `packages/contracts/src/support.ts`, `apps/api/src/modules/support/service.ts`, `apps/api/src/http/routes/support.ts`, `apps/web/src/support/SupportDesk.tsx`, `apps/api/src/modules/platform/service.ts`.
**Testes existentes:** `apps/api/tests/integration/support-tickets.test.ts`, `apps/api/tests/http/{support,support-platform}.test.ts`, `apps/api/tests/unit/{support-policy,support-transaction}.test.ts`, `apps/web/src/support/SupportDesk.test.tsx`, `apps/web/tests/e2e/support.spec.ts`.
**Teste novo transversal:** `apps/api/tests/integration/admin-completion-isolation.test.ts`.
**Interface:** estender listagem de chamados com filtros status/company/assignee e cursor; resposta contém prazo/estado observado e revisão, sem criar cálculo paralelo ao serviço.

- [ ] Reexecutar jornada existente: empresa abre → equipe recebe/assume/responde → cliente acompanha/responde → reabre fila → resolve. Não listar isso como construção do zero.
- [ ] Escrever testes de filtros/paginação, primeira resposta vencida, duas respostas concorrentes e atualização após reconexão; rodar unit/HTTP e integração correspondente antes da alteração.
- [ ] Completar fila administrativa e aviso interno de atualização, preservando revisão/idempotência. Não exigir e-mail/WhatsApp/anexo para fechar a função interna; esses canais continuam extensão posterior.
- [ ] Auditar acesso administrativo e ações com ator/recurso/data/motivo quando aplicável, sem copiar corpo do chamado. Conteúdo segue purge da empresa; não criar retenção paralela oculta.
- [ ] Testar matriz de três empresas no mesmo grupo: usuário em duas não acessa terceira; VIEWER não escreve; SUPPORT atende chamado mas não altera plano/grupo/exclui; último OWNER protegido; sessão/API key tenant não vira plataforma.
- [ ] Revogação/suspensão com tela aberta vale na próxima operação sensível, inclusive suporte/Flow/relatórios; aplicar as políticas existentes, sem inventar outro RBAC.
- [ ] Rodar E2E suporte e integração transversal; revisar/commit.

## A4 — planos, concessões e limites comerciais consistentes

**Dependência:** B0; alinhar medições de IA/mídia com R7/A6.
**Modificar:** `apps/api/src/modules/platform/service.ts`, `apps/api/src/modules/tenancy/operational-limits.ts`, `apps/api/src/http/routes/platform.ts`, `apps/web/src/platform/{model,CompanyWorkspace}.tsx`, `apps/web/src/pages/Usage.tsx`.
**Criar:** `packages/contracts/src/commercial-plans.ts`, `apps/api/src/modules/commercial-plans/service.ts`, `apps/web/src/platform/CommercialPlans.tsx`, migration aditiva de versões/atribuição.
**Testes novos:** `apps/api/tests/integration/commercial-plans.test.ts`; ampliar `tenant-operational-limits.test.ts`, `platform.test.ts` e CompanyWorkspace.
**Interface:** `assignCommercialPlan(actor, {organizationId, planVersionId, overrides, expectedRevision, reason})` aplica valores explícitos e auditados ao enforcement existente. Preços não são inventados: catálogo administrativo permite manter os valores contratados; billing automático não faz parte desta tarefa.

- [ ] Testar migração de empresas com plano textual/limites individuais para configuração equivalente, preservando módulos e capacidade.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/commercial-plans.test.ts apps/api/tests/integration/tenant-operational-limits.test.ts`; registrar lacuna comercial, sem reescrever admissão concorrente já existente.
- [ ] Criar catálogo versionado e exceções por empresa; mostrar contratado/usado/disponível. Upgrade/downgrade não apaga recursos; limite menor bloqueia somente novas admissões excedentes.
- [ ] Definir e exibir unidades reais: conexões, usuários, mensagens aceitas por dia UTC, pendências, armazenamento e IA quando medidos. Aceita não significa entregue; estimativa de custo não é fatura.
- [ ] Testar criação/binding/importação/API concorrentes respeitando módulo/plano, suspensão e troca de concessão; grupo não compartilha quota automaticamente.
- [ ] Validar usos sem medição: mostrar indisponível, não zero. Rodar UI + integração e revisar/commit.

## A5 — canais QR/Meta e compatibilidade das centrais

**Dependência:** U4a, R1/R3 para transporte em M1; jornada completa depende de U4b/R4–R7 em M3. O aceite inicial de transporte não aguarda os blocos avançados.
**Modificar:** módulos existentes de canais/instâncias/meta-onboarding/integrações, `packages/providers/src/evolution/*`, `packages/providers/src/meta/*`, `apps/web/src/pages/{ChannelDetail,MetaConnect,Providers}.tsx`, conforme defeitos encontrados.
**Criar:** `docs/validation/broker-provider-capabilities.md`; para gestão de templates faltante, `apps/api/src/modules/meta-onboarding/templates-service.ts`, contrato e UI dedicados sob `apps/web/src/channels/`.
**Testes existentes:** `apps/api/tests/integration/meta-onboarding.test.ts`, `meta-template-idempotency.test.ts`, `channel-facade-isolation.test.ts`; testes providers Evolution/Meta/mídia. **Novos:** `apps/api/tests/integration/channel-operational-journey.test.ts`, `apps/web/tests/e2e/meta-templates.spec.ts`.
**Interface:** capacidades por conexão/destino retornam suporte e evidência para texto, mídia, templates, callback e atendimento. “Configurado”, “conectado” e “entrega verificada” são estados diferentes.

- [ ] Testar QR tardio/expirado, dupla solicitação, desconexão/reconexão, identidade diferente e recurso remoto indisponível; corrigir apenas o que falhar.
- [ ] Rodar suites providers e integração de canal. Verificar que telefone/token não aparece em logs/exportações; identidade no console segue a política de exibição existente.
- [ ] Para JRC e Chatwoot externo, provar criar/adotar API Inbox, credencial, membros, assinatura, anexos e ida/volta. Callback ocupado não é sobrescrito silenciosamente; conta remota de outra empresa não pode ser adotada.
- [ ] Para Meta, revisar documentação oficial vigente na implementação e manter versão Graph configurada. Cobrir onboarding/revogação, janela/eligibilidade do canal e templates; implementar UI de listar/criar/submeter/acompanhar status/rejeição quando prevista na oferta, com endpoints reais da versão adotada.
- [ ] Confirmar mídia/template no canal real, sem supor que ícone WhatsApp em uma caixa API equivale ao canal nativo. Não executar texto/template de teste em destinatário arbitrário.
- [ ] Registrar aceite separado QR/Meta/JRC/Chatwoot externo. App/WABA/token ausentes são bloqueios externos explícitos; não substituí-los por mocks e declarar completo.
- [ ] Revisar/commit das correções e registrar recursos necessários para homologação A8.

## A6 — relatórios, saúde, auditoria e retenção

**Dependência:** R8, A2/A3/A4.
**Modificar:** `apps/api/src/modules/observability/service.ts`, `apps/api/src/http/routes/observability.ts`, `apps/api/src/commands/lifecycle-worker.ts`, `apps/api/src/modules/platform/service.ts`, `apps/web/src/platform/{CompanyWorkspace,components}.tsx`.
**Criar:** `apps/api/src/modules/platform/reports.ts`, `apps/web/src/platform/OperationalReports.tsx`, `apps/api/tests/integration/platform-reports.test.ts`.
**Interface:** `getOperationalReport(actor, {organizationId, from, to, timezone, cursor})` retorna janela/unidade/denominador/observação; agregação de grupo só para papel administrativo, sem conteúdo das conversas.

- [ ] Testar intervalo vazio, fuso, paginação, limites de período e valor desconhecido; contagem cumulativa não é relatório por data.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/platform-reports.test.ts`; adicionar asserções de isolamento e ausência de dados pessoais/segredos.
- [ ] Exibir filas/idade/falhas/UNKNOWN, execução bot/humano, transferência pendente, suporte vencido e lifecycle ACTION_REQUIRED. Adicionar heartbeat do lifecycle-worker sem confundir running com sucesso.
- [ ] Implementar exportação autorizada e paginada com filtros explícitos; neutralizar fórmulas em CSV quando houver texto. Metadados de consulta são auditados.
- [ ] Documentar retenção técnica usando políticas existentes: purge de conteúdo por empresa, auditoria mínima sem corpo, backups com ciclo de retenção e tratamento de restauração. Não alegar exclusão imediata de cópias externas/backups.
- [ ] Atualizar `docs/operations/observability-alerts.md` e `saas-admin.md`, removendo limites antigos que o código já superou.
- [ ] Rodar relatórios, audit-redaction, audit-rls, readiness e UI; revisar/commit.

## A7 — CI, migrations, carga e recuperação

**Dependência:** tarefas de produto integradas em branch revisada.
**Modificar:** `.github/workflows/{ci,images}.yml`, `infra/dokploy/compose.yaml`, `infra/dokploy/.env.example`, `apps/api/src/db/{runtime-schema,schema-status}.ts`, journal/migrations novas, testes de upgrade.
**Criar:** `docs/validation/broker-first-verification.md`, `apps/api/tests/integration/standalone-attendance-journey.test.ts`.
**Interface:** relatório de evidência com commit, ambiente, comando, resultado, artefato e limitação. Nenhum teste histórico é marcado como executado agora.

- [ ] Escrever testes de banco vazio e upgrade da versão base, incluindo roles/RLS/FKs, dados novos no purge e sessões antigas. Migração aplicada não é editada; reservar números centralmente.
- [ ] Rodar `npm test`, `npm run typecheck`, `npm run build`, `npm run test:web:bundle`, `npm run test:compiled`, integração e E2E. Setup usa PostgreSQL/Redis isolados previstos na CI.
- [ ] Gerar OpenAPI e verificar diff; rodar contratos/licenças/submódulo/auditoria de dependências e segurança. Não suprimir falha de gate sem corrigir causa ou registrar limitação que bloqueia a release.
- [ ] Executar imagem real e restore drill. Recuperar backup em ambiente isolado, incluindo execuções pendentes, exclusões e chaves corretas. Verificar que restauração não reativa recurso excluído inadvertidamente; reconciliar registros de exclusão posteriores ao backup antes de abrir tráfego.
- [ ] Ensaiar carga sintética progressiva e múltiplos workers, com teto de recursos do laboratório: perda/duplicidade, p95, fila, justiça por empresa, reinício e drenagem. A capacidade anunciada não pode exceder o que foi medido; não declarar milhares de sessões por extrapolação.
- [ ] Testar voltar versão publicada e aplicação compatível com schema. Não desfazer migration destrutivamente nem reverter estado de atendimento sem política.
- [ ] Encerrar com `npm run ci:verify` no ambiente completo ou evidência equivalente da CI do mesmo commit; revisar diffs e corrigir inconsistências dos registros antigos sem apagar a evidência histórica.

## A8 — homologação externa e release do Broker

**Dependência:** implementações R1–R8/U1–U7/A1–A6 e testes internos A7 concluídos; ambiente/recurso de homologação autorizado. A8 produz as evidências externas que completam G01–G12, sem depender circularmente de sua aprovação anterior. Release de produção é tarefa específica posterior.
**Modificar:** `docs/operations/release-broker-product-20260929.md` como referência histórica; criar `docs/operations/broker-first-release.md`, `docs/validation/broker-first-acceptance.md`.
**Consumir:** jornada E2E U7, configurações/capacidades A5, serviços R1–R8 e relatório A7.
**Produzir:** matriz G01–G12 e decisão BROKER_READY ou pendências explícitas.

- [ ] Homologar pelo console Broker, sem módulo instalado no host: QR → caixa → menu → pergunta → time → humano → resposta WhatsApp → retorno/encerramento. Repetir na central JRC e Chatwoot externo escolhido, com versão/build registrados.
- [ ] Acrescentar dois contatos simultâneos, duas empresas, rede indisponível, webhook duplicado, nota privada, mídia, mudança de time, silêncio/horário, HTTP/IA e nova mensagem após resolução.
- [ ] Executar aceite Meta com App/WABA/credenciais de homologação quando o item estiver no escopo. Uma release provisória QR não encerra a pendência Meta nem autoriza anunciar canal oficial homologado.
- [ ] Registrar somente evidência saneada: IDs técnicos de teste, horários, correlação e resultado; sem copiar segredos/payloads privados para o repositório.
- [ ] Preparar release revisável: commit aprovado, workflow de imagens, digests API/WEB correspondentes, migrations, parâmetros novos não secretos, backup e roteiro de retorno.
- [ ] Implantar o candidato no ambiente de homologação autorizado, verificar schema por versão/hash, readiness/heartbeats e jornadas; `running` sozinho não conclui a validação. Nunca usar `latest`, digest inventado ou imagem anterior com Compose novo por conveniência.
- [ ] Encerrar matriz com resultado por capacidade; BROKER_READY exige todos os critérios do escopo aprovado. Mudança desse escopo requer decisão explícita, não omissão de teste.
- [ ] Só depois iniciar E1–E4 do plano principal. As telas embutidas não corrigem runtime incompleto.

**Promoção de produção posterior, fora do aceite A8:** quando houver tarefa de release autorizada, usar o candidato homologado, manter autodeploy desligado durante manutenção, validar Compose sem expandir segredos, confirmar backup, aplicar migration com imagem correta, iniciar stack preservando volumes e repetir as verificações após deploy. BROKER_READY é comprovado em homologação e não depende de executar essa promoção nesta entrega.

## Comandos disponíveis para os gates

```text
npm test
npm run typecheck
npm run build
npm run test:web:bundle
npm run test:integration
npm run test:e2e
npm run openapi:generate
npm run test:container
npm run test:restore-drill
npm run security:contracts
npm run security:notices
npm run security:submodule
npm run security:release
git diff --check --ignore-submodules
```

Os scripts adicionais e gates completos estão em package.json/CI. Variáveis de teste/auditoria devem ser provisionadas fora do Git. Falta de Docker, banco, credencial ou navegador é pré-requisito pendente, não sucesso. Não usar as senhas compartilhadas anteriormente como fixture.

## Regra de pronto administrativa

O administrador consegue reorganizar grupo, gerir empresa/acesso/plano, receber suporte, compreender saúde e concluir lifecycle pelo painel; ações são autorizadas e auditadas. O cliente entende quais dados foram removidos e quais ativos remotos continuam existindo. Nenhum desses requisitos depende da instalação dos futuros módulos.
