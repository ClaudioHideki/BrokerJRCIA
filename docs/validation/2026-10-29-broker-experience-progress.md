# Broker JRC — registro de execução de 29/10/2026

Programa em andamento. Este registro não declara a conclusão de todos os módulos nem uma homologação produtiva.

## Fonte, escopo e decisões

- Branch de trabalho `codex/broker-experience-20261029`, base `16a2a371e44de65a901cf1a9405bf4939ee1f213`. Main remoto `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371` é ancestral; PR4 não recebeu head posterior na consulta de 29/10.
- Reutilizado worktree isolado `BrokerJRCIA-source-audit/.worktrees/image-release-20260924`; arquivos locais não versionados `output/` e `tmp/` foram preservados e não entram na entrega.
- Pedido integral preservado em `docs/superpowers/specs/2026-10-29-broker-experience-execution.md`; plano em `docs/superpowers/plans/2026-10-29-broker-experience.md`.
- Decisão: usar um registro de navegação para tenant e plataforma; preservar as telas existentes, as permissões reais e as URLs. Não criar inventários duplicados de conexão/inbox.
- Decisão: “disponível” no registro significa página implementada. Não é diagnóstico de provider, flag, configuração ou homologação.
- Decisão: manter leitura de integrações, credenciais e Flows para OPERATOR/VIEWER, conforme os guards atuais; esconder gestão de chaves desses papéis sem substituir a resposta backend de deep link.
- Nenhum deploy, migração produtiva, troca de engine/chave, alteração de conexão ou envio real autorizado/executado neste lote.

## Origem JRC reconciliada

**Correção do usuário em 29/10:** o alvo correto é `ClaudioHideki/jrc-conversas-lab2`. As três primeiras linhas abaixo preservam a comparação histórica, não uma dependência do programa. Fonte e ancestralidade atuais são registradas em `2026-10-29-jrc-source-baseline.md`.

| Origem | SHA | Evidência e efeito |
|---|---|---|
| `jrc-conversas-nico-v12-2-7-comercial-integrado`, main | `62c14af884c7f45fa640345556f2ffecc22113d8` | Ref remota atual de 29/10; não contém a última evolução lab2 |
| Mesmo repo, ptbr-pos-publicacao | `c6a877effa260ee752a81eaf8d52e81be1d22f2e` | Módulos Broker mais recentes dessa origem; campanha ainda exige Channel::Whatsapp |
| Mesmo repo, lab-homologacao | `6d5b526d3ea67fd5a3ecc339b5912d4218ff02f3` | Sem diferença nos trechos de campanha/status consultados |
| `jrc-conversas-lab2` | `1da5bbfb0d438f26c86082db364c32ef3049b2d3` | Fonte local inspecionada; revisão identificada na instalação em 27/10, sem nova prova remota em 29/10 |

No lab2, `BrokerMessageSender`, `BrokerIntentReservation` e `lib/webhooks/trigger.rb#prepare_jrc_delivery` já preservam mensagem pública/correlação e reserva antes do callback assinado. Há testes de interrupção após commit e entre reserva/persistência. Não reconstruir essa entrega como se faltasse. Delegação nativa de Flow também existe no lab2 e não na origem solicitada.

Lacuna comum: `Messages::StatusUpdateService` bloqueia apenas read→delivered; regressões read/delivered→sent/failed precisam de política geral e teste de concorrência. Nenhum arquivo JRC foi modificado neste incremento.

## Entrega 1 — navegação/configurações

Implementado na candidata local:

- Registro único de destinos, descrições, seções, ícones, permissões e disponibilidade da página; compatibilidade do export administrativo `sections`.
- Sidebar agrupada com rótulos, recolhimento por seção e busca por palavras/sinônimos sem acentos. Limpeza ao mudar empresa; leitura permitida preservada.
- Breadcrumbs derivados da mesma fonte; contexto explícito de empresa.
- `/configuracoes` como diretório de páginas reais e explicação dos escopos; `/minha-empresa` permanece status/limites do servidor.
- `/api-webhooks` com os dois modos de integração, limites públicos reais, links HTML para portal/PDF/OpenAPI/Postman e gerenciamento de chave somente quando permitido.
- Documentação de matriz de API e responsabilidades em `docs/validation/2026-10-29-api-baseline.md` e `docs/api/integration-modes.md`.

## Verificações iniciais

| Comando/escopo | Resultado | Limite |
|---|---|---|
| Testes novos de navegação, antes do código | 5 falharam / 1 passou | Assertions de grupos/busca ausentes; prova RED |
| Páginas Settings/ApiWebhooks, antes do código | 7 falharam | Assertions de conteúdo/comportamento ausente; prova RED |
| Navegação + App + Settings + ApiWebhooks | 4 arquivos / 19 testes passaram | Testes DOM locais; axe registra aviso de canvas ausente no jsdom |
| Contratos públicos / route policies | 2 arquivos / 12 testes passaram | Contratos sintéticos; não prova CCLX instalado |
| Suíte geral inicial, 2 workers | 437 arquivos passaram / 5 falharam; 3393 testes passaram / 9 falharam / 4 skipped | `spawnSync git EPERM` na execução Windows e fallback de manifesto; log privado preservado fora do Git |

