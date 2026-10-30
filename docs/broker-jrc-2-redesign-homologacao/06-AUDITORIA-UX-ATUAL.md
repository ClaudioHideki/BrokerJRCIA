# 06 — Auditoria da UX atual

Data: 30/10/2026. Base: `BrokerJRCIA-source-audit/.worktrees/image-release-20260924`, HEAD informado pelo levantamento principal `d1b66a56fe6d4f9202969784301abdf61490db45`. Auditoria estática de código e contratos; nenhuma afirmação de validação visual, navegador, produção ou usabilidade com operadores. Este arquivo é um insumo de pesquisa; propostas não significam publicação.

## Parecer

O produto já possui um console de empresa, administração da plataforma, navegação pesquisável, abas de canal, editor de automações, integrações e diagnóstico. Não é necessário inventar um console novo para obter o primeiro ganho. O melhor piloto é qualificar a tela existente de Saúde operacional, preservando rota, autorização e contratos, e ligá-la ao diagnóstico de entregas existente.

Existência de tela/teste não demonstra maturidade operacional, publicação ou funcionamento ponta a ponta. Os resultados históricos de mensagens ou jobs não são incidentes atuais por definição.

## Pontos fortes comprovados no código

| Evidência | O que preservar |
|---|---|
| `apps/web/src/layout/navigation.ts`, `AppShell.tsx` | Registro central de destinos, busca sem acentos, seções recolhíveis, contexto da empresa/papel, breadcrumbs e troca explícita de organização. Menu mobile usa `inert`, Escape e restauração de foco. |
| `auth/guards.tsx`, `auth/SessionProvider.tsx`, `api/client.ts` | Restauração de sessão, seleção da organização, tratamento de expiração e respostas de tenant antigo. Navegação não substitui a autorização do servidor. |
| `pages/ChannelDetail.tsx:105–135` | Área de conexão com abas específicas por provider, navegação por teclado e separação entre WhatsApp, atendimento, Flow e histórico. |
| `integrations/ConnectionHealthSummary.tsx` | Sessão, destino, identidade e transporte aparecem separados; “Entrega verificada” exige os estados e evidências de entrada, saída e callback. |
| `integrations/DeliveryDiagnostics.tsx` | Consulta declaradamente sem reenvio; FAILED distinto de UNKNOWN; orientação para conferir resultado antes de repetir; schema parse e descarte de resposta antiga. |
| `broker/use-overview.ts`, `pages/Operations.tsx` | Resumo validado por schema; notas de período e diferença entre saída aceita e entrega confirmada; diagnóstico por regras declarado. |
| `pages/Settings.tsx` | Explica escopo de empresa/conexão/integração/deployment e reaproveita registro de navegação. |
| `packages/ui/src/tokens.ts` | Fundação de tokens já existe; não há razão para começar outra paleta ou biblioteca concorrente. |

## Achados e prioridades

| ID | Prioridade | Evidência estática e impacto provável | Ação e aceite |
|---|---|---|---|
| UX01 | Alta | `pages/OperationalHealth.tsx` descreve “Estado atual de cada camada” e apresenta todos os componentes com o mesmo padrão. `observability/service.ts` mistura consultas atuais, heartbeats, registros de conexão e contadores de todo o histórico. O operador pode confundir evidência com alcance diferente. | Explicitar fonte/tempo/limite por grupo. Um destino aprovado deve ser “configurado”, nunca prova de entrega. Contadores de jobs e execuções devem ser “registros com falha/incertos no histórico”. |
| UX02 | Alta | No health, só `UNKNOWN_EXECUTIONS` tem link específico; demais alertas terminam em “Verificar configuração e logs por correlação”. | Orientação curta por componente e links válidos a Integrações, Conexões, Execuções e Suporte, sem botão de replay neste piloto. |
| UX03 | Alta | Falha de refresh do health preserva `data` anterior junto do erro; não há marcador explícito de dado desatualizado. O polling a cada 30s não bloqueia requests sobrepostas. | Mostrar falha de atualização com horário da última consulta válida e estado desatualizado; impedir sobreposição e resposta tardia sobrescrevendo resultado novo. Cancelar/desconsiderar no unmount e na troca de contexto. |
| UX04 | Média | Health usa apenas interface TypeScript local em `request<Health>`, sem validação runtime; telas de canais, overview e diagnóstico já fazem parse. | Validar retorno antes de renderizar; respostas incompletas ou estados inválidos não devem produzir sucesso/zero nem quebrar a tela. |
| UX05 | Média | Health exibe códigos internos como conteúdo principal. A substituição `EVOLUTION` → `WHATSAPP_QR` não explica ação nem alcance. | Nome operacional, explicação e próxima ação; código técnico em detalhe secundário copiável/selecionável. Preservar o código original para suporte. |
| UX06 | Média | `DeliveryDiagnostics` recebe `firstSeenAt`/`lastSeenAt` no contrato, mas não exibe datas. A orientação não contém entradas para `CHATWOOT_HISTORY_UNSUPPORTED` e `CHATWOOT_HISTORY_UNAVAILABLE`, códigos já aceitos pelo schema. | Exibir intervalo de ocorrência e fallback explicativo para códigos novos; não interpretar `lastSeenAt` como recuperação/abertura de incidente. |
| UX07 | Média | `pages/Operations.tsx` / `BrainPage` ainda diz que caixa QR está em desenvolvimento, embora outras superfícies tenham canais, vínculos e transporte QR implementados. | Revisar texto por capacidade real e configuração. Não substituir por promessa universal de funcionamento. |
| UX08 | Média | `broker.css` contém cores e medidas literais, inclusive `.health-*` na linha 1381; `broker/components.tsx` inclui cores de gráficos literais. | Aplicar tokens existentes na área piloto; migração do resto por superfície, com comparação visual. Não trocar CSS global sem revisão. |
| UX09 | Média | “Configurações” lista praticamente todas as páginas; “Integrações” abre título “JRC Conversas”; “Health Center” aparece na plataforma enquanto tenant usa “Saúde operacional”. | Vocabulário por contexto e agrupamento por tarefa. Manter compatibilidade de URLs e busca de sinônimos. |
| UX10 | Baixa | `PageHeading` fixa “WORKSPACE / OPERAÇÃO” para todas as páginas consumidoras; breadcrumbs de detalhes usam nome genérico “Detalhes”. | Tornar contexto e título específico disponíveis de forma reutilizável em evolução posterior. |

