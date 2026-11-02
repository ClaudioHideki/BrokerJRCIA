# Broker JRC: experiência e contratos — plano de execução

**Objetivo:** entregar por incrementos utilizáveis o programa aprovado em 29/10, preservando dados, contratos e diferenças entre API de parceiro e integração direta.

**Arquitetura:** manter Fastify/TypeScript/PostgreSQL/Redis, React/Vite e o design system JRC. Navegação é descoberta de páginas; capacidade efetiva e autorização continuam nas APIs e no recurso. Reutilizar os dois modos de integração sem migrar conexões existentes.

**Spec:** `../specs/2026-10-29-broker-experience-execution.md` (pedido integral do usuário).

## Restrições globais

- Desenvolvimento e testes reversíveis autorizados. Atualização do usuário em
  29/10: seguir até a publicação das imagens da revisão validada, preservando a
  branch e sem merge automático na main. Deploy, migração produtiva, troca de
  engine/credencial de cliente e envio real continuam fora desta etapa.
- Chaves de empresa, sessão administrativa, grants de QR/Flow e segredos de eventos permanecem separados.
- Não incluir dados de clientes, telefone real, sessões, payloads ou tokens no repositório.
- Primeiro confirmar a fonte mais recente do `jrc-conversas-lab2`, origem corrigida expressamente pelo usuário em 29/10; não escolher uma release específica de outra instalação apenas pela data.
- Testes locais, contratos sintéticos, ambiente instalado e entrega ao provider têm evidências separadas.

## Reconciliação inicial

- Broker destino: `codex/broker-experience-20261029`, base `16a2a371e44de65a901cf1a9405bf4939ee1f213`; main remoto `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371` é ancestral. PR4 remoto continua na base, sem atualização posterior na branch consultada.
- JRC alvo correto: `jrc-conversas-lab2`, confirmado pelo usuário em 29/10. `e4a6a007193988af3f314a902ec68531fd25a14a` acrescenta atribuição no atendimento após `1da5bbfb0d438f26c86082db364c32ef3049b2d3`; conferir ancestralidade antes da integração. Não confundir refs main/default antigas com os últimos candidatos publicados.
- A comparação com `jrc-conversas-nico-v12-2-7-comercial-integrado` (`62c14af`/`c6a877e`/`6d5b526`) é histórica. A origem foi corrigida, portanto não bloqueia a escolha de fonte para o programa.
- Branches `precimech-*-20261028` são publicação/hotfix isolados de outra instalação; não substituem automaticamente a base Grupo JRC apesar da data mais recente.
- A identificação de `1da5bbfb` como instalada veio da consulta anterior de 27/10. A instalação atual ainda exige nova prova; fonte atual e instalação são fatos separados.
- OpenAPI versionado da base: 347 operações / 305 paths; catálogo público: 19 genéricas + 15 vinculadas à conta Chatwoot. Contagens são inventário, não aceite.

## Entrega 1 — navegação e descoberta de configurações

**Arquivos:** `apps/web/src/layout/navigation.ts`, `AppShell.tsx`, `PlatformShell.tsx`, `platform/model.ts`, `pages/Settings.tsx`, `pages/ApiWebhooks.tsx`, `app/App.tsx`, `app/broker.css`, testes correspondentes.

**Interfaces:** `tenantNavigationFor(role, query?)`, `tenantPageFor(pathname, role)`, `platformNavigation`. Registro único com contexto, seção, rota, rótulo, ícone, descrição, permissão e disponibilidade da página. Disponibilidade não equivale a provider configurado ou homologado.

- [x] Reproduzir menu sem grupos, busca e atalhos distintos: 5 assertions falharam / 1 comportamento existente passou.
- [x] Implementar registro único e manter export `sections` por compatibilidade administrativa.
- [x] Mostrar busca, grupos recolhíveis, ícones/rótulos, contexto, breadcrumbs e atalho real API/webhooks.
- [x] Preservar leitura de Flows, credenciais e integrações para operadores/leitores; gestão de chaves somente OWNER/ADMIN.
- [x] Criar centro de configurações com links reais e escopos, sem formulário fictício de ENV ou migração de storage.
- [x] Explicar modos A/B e limites públicos reais; links HTML para portal/contratos/PDF/Postman, sem token no browser.
- [x] Completar testes de deep links, troca de empresa, mobile e administração.
- [x] Renomear “Eventos” que realmente apresenta histórico operacional, preservando IDs internos.
- [x] Build, suites afetadas, revisão independente e verificação visual; commit registrado no progresso após conferência do staged diff.

## Entrega 2 — lifecycle e integração

**Entradas reais:** `modules/channels`, `modules/instances`, `modules/integrations`, `ChatwootPanel`, `ChatwootControlPanel`, `NativeJrcSetup`, `ChannelDetail` e testes HTTP/RLS.

