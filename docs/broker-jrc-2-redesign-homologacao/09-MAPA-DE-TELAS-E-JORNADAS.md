# 09 — Mapa de telas e jornadas

Inventário estático do router e páginas em 30/10/2026. “Existente” significa encontrado no código do checkout auditado; não valida entrega em produção. Caminhos abaixo são rotas do produto, não URLs acessadas nesta auditoria.

## Telas reais da empresa

| Área | Rotas | Arquivos e responsabilidade |
|---|---|---|
| Sessão | `/login`, `/selecionar-organizacao`, `/` | `pages/Login.tsx`, `OrganizationSelect.tsx`, `auth/guards.tsx`; home autenticada redireciona a canais. |
| Visão geral | `/dashboard` | `pages/Dashboard.tsx`, `broker/use-overview.ts`; resumo por organização. |
| Canais | `/channels`, `/channels/new`, `/channels/:id` | `Channels.tsx`, `NewChannel.tsx`, `ChannelDetail.tsx`; conexão, cadastro, destino e automação. |
| Meta | `/channels/meta/connect` | `MetaConnect.tsx`; autorização oficial e ativos. |
| Mensageria | `/mensagens` | `Messaging.tsx`, `ConversationFacts.tsx`, `QrDispatchAttempts.tsx`, `QrOutboundObservations.tsx`, `attendance/LocalAttendancePanel.tsx`; não é apenas contador. |
| Integrações | `/integracoes` | `Integrations.tsx`, `integrations/ChatwootPanel.tsx`; central/destinos/conta/vínculos/jobs. Inclui onboarding, controle, embed e diagnóstico conforme capability. |
| Automações | `/automations`, `/automations/new`, `/automations/:id/edit`, `/automations/:id/editor`, `/automations/:id/versions`, `/automations/:id/executions` | `AutomationStudio.tsx`, `NewAutomation.tsx`, `flows/FlowCanvas.tsx`, `automations/node-editors/*`; draft, validação, versão e execução. |
| Execuções | `/automation-executions`, `/automation-executions/:id` | Exports de `AutomationStudio.tsx`; diagnóstico e tratamento conforme autorização. |
| Credenciais | `/credentials` | `pages/Credentials.tsx`, formulários de política HTTP/IA; segredo e metadados separados conforme fluxo. |
| Saúde | `/operations/health` | `OperationalHealth.tsx`; agregação de sinais por tenant. |
| Relatórios/regras | `/relatorios`, `/brain` | `Operations.tsx`; agregados por período e orientação por regras. |
| Uso/empresa | `/uso-custos`, `/minha-empresa` | `Usage.tsx`, `Company.tsx`; limites e estado efetivos. |
| Provisionamento | `/provisionamento` | `Provisioning.tsx`; criação/importação assistida. |
| Integração API | `/api-webhooks`, `/chaves-api` | `ApiWebhooks.tsx`, `ApiKeys.tsx`; documentação/modos e credenciais por escopo. |
| Ajuda/configuração | `/suporte`, `/configuracoes` | `Support.tsx`, `support/SupportDesk.tsx`, `Settings.tsx`. |
| Autorização embed | `/embed/authorize` e bundle `embed/main.tsx` | `embed/AuthorizePage.tsx`, `EmbedPage.tsx`; sessão/política própria. Não reutilizar autenticação staff. |

Compatibilidade encontrada: `/providers` redireciona a canais; `/conexoes` e variantes redirecionam a canais; `/whatsapp-oficial` redireciona a Meta; `/flows` e `/legacy/flows` usam compatibility route; `/legacy/providers` e `/legacy/conexoes*` preservam telas antigas. Não contar redirects como funcionalidades novas.

## Telas reais da plataforma

`/jrc/*` é tratado por `pages/Platform.tsx`, com sessão staff independente. Sete entradas estão em `layout/navigation.ts`: dashboard, grupos econômicos, empresas, usuários, planos, monitoramento e suporte. `platform/CompanyWorkspace.tsx` concentra detalhes de empresa; `CompanyChannels.tsx`, `CommercialPlans.tsx`, `EconomicGroups.tsx`, `CompanyDeletion.tsx`, `GroupCompanyRemoval.tsx`, `PasswordResetDialog.tsx` e `SupportDesk.tsx` implementam superfícies específicas. Há confirmação/motivo para ações sensíveis; o piloto de saúde não deve atravessar essa fronteira.

