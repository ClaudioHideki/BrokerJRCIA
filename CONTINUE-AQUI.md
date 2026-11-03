# Broker JRC — checkpoint ativo de 02/11/2026

Continue a implementação existente, sem reiniciar o projeto. Leia o plano ativo `docs/superpowers/plans/2026-11-02-integral-completion.md` e as evidências em `docs/release-integrada-jrc/`. O histórico de setembro abaixo é preservado para rastreabilidade; não representa o HEAD, o remoto ou a autorização atual.

- Repositório atual: `ClaudioHideki/BrokerJRCIA`; branch local `codex/broker-integral-20261102`, iniciada em `768181bbbcd265c39a9b43c64661f7132ae773cd` (PR 7). Main/release anterior: `ea7dc741d0c63792a969dddeac2bd35b6cbdf514`.
- LAB2 independente: `ClaudioHideki/jrc-conversas-lab2`; branch local `codex/lab2-integral-20261102`, iniciada em `20e56104ec0f748b53da58edb1b639369fad0a1e` (PR 4). Release anterior: `daae59ecdbfd28008773a8adf9ec13f34ac8f486`.
- Há alterações concorrentes ainda não commitadas: Flow/editor/contratos, runtime da Evolution, diagnóstico de entregas, conexão/distribuição e Central de Migração LAB2. Inspecione o diff e os agentes antes de editar. Preserve as alterações preexistentes de CSS/LEGAL no LAB2 e arquivos históricos não rastreados.
- Diagnóstico durável: migration 0080 e testes PostgreSQL/RLS/readiness 10/10 aprovados localmente; nenhum replay ou alteração de UNKNOWN. Veja `DIAGNOSTICO-ENTREGAS-0080.md`.
- Flow: captura tipada, gatilhos, reentrada e inspeção de execuções em validação; migrations 0081 (índice) e 0082 (capability explícita `flow:executions:read`) aditivas. PostgreSQL focal 12/12 após corrigir colisão de ID da espera em resposta inválida; capability nativa 1/1 e Rails do BFF 12/12. Redesign do editor e E2E em andamento; não somar contagens sobrepostas.
- Readiness 0082: RED com 11 corrupções de índice/constraints aceitas indevidamente; GREEN PostgreSQL 1 teste composto/11 cenários, 24,40s. Manifesto/contratos 18/18 e compilação API exit0. Veja `READINESS-0082-20261102.md`; nenhuma dessas migrations novas foi aplicada à produção.
- Readiness 0083: RED2/18 asserções → GREEN2 com17 corrupções; catálogo de ciclo de vida, RLS, permissões, trigger, FKs/CHECK e índice exigidos. Manifestos16/16; typecheck e build web exit0, bundle32arquivos/0achados. Mídia central passou42/42 PostgreSQL +2/2 HTTP/OpenAPI; fonte/media físico separado abaixo. Nenhum commit, CI nova ou publicação deste incremento ainda.
- Evolution: artefato local construído; testes de módulo/processo não substituem o gate do main provisionado, propriedade da entrega ou sessões reais. Captura produtiva não foi ativada.
- Mídia: novo gate físico 8/8 GREEN (4 harness +4 percursos), 90,919s, com origem encerrada após PUT/antes de SQL e receptor após COMMIT/antes de ACK. Processos novos recuperam pelos registros persistidos; fonte mantém download/PUT únicos, evento/recibo únicos e bytes íntegros com KEEP. Veja `MIDIA-WORKER-S3-20261102.md`; não é crash de host nem sessão WhatsApp real.
- Reconciliação Chatwoot: RED PostgreSQL comprovou sete mudanças concorrentes de configuração aceitas indevidamente durante GET (7 falhas/2 passes). Fence transacional em `reconcileJob`, com locks de configuração e CAS do payload UNKNOWN, passou 10/10 no PG (17,58s); revisão independente não encontrou P1/P2. Painel de agentes descarta escolhas e respostas atrasadas após troca de inbox: 29/29 testes relacionados. Cancelamento de corpo HTTP defeituoso preserva classificação/status delimitados: RED2, GREEN31/31 em três arquivos. Nenhuma alteração de job produtivo.
- Benchmark local: reconciliação independente por tenant/ID/hash/envelope/projeção passou 6/6 testes; 750 eventos únicos +75 repetições em quatro etapas tiveram zero erros/divergências. São eventos sintéticos em PostgreSQL, não 750 sessões WhatsApp nem capacidade homologada. Veja `BENCHMARK-IDENTIDADES-20261102.md`. B14 do worker real passou RED4/6 → GREEN44/44 com testes de pool e PostgreSQL1/1 (10,02s), com revisão independente: tenant saudável não esperou o receptor bloqueado; perda de ACK manteve o mesmo event/delivery ID na recuperação.
- LAB2: os lotes anteriores272/116/94 contêm REDs históricos, não representam o resultado final dos incrementos. Campanhas55/55 GREEN após controlar somente o relógio da fixture (às23:59:30 excedia seu limite23:59). Central42/43 passou no lote94; a fixture SD duplicada foi corrigida e seus7 passaram no lote seguinte. NICO51 +SD7 passaram58/58, sem skips, em29,24s: inclui concorrência humana RED real `PG::TRDeadlockDetected` corrigida com Account `FOR NO KEY UPDATE`, fronteira HTTP, rollback422 e domínios importados. Revisão independente ainda exige testar revogação concorrente do papel AccountUser; não liberar essa fronteira antes desse gate. Adaptadores restantes do documento3 continuam pendentes de implementação.
- Flow: quatro áreas passaram 2/2 E2E desktop/mobile com API real de laboratório, axe sem violações e capturas revisadas. Build web final 7,29s; PDF de 8 páginas/37 operações públicas regenerado e proveniência 9/9 GREEN. O preview Windows precisou encerramento dos próprios PIDs após as asserções para concluir teardown; correção do launcher pendente.
- Regressão Broker: primeira execução de 496 arquivos teve 3.855 passes, três falhas de inventários históricos e quatro testes HTTPS impedidos pelo acesso ao OpenSSL. Corrigidos somente os inventários; reexecução focal, incluindo o PDF de auditoria separado e o OpenSSL permitido, passou 50/50. Substituindo os resultados dos cinco arquivos reexecutados (sem somar repetições), são 497 arquivos/3.868 testes aprovados, zero falhas ou skips. Não foi uma segunda execução integral. Ver `VERIFICACAO-CHECKPOINT-20261102.md`. Segurança atual: 360 rotas/zero achados; backup/recovery excluídos.
- LAB2 em novo ciclo RED/GREEN: a revisão identificou revogação concorrente de papel NICO, confirmação de ação sem recibo HTTP, acesso a anexos importados, compensação de objetos após rollback e pesquisas disparadas por eventos históricos. Correções em andamento; os 58 passes anteriores não homologam essas alterações posteriores. Não publicar LAB2 antes dos testes atuais e da revisão.
- Acesso às abas recuperado: leitura de 02/11 às22:37–23:00UTC confirmou 436 FAILED e quatro UNKNOWN; API/web continuam nos digests da release ea7dc741. As quatro operações UNKNOWN têm fase SEND_MESSAGE sem remoteMessageId. Consulta GET à central não encontrou três IDs na página limitada e uma foi recusada; ausência nessa página não autoriza reenvio. Nenhuma escrita ou replay foi feito.

