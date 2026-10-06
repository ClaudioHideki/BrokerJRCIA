# P2 B — Times, agentes e atribuição manual no Broker

Incremento na branch `codex/broker-p2-modes-catalog-20261005`, sobre P2 A e a correção de segurança da main `4fe35badb475ff5d5ea69b3c91b198b5731a5f29`. Não encerra P2 C–E, nem comprova implantação ou homologação externa.

## Comportamento entregue no código

- Diretório local por organização, times ativos/arquivados e membros elegíveis OWNER/ADMIN/OPERATOR. VIEWER e identidades desativadas não recebem novas transferências. IDs UUID locais permanecem separados dos IDs numéricos da central.
- Migração 0045 com RLS FORCE, FKs compostas, projeção estreita de usuários, locks de elegibilidade e catálogo de exclusão de tenant. O papel da aplicação não recebe SELECT em users.
- Publicação, vínculo e transferência revalidam canal, ausência de autoridade central, time e agente. Transferir para time vazio ou agente revogado retorna diagnóstico local; não confirma entrada na fila nem atendimento humano.
- Transferência grava o destino com WAITING_HUMAN e recibo na mesma transação. Atribuição manual exige o ID exato da sessão e sua revisão, prevenindo confirmação de um ciclo posterior com a mesma revisão. Operador assume apenas a si próprio; administrador pode selecionar fila, time ou agente.
- Administração de times exige revisão e permissões atuais. Remover um membership referenciado desativa-o, preservando histórico/FKs; um membership sem referências continua sendo removido fisicamente. A elegibilidade é revogada imediatamente em ambos os casos.
- Editor oferece os destinos do catálogo autorizado e limpa IDs incompatíveis ao trocar de canal. O painel de Conversas permite gerenciar times e consultar/assumir a fila explicitamente.
- A conversa confirmada abre por ID, sem depender da página de 100 conversas. Histórico e rascunho anteriores são limpos. Seleção posterior, outra atribuição ou troca de tenant/canal invalidam respostas atrasadas do POST e do GET. Identidade/canal divergentes impedem abertura e deixam o compositor fechado.
- Atribuição não retoma o bot. A retomada coordenada existente encerra o ciclo humano e cria um ciclo sem os destinos locais anteriores, preservando o histórico resolvido.

## Evidências locais em 06/10/2026

| Verificação | Resultado observado |
| --- | --- |
| Diretório, prontidão estrutural, administração/atribuição, último OWNER e handoff | 65 cenários PostgreSQL aprovados em rodadas focadas: 12 + 14 + 8 + 8 + 23 |
| Retomada, concorrência, lifecycle, upgrade e exclusão de tenant | 33 cenários PostgreSQL aprovados |
| Navegação final após revisão, POST/GET atrasados e painel local | 31 testes UI aprovados |
| Rodada anterior da consulta por ID, duas atribuições, carga inicial e diagnósticos | 87 testes HTTP/UI aprovados; complementados pela rodada de 31 acima |
| Build/typecheck e OpenAPI | Aprovados na árvore final após o ajuste de intenção do POST |
| Bundle e contratos públicos | 11 arquivos, nenhum achado; contratos PASS na árvore final |
| Suíte completa `npm test` da árvore final | 268 arquivos e 1.770 testes aprovados, 319,72 s; rodada final em 06/10/2026 às 11:55 |
| Revisão independente | Bloqueios de FK/remoção, CAS entre ciclos e navegação corrigidos; sem bloqueios restantes na leitura final, condicionada aos gates |

TDD registrou falhas antes das correções para permissões/FKs, APIs inexistentes, destino revogado, identificação de sessão, editor, navegação e diagnósticos. A rodada conjunta de cinco suítes de integração teve timeout no beforeAll da prontidão estrutural: 48 passaram e 14 não executaram nessa rodada. A prontidão foi repetida separadamente junto com a jornada e os 14 cenários passaram; não foi considerado PASS o timeout.

As três jornadas integradas QUEUE/TEAM/AGENT usam motor e PostgreSQL reais, com confirmação de transporte sintética explicitamente identificada: menu → captura → transferência → resposta humana → retomada pelo menu. Enfileirar uma mensagem não confirma sua entrega real. Não houve nova execução da suíte E2E completa local recusada anteriormente.

## Limites e próxima etapa

Migração 0045 e P2 A/B não foram implantados nem estão nas imagens da main `4fe35ba`. Essas imagens corrigem o audit de source-map-js e mantêm P1/vínculo. P2 permanece candidato separado até validação e integração.

Faltam modos/onboarding observados (C), transporte central/revogação (D) e homologação externa (E). Os tenants JRC A/B e a instalação externa serão configurados ao final, conforme [guia de homologação](2026-10-06-broker-preparacao-homologacao.md). Implantação será orientada para execução pelo usuário no Dokploy.