A causa local identificada é o wrapper `cmd/git.exe` quando iniciado por Node. O binário `mingw64/bin/git.exe` funciona. Poppler existe. A correção de ambiente é usar PATH somente do processo para o binário nativo, sem configuração global Git nem alteração do produto. Reexecução e resultado final devem ser acrescentados abaixo.

## Próximos passos e dependências

1. Concluir testes mobile/deep links, rótulos do histórico, administração, build e evidência visual deste incremento.
2. Revisão independente de permissões, links do portal, limpeza de contexto e fronteiras do que foi implementado.
3. Prosseguir à entrega 2 do plano; não atualizar engine ou instalação produtiva para contornar um sintoma.
4. API pública: upload/envio de mídia e escopos, grant por inbox onde aplicável, recibos com reconciliação sem repetição e uso real de storage ainda pendentes.
5. Usar o candidato consolidado do lab2 preservando as frentes publicadas; a origem está confirmada. Verificar instalação/par de releases na homologação. Integração CCLX real depende de versão/customizações e laboratório autorizado.
6. Meta/grupos/voz exigem verificação oficial atual e ativos elegíveis; não foram homologados nesta fase.

## Fechamento verificável do primeiro incremento

Conferência de fonte JRC atual em `2026-10-29-jrc-source-baseline.md`: `e4a6a007`
inclui campanhas, atendimento e performance; as quatro frentes Cláudio já existem
por patches equivalentes (`git cherry` marcou `-`), portanto não foram reaplicadas.
Nenhuma fonte ou imagem JRC foi modificada aqui.

Resultados posteriores às correções:

| Verificação | Resultado confirmado | Alcance |
|---|---|---|
| Suíte geral final, Git nativo/OpenSSL locais, 4 workers | **446 arquivos / 3426 testes passaram**, exit 0, 449,60 s | Vitest padrão; não inclui suites separadas PostgreSQL/storage/E2E |
| Pacote `integrations/partner-qr` | 2 arquivos / 34 testes passaram, exit 0 | Host/provedor sintéticos; não CCLX instalado |
| Navegação/App/Settings/ApiWebhooks/PlatformShell | 5 arquivos / 26 testes passaram | DOM, papéis, busca, mobile e foco |
| ChannelDetail/InstanceWorkspace/navegação | 3 arquivos / 20 testes passaram | Rótulo corrigido, fluxo/persistência existentes preservados |
| Jornada do bot | 15 testes passaram após atualizar o rótulo esperado | A execução geral intermediária tinha só esse assertion antigo em falha; não foi ocultado |
| TypeScript `tsc -b --pretty false` | exit 0 | Projetos referenciados estritos |
| Build Vite de produção | exit 0 | Portal/PDF/OpenAPI/Postman existentes incluídos; aviso de chunk >500 kB permanece registrado |
| Scanner do bundle | 31 arquivos / nenhum finding | Não é avaliação de infraestrutura produtiva |
| Geração OpenAPI + `git diff --exit-code -- docs/api/openapi.json` | exit 0, sem mudança de contrato | 347 operações / 305 paths; nenhum novo scope de mídia publicado |
| Compiled workspace/entrypoint | 1 passou / 1 skipped por falta de banco explícito | Não declarar o entrypoint com banco como homologado |
| Revisão independente | P2 de foco identificado, reproduzido em 2 testes RED e corrigido; revisão final sem achado importante pendente | Diff deste incremento, não todo o programa |
| Navegador local | Desktop 1024×768 e mobile 390×844; busca “api”, navegação e retorno do foco conferidos; viewport restaurado | Dados simulados, sem mensagem/conta real |
| PostgreSQL/RLS, storage, Docker/container, restart, restore e E2E reais | Não executados nesta entrega | Docker Desktop local foi iniciado pela CLI, mas `desktop-linux` não apresentou named pipe funcional |

As falhas de ambiente originais foram resolvidas com PATH apenas do processo para
`git/mingw64/bin`, e OpenSSL 3.6.5-1 do pacote oficial MSYS2 extraído em ferramenta
local (SHA256 `389d1af21e99223d9e2cd32d4c073131b276da85be7636bd8d23571f6938864f`).
Sem configuração Git global, alteração de teste para ignorar erro ou instalação global.

Logs e imagens locais estão fora do Git em `New project/output/`:
`broker-experience-final-suite-20261029.log`, `broker-experience-build-20261029.log`,
`broker-experience-20261029/settings-desktop-local-demo.png` e
`broker-experience-20261029/navigation-mobile-local-demo.png`. A prévia está em
`http://127.0.0.1:5199/configuracoes?demo=1`; é demonstração visual, não instalação
com provider real. A aba usada pelo usuário não foi substituída para capturar a candidata.

O próximo contrato de mídia e suas decisões de interface estão registrados em
`docs/superpowers/specs/2026-10-29-partner-media-design.md` e no plano correspondente.
Scopes novos, migration proposta `0074` e envio público de mídia **não foram implementados**.
Permanecem pendentes, assim como os incrementos 2–7 do plano principal.

## Retomada exata

Abrir a branch `codex/broker-experience-20261029`, ler spec/plano/este registro e consultar `git status` preservando arquivos alheios. Revalidar refs antes da próxima alteração. Executar as verificações pendentes e atualizar este registro com resultado real. Não iniciar envio real, deploy ou troca de engine a partir deste checkpoint.