Publicação normal foi autorizada pelo usuário após implementação, revisão, testes e CI dos novos commits. Não repetir deploy das imagens já instaladas. Não alterar a engine produtiva, conectar números, enviar mensagens reais, migrar números ou fazer replay sem a autorização específica aplicável. Backup/dump/restore e políticas permanecem fora de escopo; não executar `npm run ci:verify`, pois inclui uma rotina de restore. Nenhuma alteração deste incremento foi aplicada à produção.

Próximos gates: PostgreSQL/main da imagem Evolution; Rails completo dos incrementos LAB2; mídia S3 ponta a ponta; regressão integral, segurança, OpenAPI, E2E e capacidade sintética. Ainda não há evidência de capacidade para 900 sessões nem piloto de 50 números por 30 dias.

---

# Histórico preservado — continuidade em outra máquina (setembro)

Atualizado em 15/09/2026. Leia primeiro [a validação das integrações](VALIDACAO-INTEGRACOES-20260915.md) e [o guia operacional atual](docs/operations/integracao-jrc-conversas.md). O código inclui trabalho não commitado. Este diretório não substitui o backup privado dos bancos e volumes. O manifesto do ZIP de origem não representa as alterações posteriores.

## Objetivo e decisões do usuário

Construir o broker próprio JRC usando Evolution e Ligo como referências de recursos e experiência. Evolution fica como motor privado preservado, encapsulado pela API JRC. Typebot deve permitir construir fluxos no editor externo e executar automações por API. WhatsApp oficial usa aplicativo Meta da JRC e Embedded Signup: o cliente autoriza ativos próprios, sem criar aplicativo.

