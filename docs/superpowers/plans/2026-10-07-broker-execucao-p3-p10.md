# Broker — execução integrada P3 até P10

> **For agentic workers:** Use superpowers:executing-plans e TDD. Auditorias independentes podem ocorrer em paralelo; implementação que compartilha contratos, migrations ou banco de teste deve ser coordenada. Reutilizar este checkout e publicar somente a main, conforme autorização do usuário.

**Goal:** Executar os incrementos restantes do programa aprovado, reduzindo trabalho repetido sem substituir homologação real por simulação.
**Architecture:** Preservar o motor único, os adaptadores existentes e os contratos versionados. Separar entregas independentes para revisão/testes em paralelo, integrar por incremento funcional e registrar evidências por ambiente.
**Tech Stack:** Stack vigente; nenhum upgrade geral ou nova dependência neste primeiro incremento.
**Spec:** ../specs/2026-10-05-broker-independente-centrais-design.md.
**Programa:** 2026-10-05-broker-programa-integracao.md.

## Restrições globais

- Um executor por caixa; RLS e autorização vigente em todas as operações.
- Nenhum HTTP dentro de transação; UNKNOWN exige reconciliação.
- Preservar a conexão física de testes do Welton.
- Cada entrega: teste RED/GREEN, suíte obrigatória, revisão, main, CI e imagens do mesmo SHA.
- Suites de navegador somente no CI, conforme decisão anterior; testes locais pertinentes continuam obrigatórios.
- Instalação no Dokploy é operada pelo usuário, com guia e migrações explícitas.
- P6 requer áudio real bidirecional e ativos elegíveis; botão/evento de chamada não fecha a fase.
- P10 requer jornadas reais nos perfis finais; nenhum resultado BLOCKED/SKIPPED conta como PASS.

## Ordem coordenada

| Frente | Trabalho | Dependência/critério |
| --- | --- | --- |
| P3 | Inventário das famílias; completar espera/simulação, horário, ações/mídia, HTTP/IA delimitados e JSON | Reutilizar executor, UI e testes existentes; cada nó anunciado precisa funcionar |
| P4 | Observação persistida de fromMe, correlação de ecos e espelhamento sem reenvio | Interromper bot apenas com origem humana confirmada; testar antes/depois do ACK |
| P5 | Grupos por conexão, participação, opt-in e limites | Depende da identidade/autoria e deduplicação P4 |
| P6 | Matriz real de capacidades e prova de voz, depois controlador | Credenciais/ativos/provedor e central compatíveis; não presumir Evolution com áudio |
| P7 | Regressões e lacunas concretas de administração | Sem reconstruir módulos já entregues |
| P8 | Instrumentação, carga lógica, pools, storage privado e distribuição QR | Registrar hardware/topologia e carga antes de declarar capacidade |
| P9 | Flow/QR delegados e navegação do host | P8 por perfil; comparar fonte e imagem instalada do JRC antes de editar o host |
| P10 | Pacote reproduzível de aceite e piloto real | Instalação, fixtures JRC A/B e Chatwoot externo, jornada cliente depois de P9 |

As frentes podem ser investigadas em paralelo; estados/migrations e publicação são coordenados. Não há data de conclusão ou capacidade comercial comprovada apenas por este plano.

## Foco da revisão

1. TIMER antecipado ou repetido não envia uma resposta antes da espera nem duplica uma execução.
2. Avançar relógio no simulador não grava mensagem, timer, outbox ou evento real.
3. Execução histórica sem prazo no estado conserva sua compatibilidade.
4. Troca de tenant ou erro HTTP durante a simulação não apresenta resultado como entrega real.
5. Mensagem humana e timer concorrentes mantêm a autoridade humana nos workers existentes.

## Task 1: espera e simulação virtual completa

**Files:** contracts `automation-node-definitions.ts`; API `automations/{engine,types,simulation,service}.ts`, rota `automations.ts`; Studio e testes adjacentes; documentação de capacidades; OpenAPI gerado.
**Interfaces:** `simulateConversation(root, {text, replies?, events?, clock?}, resolve)` usa o executor canônico. Eventos são `MESSAGE` com texto ou `ELAPSE` com segundos inteiros de 1 a 604800, até 30 eventos. `replies` continua compatível e não pode coexistir com `events`. Nenhum adaptador externo é recebido.

- [x] RED: esperar, avançar parcialmente, receber mensagem durante espera, avançar até o prazo e preservar variáveis/ordem; TIMER antecipado após JSON round-trip não libera resposta; IO continua sem rede.
- [x] Implementar prazo opcional no estado de espera para novas execuções JSON, preservando estado histórico; simulador mantém relógio virtual e dispara TIMER apenas ao vencer prazo.
- [x] API valida o contrato, limita passos e autoriza rascunho; Studio permite avançar a espera e reconstruir a conversa simulada sem tempo real ou efeitos externos.
- [x] Disponibilizar delay apenas após contrato, executor, formulário, simulador e testes passarem.
- [x] Testar reinício/deduplicação de timer com PostgreSQL e autoridade humana; executar suites pertinentes e checks de release locais. CI/publicação permanecem no item seguinte.
- [ ] Revisão independente; commit/main, CI e imagem exata; registrar limites da homologação real.

## Task 2: inventário e próximos incrementos

- [x] Consolidar auditorias P3, P4–P6 e P7–P10 com caminhos de código e testes, distinguindo implementado, testado, publicado e homologado.
- [x] Detalhar o próximo incremento de cada frente a partir de lacunas confirmadas, mantendo os critérios do programa mestre: [roteiro de 08/10](2026-10-08-broker-proximos-incrementos-p3-p10.md).
- [x] Atualizar o registro de avanço sem marcar uma fase completa por componentes internos.

## Task 3: implantação e aceite externo

- [ ] Registrar imagens efetivas, journal, flags e recuperação da infraestrutura instalada.
- [ ] Aplicar entregas via Dokploy e verificar schema, workers, transporte e jornada Welton real.
- [ ] Preparar fixtures finais JRC A/B/Chatwoot externo sem credenciais em Git e repetir jornada após interfaces P9.
- [ ] Fechar P10 somente com evidências reais por perfil/versão e incidentes do piloto resolvidos.