Não foram medidos contraste efetivo renderizado, colisões de layout, desempenho do navegador, leitura por tecnologia assistiva ou taxa de sucesso de operadores. Tokens e ARIA no código são sinais positivos, não certificação WCAG.

## Semântica operacional que a interface deve conservar

- `API_RESPONDING` e `DATABASE_QUERY_OK`: consulta atual executada. Não demonstram capacidade ou recuperação.
- Heartbeat UP: worker observado dentro da janela (default no serviço: 45s). Não prova entrega final.
- QR/META: contagem de registros CONNECTED/READY. Não é sondagem independente de todas as sessões.
- CHATWOOT: destino aprovado e ausência de estado degradado consultado. Não demonstra envio e recebimento ponta a ponta.
- `INTEGRATION_FAILURES`/`INTEGRATION_UNCERTAINTY`: `integration_jobs`, sem filtro de período. Não confundir com `messaging_messages` nem com `partner_event_deliveries`.
- `QUEUE`: soma da outbox de mensagens com automações PENDING; não representa todas as filas do sistema. `OUTBOX_AGE` também considera automação UNKNOWN.
- `FAILED_EXECUTIONS`/`UNKNOWN_EXECUTIONS`: execuções persistidas; o código `UNKNOWN_GROWTH` não calcula crescimento temporal.
- UNKNOWN significa resultado não comprovado. Não equivale a “não enviado”. Não autoriza reenvio automático.
- “Nenhum alerta” só vale para os componentes/indicadores retornados. Endpoint indisponível, estado desconhecido ou fonte sem observação nunca é verde por padrão.

## Piloto recomendado e fronteira

Rota `/operations/health`, arquivo `apps/web/src/pages/OperationalHealth.tsx`, com CSS escopado e eventual modelo de apresentação local. Agrupar infraestrutura, processamento, canais/destinos e resultados de entrega. Exibir resumo das observações, instante da consulta, alertas priorizados, limites da medição e ações de navegação. Reutilizar `PageHeading`, tokens, estilos de aviso e contratos existentes. Links a `/integracoes`, `/channels`, `/automation-executions` e `/suporte` são reais.

O piloto pode permanecer somente leitura, sem backend novo. Não implementar replay, limpeza, reconexão, teste de mensagem, troca de configuração ou “corrigir tudo”. Não alterar limites de alerta (1000 itens/300s no código) por uma decisão de layout.

## Verificação necessária

Testes existentes identificados, não executados por este subtrabalho: `apps/api/tests/unit/observability.test.ts`, `apps/web/src/app/App.test.tsx`, `layout/navigation.test.tsx`, `integrations/DeliveryDiagnostics.test.tsx`, `integrations/ConnectionHealthSummary.test.tsx`, `packages/ui/tests/tokens.test.ts`. O health tem teste de roteamento, mas não foi encontrado arquivo próprio de testes de comportamento da página no inventário inicial.

Cobertura do piloto: infraestrutura UP com jobs FAILED mantém problema de entrega visível; UNKNOWN não oferece reenvio; componente ausente/inválido não vira zero; erro inicial e erro após sucesso; resposta fora de ordem; troca de tenant/unmount; teclado/nomes acessíveis; viewport estreito e desktop com dados longos. Homologação visual deve usar dados sintéticos, sem telefone, conteúdo, token ou produção.
