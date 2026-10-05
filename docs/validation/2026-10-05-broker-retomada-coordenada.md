# P1 — desenvolvimento e verificação da retomada coordenada

Data: 05/10/2026. Base local: `eb577ac`, branch `codex/broker-ura-reset-integration-20261005`.
Este registro trata do primeiro incremento do [programa](../superpowers/plans/2026-10-05-broker-programa-integracao.md). Não declara implantação, aprovação do CI remoto ou homologação pelo WhatsApp.

## Comportamento implementado

O comando de retomada exige OWNER/ADMIN ativo, usuário e vínculo ativos, revisão de controle, revisão de executor, alvo explícito e `Idempotency-Key`. O Broker reserva uma operação durável e mantém a conversa em HUMAN. Repetir chave e corpo consulta a mesma operação; trocar corpo com a mesma chave gera conflito.

Para uma central conectada, o worker valida conta/caixa/destino/credencial, bot concorrente, saudação e atribuição automática. Executa três comandos separados: remover agente, remover time e colocar a conversa em pending. A leitura autoritativa seguinte deve confirmar a caixa e a ausência de agente/time. Só então, após revalidar as revisões locais, cria um ciclo e confirma sessão, controle READY, modo BOT e operação APPLIED na mesma transação. HTTP ocorre fora de transação.

Sem central, o mesmo comando coordena sessão e autoridade locais, sem inventar Account/Inbox. Integração configurada mas indisponível não é tratada como standalone. O PATCH legado BOT bloqueia canais nativos ou conectados, inclusive conversas sem mapeamento; a decisão acontece sob lock do canal. HUMAN manual continua disponível.

Os alvos são:

- NEW_SESSION: iniciar a versão publicada vinculada, sem reproduzir mensagens antigas.
- MENU: entrar em um menu real da versão fixada, preservando somente um estado de raiz compatível.
- CONTINUE: restaurar uma espera EVENT compatível e aguardar uma nova mensagem; não consumir uma resposta vazia de RESUME.

O diagnóstico da execução distingue escopo/executor inválido, controle humano, reconciliação, inicialização, pausa e espera. A UI só trata a retomada como confirmada em APPLIED; oferece escolha explícita e preserva a chave após perda de resposta.

A jornada sintética usa o teste de handoff existente: menu, resposta inválida, espera sem mensagem, captura, transferência, resposta humana, retorno ao menu e mensagem do ciclo novo. Silêncio neste incremento significa manter a espera; prazo configurável de resposta e ramo de timeout do Flow permanecem em P3.

## Proteções verificadas

| Caso | Evidência local |
| --- | --- |
| Tenant B não lê operação de A; grants restritos | PostgreSQL com papel jrc_app real e testes de migração |
| Conversa legada, repetição de POST e corrida de operadores | Reserva sem sessão antecipada, única operação/ciclo |
| Humano, credencial, binding ou executor mudam durante HTTP | Próximo comando bloqueado; HUMAN permanece |
| Usuário ou vínculo desativado | Admissão negada e processamento interrompido |
| Callback intermediário atrasado | Watermark da confirmação evita regressão; nova resposta humana continua bloqueando |
| Timeout/crash depois do despacho | UNKNOWN/ACTION_REQUIRED sem repetir POST e sem liberar bot |
| Exclusão durante retomada incerta | Preview e funções executáveis de request/purge preservam caixa, empresa e journal |
| Central criada enquanto PATCH legado espera | Releitura sob lock rejeita o atalho BOT |
| Upgrade 0043 → 0044 | Aditivo; histórico/outbox UNKNOWN preservados, baseline e grants conferidos |
| Bot → handoff → humano → menu → mensagem nova | Motor, router, outbox e handoff reais com central sintética |
| Interface desktop/celular e teclado | Playwright com API/worker reais e PostgreSQL isolado |

## Resultados

Verificação final local do candidato. Tentativas intermediárias com falhas não representam aprovação.

| Camada | Comando e resultado |
| --- | --- |
| Unitários, contratos, HTTP e UI | `npm test -- --maxWorkers=2`: **263 arquivos / 1.732 testes PASS**, 314,90 s |
| Integração PostgreSQL/Redis | `npm run test:integration -- --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000`: **79 arquivos / 504 testes PASS**, 714,17 s |
| Jornada ampliada após ajuste final do teste | Mesmo comando de integração, limitado a `native-handoff.test.ts`: **26 testes PASS**, 20,79 s; inclui captura, opção inválida, espera, humano e retomada |
| Navegador completo | `npm run test:e2e`: **37 PASS / 5 SKIPPED**, 3,2 min; nenhuma falha |
| Retomada desktop/celular | Ambos os casos novos incluídos no navegador completo passaram, com teclado e persistência após reload |
| Compilação e tipos | `npm run clean`, `npm run build`, `npm run typecheck`: **PASS** |
| Runtime compilado | `npx vitest run --config vitest.compiled.config.ts --maxWorkers=1`, com URLs de teste: **2/2 PASS**, 10,91 s; resolução de pacotes e processo real da API com health/shutdown |
| OpenAPI | `npm run openapi:generate`: **PASS**, três rotas de retomada documentadas |
| Bundle e contratos | `npm run test:web:bundle`, `npm run security:contracts`: **PASS**, 11 arquivos de bundle sem findings |
| Licenças e upstream | `npm run security:notices`, `npm run security:submodule`: **PASS**, sete pacotes e submódulo preservado |
| Checagem automatizada do candidato | `scripts/security/check-release.mjs`, chave temporária só no processo: **PASS**, 229 rotas e zero achados nos scanners executados |

