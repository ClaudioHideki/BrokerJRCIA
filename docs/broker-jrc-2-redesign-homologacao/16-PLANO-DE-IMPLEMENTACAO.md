# Broker JRC2.0 — plano de implementação

> Executores: usar execução incremental com testes antes do código e revisão final. Não publicar automaticamente.

**Objetivo:** fechar bloqueadores internos e modernizar o console por módulos verificáveis.
**Arquitetura:** preservar Fastify/PostgreSQL como fonte durável, Redis como auxiliar, Evolution privada e Meta como provedor separado. Frontend React existente consome os contratos públicos sem lógica de envio duplicada.
**Stack:** TypeScript, Fastify, Drizzle, PostgreSQL, Redis, React19, Vite, @jrc/ui, Vitest, Playwright.
**Especificação:** missão do usuário30/10/2026; decisões do piloto em10-PLANO-REDESIGN-FRONTEND.md.

## Restrições globais

Preservar APIs/permissões/RLS/dados/versão estável. Não fazer deploy, merge main, replay indiscriminado ou carga de produção. Não excluir mídia com base em HTTP200/ACK declaratório. Não declarar capacidade por configuração. Falta de recursos locais será registrada, sem usar dados produtivos como fixtures.

## Revisão prioritária

1. UNKNOWN antigo continua incerto mesmo após outros sucessos.
2. Troca de empresa/unmount durante HTTP não pode mostrar resposta anterior.
3. Falha de refresh não pode parecer estado atual saudável.
4. Catálogo vencido/grupo não selecionado não autoriza reativação/replay.
5. Rollback de binário sobre schema77 precisa ensaio, não só /ready.

## Incremento A — diagnóstico operacional (piloto)

Arquivos: `apps/web/src/pages/OperationalHealth.tsx`, novo`apps/web/src/operations/health-model.ts`, `health-model.test.ts`, `apps/web/src/pages/OperationalHealth.test.tsx`, stylesheet próprio e tokens`packages/ui/src/tokens.ts`. Consome GET /v1/operations/health existente, sem ampliar permissões.

- [x] Ler rota, serviço, página, tokens e baseline unit de observabilidade (6pass).
- [x] Teste RED: estado apresentado com infraestrutura separada e histórico explicado; UNKNOWN sem ação de reenviar.
- [x] Teste RED: refresh falho marca dados anteriores; requests não sobrepostos; troca de cliente ignora resposta antiga.
- [x] Implementar modelo de apresentação e página com grupos, status, fontes e ações locais seguras.
- [x] Implementar tokens claro/escuro e comportamento responsivo, sem biblioteca nova.
- [x] Rodar unit/frontend/axe, typecheck, build e regressão; capturar desktop/mobile local com fixture marcada. Resultados e limitações em evidencias/RESULTADOS.md.
- [x] Revisar diff, contratos/segurança e relatar limites; dois P2 corrigidos na revisão.
- [ ] Encerrar gate da regressão geral: quatro testes TLS dependem de OpenSSL local; demais falhas tiveram retestes aprovados. Não publicar.

## Incremento B — saúde e filas internas

Arquivos-alvo: observability/service.ts, integrations/chatwoot-control-service.ts, chatwoot-group-worker.ts e suites unit/integration correspondentes. Separar saúde ativa de histórico; consultas tenant-scoped com recortes explícitos. Tratar pré-condições de grupo sem alterar autorização. Criar fixturesPG: disabledbacklog, desconectado, catálogo vencido, falha histórica, UNKNOWN antigo. Testar via transações/leases e API. Não limpar/resetar fila real.

## Incremento C — continuidade e custódia

B02: atestar fonte do digestEvolution, desenho de outbox atomicamente persistida na origem, dispatcher/retry e ACK/replay. Não alterar engine implantada antes de homologar imagem derivada. Testes crash antes/depois decommit/HTTP/ACK/restart.
B03: completar receipt existente com política de guarda/órfãos/recuperação. ManterKEEP enquanto não houver aceite físico. PG+storage privado, hash/tamanho, corrupção, ACK perdido, restore. Expurgo exige teste de ausência de perda e política aprovada.

## Incremento D — segurança, recuperação, capacidade

B05 canários de log na engine efetiva; B07 ordenação comum polling/webhook; B12 replay parceiro com receptorPG; B13 orçamento pools/quotas por SLO; B14fairness multitenant. Backup/restore completo e rollback0074→77→binário anterior→candidata em laboratório. O Docker local respondeu com acesso elevado; falta preparar/executar os ensaios, sem reutilizar serviços ou dados reais.

## Incrementos E–H — experiência e integração

E: design system/navegação por perfil com inventário e benchmark.
F: canais/QR e integração guiada usando rotas reais; tokens e acessibilidade.
G: central incidentes/filas/engines/mídia/APIkeys/docs/OpenAPI/Postman sincronizados e controles por permissão.
H: simuladorPG/S3 completo, testes adversariais, benchmark50→100→200→400;900somente após evidência. Publicação controlada somente com escopo aprovado, imagens/versionamento/runbook e recuperação ensaiada. CCLX real é fase própria.

Cada incremento entrega arquivos, testes, resultado, compatibilidade, dependências, riscos e estado explícito. Este plano não equivale a implementação ou homologação de todas as fases.
