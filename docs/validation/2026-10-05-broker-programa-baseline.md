# Evidências iniciais e matriz de homologação

Data: 05/10/2026. Documento de acompanhamento; resultados não preenchidos permanecem pendentes.
[Plano](../superpowers/plans/2026-10-05-broker-programa-integracao.md).

## Evidência de código nesta sessão

Esta seção preserva a fotografia da sessão de planejamento. A execução posterior de P1, suas alterações e testes estão no [registro da retomada coordenada](2026-10-05-broker-retomada-coordenada.md); não reutilizar os 27 testes abaixo como contagem atual.

- Worktree image-release-20260924; HEAD eb577ac; branch codex/broker-ura-reset-integration-20261005.
- Código de produto não foi alterado nesta sessão de planejamento.
- Há backup local não versionado, preservado.
- Foram inspecionados AGENTS, scripts, planos de setembro, contratos e implementações de catálogo, controle, retomada antiga e normalização QR.
- A passagem BOT em messaging/service.ts não coordena o controle remoto.
- O normalizador QR descarta fromMe e grupos; os testes atuais fixam essa exclusão.
- URA/reset locais não equivalem a implantação.
- Não houve nova consulta ao servidor, aos digests efetivos ou ao journal nesta sessão.

## Teste executado nesta sessão

Comando:
```text
npm test -- apps/api/tests/unit/qr-events.test.ts apps/api/tests/unit/attendance-manual-takeover.test.ts apps/api/tests/unit/automation-handoff-reconciliation.test.ts apps/api/tests/unit/automation-handoff-readiness.test.ts apps/api/tests/unit/chatwoot-compatibility.test.ts packages/contracts/tests/attendance-v1.test.ts
```

Resultado: seis arquivos, 27 testes aprovados, duração Vitest 5,23 s.
A primeira tentativa falhou antes de carregar os testes por Acesso negado do esbuild no sandbox. A repetição autorizada fora dessa restrição passou.
Esse conjunto verifica o comportamento existente; não contém a futura correção de retomada, grupos ou saída do aparelho.
Suíte completa/build/integrados/E2E não foram repetidos nesta sessão de documentação. Resultados antigos estão no relatório URA/reset, com suas limitações.

## Evidência anterior fornecida/observada nesta conversa

- Probe remoto informou baseline 0041 compatível; não comprova journal completo.
- Runtime true e heartbeats UP foram informados no diagnóstico.
- Execução real ficou QUEUED, zero tentativas, permissão local true, gate remoto HUMAN/allowed=false, sem attendance_sessions.
- Central JRC mostrava conversa atribuída a humano, autoatribuição da caixa ligada e nenhum AgentBot selecionado. Não prova causa única do estado HUMAN.
- Configuração de imagens foi fornecida; conferir containers efetivos e migrations continua pendente.
- O teste de seis nós publicado imprimia opções, sem transferência real.
- Inspeção anterior da UI do host mostrou 4.16.2/build80f7305; UI não comprova digest.

## Perfis de teste

S0 Broker independente com transporte Broker.
J1 JRC tenant A com transporte Broker.
J2 JRC tenant B com transporte Broker.
E1 Chatwoot externo com transporte Broker.
C1 Central com transporte próprio, runtime Broker.
G1 Grupos habilitados no provedor e no adaptador compatível.
V1 Voz habilitada no número/provedor/central compatível.

Versões externas suportadas serão registradas pela prova de laboratório; não inventar faixa de versões.

## Matriz obrigatória

| ID | Cenário | Perfis | Resultado esperado | Estado |
| --- | --- | --- | --- | --- |
| H01 | Criar número/caixa e verificar identidade | S0/J1/J2/E1 | Vínculo correto, sem segredo na UI | PENDENTE |
| H02 | Menu criado visualmente | S0/J1/J2/E1/C1 | Publicado e executado na versão fixada | PENDENTE |
| H03 | Mensagem inválida e timeout | Todos com Flow | Saída prevista, sem loop | PENDENTE |
| H04 | Handoff para time/agente | S0/J1/J2/E1/C1 | Destino válido e bot suspenso | PENDENTE |
| H05 | Resposta humana simultânea | S0/J1/J2/E1/C1 | Sem novo envio automático após bloqueio confirmado | PENDENTE |
| H06 | Retomar: continuar/menu/nova | S0/J1/J2/E1/C1 | Ciclo correto e confirmação explícita | PENDENTE |
| H07 | Conversa legada sem sessão | J1/E1 | Nova sessão explícita; sem reproduzir passado | PENDENTE |
| H08 | Resolução e nova mensagem | S0/J1/J2/E1/C1 | Respeita política nova/reaberta | PENDENTE |
| H09 | Duplicatas e eventos fora de ordem | Todos | Histórico único e estado não regressivo | PENDENTE |
| H10 | Eco antes/depois do ACK | S0/J1/E1 | Sem duplo envio ou falsa origem humana | PENDENTE |
| H11 | Mensagem pelo aparelho e mídia | S0/J1/E1 | Registro único e espelhamento esperado | PENDENTE |
| H12 | Duas mensagens rápidas e reinício | Todos com Flow | Ordem, espera e versão preservadas | PENDENTE |
| H13 | HTTP incerto/central fora do ar | J1/J2/E1/C1 | Bloqueio explicado, reconciliação sem retry cego | PENDENTE |
| H14 | Account1/Inbox1 em hosts diferentes | J1/E1 | Isolamento absoluto de dados e jobs | PENDENTE |
| H15 | Token/grant revogado, tela aberta | Todos | Próxima operação negada | PENDENTE |
| H16 | Webhook falso/replay e URL interna | Todos integrados | Rejeição e auditoria sem segredo | PENDENTE |
| H17 | JSON JRC e n8n incompatível | Todos com Flow | Remapeamento/erro; publicação inválida negada | PENDENTE |
| H18 | Grupos por conexão/participantes | G1 | Opt-in e autoria correta, sem mistura entre tenants | PENDENTE |
| H19 | Chamada real | V1 | Permissão, toque, áudio bidirecional, término e histórico | PENDENTE |
| H20 | Backup/restore e backlog | Todos | Recuperação verificável, UNKNOWN preservado | PENDENTE |
| H21 | Flow/QR pela central | J1/J2/E1 compatível | Mesmo contrato, runtime e grants | PENDENTE |
| H22 | Limites/suspensão/lifecycle | Todos | Efeitos indevidos bloqueados, remoto preservado | PENDENTE |
| H23 | Upgrade e rollback de release | Todos | Schema/binário compatíveis e retorno documentado | PENDENTE |
| H24 | Mais de um usuário/empresa na UI | S0/J1/J2/E1 | Caches e permissões reavaliados | PENDENTE |

## Registro por execução

Registrar ID Hxx, perfil, data, commit, digests, journal, flags não secretas, origem do teste, correlação sanitizada, esperado, observado, resultado e incidente.
Valores: PASS, FAIL, BLOCKED, NOT_RUN. NOT_APPLICABLE exige escopo explícito do perfil; não encerra uma capacidade ainda solicitada.
Evidências de dispositivo e conversa real ficam em armazenamento restrito; no Git apenas resumo sanitizado.
Não anexar dumps de ambiente, payloads de clientes ou chaves.

## Próximo marco

P1 local: implementação e verificação no registro específico vinculado; fechar candidato antes de promover.
P1 externo: candidato implantado por release autorizada + conversa controlada com transferência real.
P10: repetir jornada na interface Flow/QR integrada antes de aceitar experiência final.
