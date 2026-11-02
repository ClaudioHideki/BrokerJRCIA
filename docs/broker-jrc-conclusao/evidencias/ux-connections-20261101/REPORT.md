# Incremento de usabilidade do detalhe de conexão — 01/11/2026

Base inspecionada: branch `codex/broker-jrc-2-redesign-homologacao-20261030`, HEAD `b076e05`. Implementação local, sem commit, push, deploy, mudança de banco, envio de mensagem ou chamada a produção.

## Entrega

`InstanceWorkspace`, utilizado por `/channels/:id` e `/legacy/conexoes/:id`, agora apresenta quatro áreas independentes:

- Sessão WhatsApp: estado registrado, disponibilidade da leitura do serviço e horários de registro/consulta. A consulta disponível não é tratada como sessão ativa nem entrega confirmada.
- Identidade observada: perfil/número retornado pelo serviço, explicitamente sem afirmar aprovação da identidade.
- Vínculo Chatwoot: informa que o vínculo não foi consultado por este painel e encaminha à página existente de Integrações para conferir caixa, identidade e ativação.
- Entrega: não infere sucesso de sessão conectada ou contagem sincronizada; encaminha às evidências de Integrações e ao diagnóstico de workers/filas em Saúde operacional. UNKNOWN continua exigindo conferência antes de repetir envio.

Contagens sincronizadas, configurações, histórico, permissões e controles de conexão existentes foram preservados. Os novos controles são links reais, de consulta. O CSS novo fica sob `.instance-workspace`, usa tokens existentes e organiza os cartões em duas colunas no desktop e uma no celular.

## Arquivos de produto e testes

- `apps/web/src/connections/components/InstanceWorkspace.tsx`
- `apps/web/src/connections/components/InstanceWorkspace.test.tsx`
- `apps/web/src/connections/components/instance-workspace.css`

Contratos conferidos: `apps/api/src/http/routes/instance-workspace.ts`, `apps/api/src/modules/instances/workspace.ts`, `packages/contracts/src/integrations/control.ts` e `apps/web/src/integrations/ConnectionHealthSummary.tsx`. O endpoint workspace retorna estado registrado, leitura do provider, perfil, contagens, settings e operações; não retorna aprovação de identidade, vínculo ou evidências de entrega. Não foi inventado endpoint, contador, estado verificado ou próxima tentativa.

## TDD e regressão local

RED antes da implementação: dois testes novos falharam pela ausência da região Sessão WhatsApp; os sete testes existentes passaram. Log: `../ux-connections-20261101-red.log`.

GREEN após implementação: **5 arquivos, 48 testes aprovados**, incluindo os dois novos. Log: `../ux-connections-20261101-green.log`.

Comando executado com Node 24.19.0:

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run apps/web/src/connections/components apps/web/src/pages/ConnectionDetail.test.tsx apps/web/src/pages/ChannelDetail.test.tsx --maxWorkers=2
```

Arquivos executados: InstanceWorkspace, ConnectionStatus, ChallengePanel, ConnectionDetail e ChannelDetail, total 48 testes. O resultado agregado é a evidência; testes das páginas mantêm os fluxos reais de pareamento, desconexão, abas, tenant e configurações.

`git diff --check -- apps/web/src/connections/components`: sem erros. Typecheck, build e regressão global ficaram com o executor principal, conforme divisão explícita do trabalho; este relatório não reivindica resultado desses gates nem reaproveita CI de b076e05 como prova do incremento novo.

## Navegador local e acessibilidade

`visual-check.mjs` usa a aplicação real servida por Vite em loopback com todas as chamadas `/v1` interceptadas por fixtures sintéticas. Não foi usada sessão ou conta real. Perfis OWNER e VIEWER, superfícies canônica e legada, 1440×1100 e 390×844: **8 cenários aprovados**.

Cada cenário verificou ausência de transbordamento nos cartões, ausência de pageerror, Tab do link de vínculo para o link de entrega e zero violações axe automatizadas na área nova, com tags WCAG2A/AA, 2.1AA e 2.2AA. Isso não certifica conformidade WCAG do produto inteiro.

Artefatos: `visual-results.json`, `visual-check.log` e screenshots `channel-*`/`legacy-*`. Inspeção visual realizada em desktop e mobile: hierarquia, quebra dos cartões e foco visível legíveis. Não há telefone, token ou conteúdo real nas capturas. Não foi capturada imagem anterior à mudança; comparação antes/depois completa permanece pendente.

## Limites e próximos passos

- Este incremento melhora a apresentação e a navegação operacional. A jornada de integração ponta a ponta não foi concluída nem testada contra serviços externos.
- O componente não consulta o estado Chatwoot diretamente; a informação permanece na tela de Integrações, que possui o contrato adequado. Na tela canônica, o resumo de destino já existente pertence ao componente pai e não foi alterado.
- Próxima tentativa, motivo de falha de entrega e evidências inbound/outbound/callback não constam do workspace; não são fabricados aqui.
- Não foram feitas validações com operadores, tecnologia assistiva real ou tema escuro do shell. A região nova usa tokens sem declarar que o tema inteiro já foi homologado.
- A revisão e os gates gerais do diff combinado permanecem com o executor principal.