Os cinco SKIPPED já fazem parte das regras de `console.spec.ts`: quatro jornadas exclusivas de desktop são omitidas no perfil mobile e o teste específico da shell mobile é omitido no desktop. Não são PASS nem omissões da retomada. A primeira execução compilada omitiu o teste de runtime porque não recebeu as URLs; a repetição final com ambiente local explícito executou ambos.

A regressão unitária anterior chegou a 1.731/1.732; a única falha era uma fixture antiga de observabilidade sem os fatos de conversa necessários ao diagnóstico novo. Após corrigir a fixture, a suíte inteira acima foi repetida e passou. A revisão independente de código e documentação não encontrou problema material remanescente; é revisão por inspeção, separada dos testes executados.

As suítes usam somente os containers descartáveis `broker-resume-p1-postgres` (PostgreSQL 16.4, porta local 55447) e `broker-resume-p1-redis` (Redis 7.4, porta local 55448). Fsync foi desativado exclusivamente no PostgreSQL descartável para reduzir custo de DDL; não foi alterada configuração de produção. Integrações são serializadas; timeouts locais foram ampliados após observar saturação do laboratório. Nenhum teste desta etapa envia mensagens a pessoas.

`git diff --check --ignore-submodules` passou antes de registrar o candidato. O manifesto raiz foi regenerado com os arquivos de P1; o backup local permaneceu preservado e excluído do commit. Não foram executados nesta etapa CI remoto, construção das imagens de release, restore de cópia do servidor ou promoção de produção.

## Limitações e aceite externo

Chatwoot padrão não oferece CAS remoto nem correlação/idempotência para essas três mutações. Uma resposta humana observada durante o processo invalida a intenção; não há garantia de atomicidade com uma alteração remota cujo callback ainda não chegou. A central instalada e sua versão precisam de prova própria.

Uma leitura matching pending não prova autoria nem término de um comando remoto anterior. Após resultado incerto, ACTION_REQUIRED preserva a barreira de retomada e de exclusão. Este incremento não oferece um botão que remova essa barreira com base somente em status; exige evidência do sistema remoto e um procedimento de reconciliação. Não editar registros reais nem reapresentar o mesmo comando para contornar a proteção.

Não foram homologados neste incremento: dispositivo real, JRC tenant A/B, instalação Chatwoot externa, grupos WhatsApp, voz, saída pelo aparelho e interfaces Flow/QR na central. P1 permanece **não homologado externamente** até a jornada controlada na caixa exclusiva, após release autorizada. Os 24 cenários da [matriz do programa](2026-10-05-broker-programa-baseline.md) continuam como critérios de homologação por perfil.

## Preparação para release

1. Confrontar candidato, main remota e imagens efetivas; conservar a evidência do servidor separada da configuração declarada.
2. Conferir migrations aplicadas. Este candidato exige baseline `0044_attendance_resume_operations`; os patches locais 0042/0043 também não podem ser presumidos instalados.
3. Provar backup/restore de PostgreSQL, Redis, mídia e sessão Evolution em laboratório antes de promover.
4. Aplicar migrations pela identidade de migração e atualizar API/web/workers como conjunto compatível. Conferir a flag não secreta `AUTOMATION_RUNTIME_V2_ENABLED` nos processos pertinentes.
5. Verificar a caixa exclusiva, origem/conta/inbox, autoatribuição e saudação desligadas e ausência de outro AgentBot. Testar mensagem nova, menu, destino real, resposta humana e retomada escolhida.
6. Guardar commit/digests, journal, configurações não secretas, IDs de correlação sanitizados e esperado/observado por camada.

Retorno: pausar o runtime antes de trocar binários, preservar o journal e todas as operações incertas. Não remover 0044 nem apagar históricos como rollback. Retornar somente a um binário comprovadamente compatível com o schema presente; a compatibilidade deve ser testada com o baseline instalado real. Nenhuma promoção ou rollback de produção foi executado nesta sessão.