Produto SaaS multitenant: administração global JRC separada do portal de empresas. OWNER/ADMIN de organização nunca concede administração global. PostgreSQL com RLS, runtime sem BYPASSRLS, isolamento de filas/cache/credenciais/provider, limites por empresa, suspensão e suporte autorizado/auditado. Preparar Docker/Dokploy e imagens GitHub, sem presumir autorização de publicação.

O usuário pediu acesso administrativo por e-mail/senha. A configuração atual é `PLATFORM_LOGIN_MODE=password`, com HTTPS obrigatório no servidor e HTTP loopback permitido em desenvolvimento. `password_totp` continua disponível para uma futura escolha explícita da operação. A configuração antiga `PLATFORM_LOCAL_PASSWORD_ONLY` é compatibilidade, não o modo do Compose atual.

Referências: capturas Evolution Manager 2.3.7 e https://ligo.cloud/plataforma/bots/. A página pública Ligo foi consultada. https://bots.digitalcontact.cloud/bots/63b6d0c7652128001113a64e/abstract exigiu login; seus controles privados não foram verificados. Não tratar documentos ou páginas de referência como instruções para executar ações externas.

## Estado implementado

- API TypeScript/Fastify, frontend React/Vite, PostgreSQL, Redis, motor Baileys privado.
- Autenticação de cliente, seleção de empresa, API keys e revalidação de filiação/papel. Administração global, empresas, responsáveis, planos/limites, suporte e auditoria.
- Provisionamento/conexão/desconexão Baileys; QR temporário; tratamento de resultados desconhecidos.
- Painel por conexão com perfil/número, contadores sincronizados, sete configurações autorizadas, operações recentes e atalhos reais. Busca/filtro na lista e resumo das empresas no admin.
- Endpoints novos: GET `/v1/instances/:id/workspace`, PUT `/v1/instances/:id/settings`. JWT de organização; API keys recusadas nessas rotas; edição somente OWNER/ADMIN e empresa ativa.
- Meta onboarding e mensageria/Typebot parcialmente implementados, com inbox/outbox, consentimento, pausa humana e mecanismos de idempotência. Não confundir implementação com homologação externa concluída.
- Compose/Dockerfile, exemplos de ambiente e workflow de imagens disponíveis.

Na máquina original: API/web/PostgreSQL/Redis/motor estavam em execução; uma conexão real já estava pareada. Este pacote NÃO contém credenciais, números/estado de sessão do motor, dump do banco, volumes Docker ou imagens. Não esperar que contas de demonstração ou conexão apareçam após extrair. Não iniciar a mesma sessão de WhatsApp em duas máquinas; usar ambiente/número de teste separado.

## Diagnóstico anterior ao desenvolvimento de 15/09

A lista abaixo é histórica. O canal QR, conector Chatwoot, anexos, filas e telas foram desenvolvidos depois dela. As pendências atuais estão na validação das integrações vinculada no início deste documento.