## Jornadas prioritárias

| Jornada | Percurso atual e intenção | Evidência de sucesso exigida | Lacuna/limite |
|---|---|---|---|
| J1 Entrar na empresa certa | Login → seleção, se necessária → canais → contexto/papel no topo. | Organização correta, resposta antiga descartada e ações coerentes com papel. | Sidebar não é autorização. Verificar servidor para ação direta. |
| J2 Preparar QR | Novo canal QR → conectar/parear → confirmar identidade → destino humano/Flow conforme operação. | Estado da sessão, número confirmado e binding corretos. | CONNECTED não comprova transporte nem entrega à central. |
| J3 Integrar central | Integrações → conta/destino aprovado → inbox/conexão → callback → entrada e resposta pública. | Evidências de callback, inbound/outbound, identidade e status em `ConnectionHealthSummary`. | Não executar mensagem real só para criar evidência de UX. |
| J4 Diagnosticar falha | Saúde → camada/alerta → Integrações → diagnóstico de todas as entregas → evidência do job. | Entidade, código, quantidade, intervalo e próxima ação compreendidos. | Histórico FAILED não é incidente ativo; UNKNOWN exige conferência, não reenvio. |
| J5 Criar automação | Lista → novo/draft → editor → validar → versão → vincular canal → execuções. | Versão/vínculo corretos e resultado observado; capability disponível. | Edição/publicação não prova execução externa. |
| J6 Atender/reassumir | Conversas → fatos/atendimento → ação conforme papel e ownership. | Ownership/revisão e outcome conhecidos. | Não duplicar comando com resultado incerto. |
| J7 Integrar parceiro | API e webhooks → contrato/modo → chave com escopos mínimos → evidência técnica. | Tenant, escopos, evento e ACK conforme contrato. | Cinco rotas da fase anterior existem no canonical sem UI dedicada; não prometer central de replay/custódia pronta. |
| J8 Suporte JRC | Plataforma → empresa → monitor/canais/integração → motivo e diagnóstico. | Empresa selecionada e trilha autorizada; nenhum conteúdo sensível no relatório de UX. | SUPER_ADMIN e SUPPORT possuem diferentes ações; inspeção não concede impersonação. |

## Piloto J4: cenário de aceitação

Dados sintéticos: API/banco/Redis e heartbeats UP; CHATWOOT configurado; 12 jobs FAILED; 2 UNKNOWN; nenhuma prova recente de conversa. A tela deve permitir entender que infraestrutura responde, mas há registros de entrega a investigar. Deve mostrar que os números são de `integration_jobs` no histórico, oferecer a página de integração, conservar UNKNOWN distinto e não exibir “tudo saudável”. Números são exemplos de teste, não números produtivos.

Outro cenário: somente provider Meta sem canais; estado UNKNOWN. A tela mostra ausência de observação/configuração segundo código do backend, sem afirmar falha do WhatsApp oficial. Outro: API indisponível após leitura válida; apresentar dado anterior como desatualizado ou retirá-lo, sem manter selo de atualidade.

## Matriz de perfis para o piloto

OWNER/ADMIN/OPERATOR/VIEWER com vínculo atual podem consultar `/v1/operations/health` pelo guard de membership JWT. Gestão de integração exige OWNER/ADMIN, mas leitura de diagnóstico usa membership. Rota staff possui outro namespace/session. O piloto só navega e consulta: não amplia scopes, papéis, grants, replay ou ações operacionais. Testar VIEWER e troca de organização é obrigatório para não transformar conveniência de descoberta em vazamento de contexto.

## Cobertura encontrada

Há testes locais de sessão, navegação, páginas de canais, integração, diagnósticos, editor e lifecycle; testes e2e incluem `console.spec.ts`, `broker-journeys.spec.ts`, `chatwoot.spec.ts`, `chatwoot-embed*.spec.ts`, `automation-editor.spec.ts`, `platform.spec.ts`, `messaging.spec.ts` e `support.spec.ts`. Este inventário não executou essas suítes nem presume que reproduzem ambientes de clientes.