- [x] Consolidar matriz inicial de evidências de lifecycle e testes existentes, sem reimplementar onboarding/adoção. Ver [evidências de lifecycle](../../validation/2026-10-29-lifecycle-evidence.md).
- [x] Corrigir acompanhamento de pareamento após reload/NONE, desafio PNG efêmero, inbox removida da seleção e substituição/revalidação de agentes. Cobertura local não encerra o aceite de lifecycle.
- [ ] Mostrar separadamente sessão, identidade, conta remota, callback, entrega e caixa; retomar falha parcial sem repetir POST ou criar inbox duplicada.
- [ ] Validar grants/revogação em voo, proprietários de sessão/envio/projeção e limpeza após troca de empresa.
- [ ] Testar reinício de consumidores no laboratório; registrar versão instalada e contratos de evento reais.

## Entrega 3 — API pública, eventos, mídia e recibos

**Entradas reais:** `http/routes/messaging*.ts`, `http/plugins/authorization.ts`, `modules/partner-events`, `modules/messaging/media-store.ts`, `packages/contracts`, `scripts/docs/public-api.mjs`, `docs/api/openapi.json`, `integrations/partner-qr`.

- [x] Acrescentar upload/envio público individual QR com escopos próprios, limites,
  quota e reautorização dos bytes. Implementação e testes reais de mídia da CI
  passaram; as expectativas antigas de baseline foram corrigidas e passaram na
  CI seguinte. O gate global aguarda a repetição dos seletores E2E atualizados.
  Ver [evidência](../../validation/2026-10-29-partner-media.md). Não encerra outros providers/grupos.
- [ ] Definir leitura por inbox/grant para a persona operador onde o contrato exige atribuição; hoje alguns handlers de mensagens são por organização.
- [ ] Conciliar recibos distinguindo aceitação do motor, confirmação, entrega e leitura, sem reenvio de resultado incerto.
- [ ] Manter S3 existente; medir uso real (`storageBytes` está nulo), documentar deployment/retention, testar integridade/UNKNOWN.
- [ ] Testar cursor/replay/retenção, revogação de chave vs subscription, assinatura e colisões entre empresas.

## Entrega 4 — Flows, delegação, handoff e campanhas

- [ ] Preservar o candidato atual do lab2 e comprovar a revisão da instalação antes da próxima release. Não perder intents/delegação existentes.
- [ ] Generalizar monotonicidade de status Rails com teste de concorrência; preservar retry legítimo failed→sent.
- [ ] Verificar ciclo publicar/instalar/executar/pausar/retomar/rollback e autoridade automática única, com interrupção por humano.
- [ ] Completar API/grants públicos de Flow sem ampliar chave QR; testar mídia e contrato conjunto.
- [ ] Homologar campanhas canônicas e recuperação de callback/reserva com Sidekiq/Redis e restart real em laboratório.

## Entrega 5 — grupos, IA e chamadas

- [ ] Matriz por versão/provider/ativo; catálogo exato de eventos necessários, batches, dedupe e caminhos de grupos/histórico.
- [ ] Verificar documentação Meta oficial atual para Groups API, BSUID, Calling e elegibilidade antes de implementar ou classificar indisponibilidade.
- [ ] Validar runtime NICO multiempresa e budgets, sem alterar provider/modelo homologado por suposição.
- [ ] Voz como entrega própria: contrato/ownership/BFF, codecs/ICE/mídia, rejeição/queda e áudio real em redes distintas. Nenhum mock será rotulado como voz homologada.

## Entregas 6–7 — pacote e release revisável

- [x] OpenAPI/Postman/PDF sincronizados com os 37 contratos públicos; portal
  conferido no build, sem fallback SPA ou escrita automática. Newman sintético
  verificou três ações de anexos; PDF técnico de oito páginas renderizado e revisado.
- [ ] Adapter host com bindings/inbox/outbox e guia de instalação limpa/atualização; versão CCLX exata permanece dependência externa.
- [ ] Regressão, HTTP/RLS, storage/container/compiled, carga controlada, restart e restauração com RPO/RTO medidos.
- [ ] Revisão independente e candidata com SHAs/digests, configuração, rollout/retorno e checklist de aprovação.

## Foco de revisão

1. Usuário VIEWER mantém consultas permitidas, não recebe ações administrativas.
2. Mudança de empresa limpa consulta/busca e rejeita resultado tardio da anterior.
3. Link de documentação usa navegação HTML para o portal estático, sem chave ou cookies adicionados pelo cliente público.
4. Deep links e rotas antigas continuam operando; recursos sem página não ganham links fictícios.
5. Status e capacidade exibidos distinguem implementação, configuração e homologação real.

## Dependências externas

| Dependência | Entrada necessária | Trabalho que pode seguir |
|---|---|---|
| Par de releases JRC/Broker | Revisão da instalação lab2 atual e teste conjunto | Broker e contratos sintéticos |
| Homologação CCLX | Versão exata, customizações, consumidor/eventos e laboratório autorizado | Adapter, documentação e harness |
| Meta/voz | Ativo, permissões, elegibilidade e laboratório autorizados | Contratos, validators e UI honesta |
| Instalação/backup | Ambiente de homologação, storage e ponto de retorno | Testes isolados e roteiro de restauração |

Registro de execução: `../../validation/2026-10-29-broker-experience-progress.md`.