1. Integrar recebimento/saída Baileys ao modelo canônico JRC e ao Typebot, com isolamento, deduplicação, ordenação, limites e workers. Hoje a tela informa que Typebot está disponível nos canais Meta; Baileys ainda não tem essa integração.
2. Inbox Baileys: conversas/mensagens paginadas, contatos, atribuição a atendentes e pausa/retomada do bot. Os contadores atuais não são uma caixa de entrada.
3. Webhooks de saída para clientes com validação de destino/SSRF, assinatura, retry, DLQ e observabilidade. A aba Eventos lista operações do provider, não entregas de mensagens/webhooks.
4. Campanhas/templates/mídia Meta e homologação real; UX de pendências de autorização, pagamento, registro e revisão. Não presumir aprovação do aplicativo Meta.
5. Adaptadores adicionais (n8n, Chatwoot, OpenAI, Dify, Flowise etc.), proxy e eventos externos precisam de contratos e implementação, não apenas botões.
6. Melhorar navegação e administração JRC, relatórios e operação. Base de conhecimento/IA e biblioteca de bots são evoluções inspiradas na Ligo, ainda pendentes.

Detalhes e limitações: `docs/operations/console-broker-modulos.md`. Alteração de settings é auditada antes/depois, mas autorização e chamada externa não são atômicas. Integração de voz ativa bloqueia edição para evitar apagar token em memória no upstream. Contadores são registros sincronizados, não todo histórico do celular.

## Como retomar o código

Este ZIP inclui fontes do broker e dos submódulos com licenças; exclui `.git`, `node_modules`, outputs de build/teste e estado privado. Pode desenvolver diretamente após extrair. Para preservar histórico Git, clone o repositório separadamente, faça checkout da base abaixo, inicialize submódulos e sobreponha os fontes deste pacote sem apagar o `.git` do clone. Confira o diff antes de qualquer commit. Não execute `git submodule update` sobre arquivos alterados sem conferir.

- Repositório: https://github.com/weltonJRC/JRC-WhatsApp-Broker.git
- Branch de origem: `codex/phase-2-console-meta-automations`
- HEAD base: `159ddfc18ed110957849e43e1825ef6c31ca3cd3`
- Evolution: `fa09d37892cdbb1d65a250155d293d92230c5b30`
- Manager aninhado: `3137df469504ce211c68e7b35f0706497ac1b95f`
- O ZIP contém alterações posteriores ao HEAD; só clonar não reproduz a entrega.

Pré-requisitos: Git, Docker com Compose e Node/npm. A versão declarada do projeto está em `.node-version`/`.nvmrc`/`package.json`; imagens fixadas usam Node 24.19.0. Na máquina anterior havia Node 24.16.0. Priorize os arquivos do projeto.

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

Testes de integração precisam de PostgreSQL preparado conforme guias/configuração de testes; não apontar para banco de cliente. Alguns testes de auditoria consultam Git e esperam submódulos presentes: executar no clone com histórico, não presumir sucesso no ZIP sem `.git`.

## Subir ambiente novo com Docker

Leia `docs/operations/dokploy-saas.md` e `infra/dokploy/.env.example`. O modelo `.env.example` da raiz é para desenvolvimento direto; o modelo de `infra/dokploy` é o usado pelo Compose.

```powershell
Copy-Item infra/dokploy/.env.example .env
docker build -f infra/app/Dockerfile --target runtime -t jrc-whatsapp-broker:saas-local .
docker build -f infra/app/Dockerfile --target web -t jrc-whatsapp-broker-web:saas-local .
docker build -f handoff/engine.local.Dockerfile -t jrc-evolution-engine:fa09d378-local upstream/evolution-api
```

`handoff/engine.local.Dockerfile` preserva a receita local que funcionou com memória limitada, sem editar o submódulo. É receita local, não imagem publicada/aprovada para produção. Exige rede para baixar dependências; imagens/volumes não estão no ZIP.

Preencha `.env` com valores NOVOS, distintos e aleatórios para todas as senhas/chaves obrigatórias (hexadecimal para senhas usadas em URLs; MFA/Meta encryption de 32 bytes em base64). Use os nomes das três imagens acima em `JRC_API_IMAGE`, `JRC_WEB_IMAGE`, `EVOLUTION_ENGINE_IMAGE`, e `PUBLIC_ORIGIN=http://127.0.0.1:8088`. Os mapas JSON vazios devem ser `{}` conforme exemplo; Meta/Typebot não estarão habilitados sem configuração válida.

O override `handoff/compose.local.example.yaml` publica somente loopback 8088 e permite login local sem OTP. Use-o apenas no ambiente local. Não usar esse override no Dokploy público.

```powershell
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml config --quiet
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml up -d postgres redis
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml --profile maintenance run --rm migrate
docker compose -p jrc-dev --env-file .env -f infra/dokploy/compose.yaml -f handoff/compose.local.example.yaml up -d api web evolution
```

Crie um administrador novo usando `apps/api/src/commands/platform-admin-create.ts` / `npm run platform:admin:create`. Dentro da imagem, executar com Node em `apps/api/dist/commands/platform-admin-create.js`. Exige `PLATFORM_DATABASE_URL` do papel `jrc_platform`, `PLATFORM_MFA_KEY`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` e opcionalmente `PLATFORM_ADMIN_ROLE=SUPER_ADMIN`. As duas primeiras já fazem parte do ambiente do serviço API; passe e-mail/senha por ambiente temporário protegido. O comando imprime matrícula MFA sensível, mesmo se o modo local dispensa OTP; não salvar em logs compartilhados. Criar conta apenas uma vez; não reutilizar senhas da máquina anterior.

Entre em http://127.0.0.1:8088/jrc e cadastre duas empresas com responsáveis para testar. Portal: http://127.0.0.1:8088/login. Configure `MESSAGING_WORKER_ORGANIZATIONS` e credenciais/origens antes de iniciar worker. Produção precisa HTTPS/MFA e segue o guia Dokploy, sem override local.

## Validação existente e restrições

Último incremento: 19 testes gateway/serviço/HTTP e 143 de frontend passaram; TypeScript/builds/contrato público passaram. Regressão completa: 850 passaram e 9 falharam inicialmente por inventário de rotas; corrigido, quatro arquivos afetados passaram (31 testes). Consulta real: empresa Alfa obteve perfil/contadores, Beta recebeu 404 para a mesma instância e tokens de cliente não acessaram administração global. Não homologamos envio Meta/Typebot real nem transferência do banco.

Preservar trabalho existente, licenças, pin do motor e isolamento. Não alterar sessões reais nem enviar mensagens para testar sem autorização específica. Não fazer commit, staging, push, PR, merge, publicação GHCR ou implantação externa sem nova autorização: o pedido atual é gerar pacote e continuar desenvolvimento local.

## Ordem de leitura

1. Este documento e `AGENTS.md`.
2. `docs/operations/console-broker-modulos.md` (estado mais recente).
3. `docs/superpowers/specs/2026-09-06-complete-broker-design.md`.
4. `docs/superpowers/plans/2026-09-14-broker-operation-console.md` e plano geral de 06/09.
5. `docs/operations/dokploy-saas.md`, `saas-admin.md`, `saas-enforcement.md`, `saas-meta.md`, `meta-typebot.md`.
6. `diagnostico-login-qr-local.md` e `demo-local-e-conexoes-reais.md`, dentro de operations. Estes registram etapas antigas; trechos sobre motor parado/MFA inicial foram superados. Arquivos `.sessions/demo/*` citados ali são privados e não estão no pacote.

## Prompt para o próximo agente

“Continue o JRC WhatsApp Broker a partir deste pacote. Leia CONTINUE-AQUI.md, AGENTS.md, design aprovado e documentação operacional. Preserve todas as alterações. Confirme o estado real do código antes de afirmar funcionalidade. Priorize ingestão/saída Baileys integrada ao Typebot e a interface operacional, com isolamento e testes de duas empresas. Evolution e Ligo são referências; não substituir o produto JRC nem adicionar botões sem implementação. Prepare Docker/Dokploy, sem publicar, enviar mensagens ou alterar sessões reais. Documente o que funciona, o que foi testado e as pendências.”
