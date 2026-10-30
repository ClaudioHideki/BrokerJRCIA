# 08 — Design system JRC: base existente e evolução proposta

Inventário local, 30/10/2026. Não cria nova identidade oficial. O repositório já fornece tokens e um logo local; este documento distingue o que foi observado da orientação de implementação.

## Identidade existente

`apps/web/public/brand/ORIGIN.md` registra o logo `logo-jrc-2024.png`, origem `jrcpabx.com.br`, consulta em 06/09/2026 e hash. O hash do arquivo local foi recalculado nesta auditoria e coincide: `A86A302527E488E2297D578C8DFC0E285A93EA0512CD663C78D933D0F8B15692`. A atribuição de “fonte oficial” é a registrada nesse arquivo; não houve validação web atual nem novo manual de marca recebido. `AppShell.tsx` usa o logo com alt “JRC PABX” e título “JRC Broker”.

Tokens centrais: `packages/ui/src/tokens.ts`; exportação: `packages/ui/src/index.ts`; aplicação: `apps/web/src/app/App.tsx` em `jrcCssVariables`. O pacote hoje é essencialmente tokens, não uma biblioteca pronta de componentes React.

| Papel | Token observado |
|---|---|
| Primária | `#007392` |
| Secundária | `#2CB4F1` |
| Destaque | `#FDD704` |
| Títulos/texto | `#153243` |
| Texto secundário | `#45616D` |
| Superfície / superfície suave | `#FFFFFF` / `#F4F7F8` |
| Borda / foco | `#B8C6CB` / `#005FCC` |
| Sucesso / alerta / perigo | `#0F766E` / `#8A5200` / `#B42318` |
| Fonte | Inter, ui-sans-serif, system-ui e fallbacks do sistema; presença do nome não prova download da fonte. |
| Tamanhos | xs 0,78rem; sm 0,85rem; bodySmall 0,9rem; base 1rem; lead 1,4rem; display 2,3rem. |
| Espaços | Escala existente entre 0,25rem e 2,5rem, com nomes semânticos adicionais. |
| Raios | 0,35rem; 0,55rem; 0,75rem; 1rem; pill. |
| Sombras | sm/md/lg de baixa opacidade, definidas no pacote. |

Não introduzir azul de outro produto, mascote, logotipo novo, claim “Broker2 oficial” ou cópia de layout/ícones proprietários. Evolution/Ligo/Chatwoot podem informar jornadas, sem mudar a propriedade do produto JRC.

## Componentes existentes a consolidar

| Primitiva ou composição | Origem atual | Direção |
|---|---|---|
| PageHeading, Metric, DataState, Period | `apps/web/src/broker/components.tsx` | Reusar no piloto. Evoluir contexto do cabeçalho e fontes dos indicadores posteriormente. |
| Navegação e contexto | `layout/AppShell.tsx`, `layout/PlatformShell.tsx` | Preservar empresa/papel e separação staff. |
| Avisos, botões, formulários | `app/console.css`, `app/platform.css` | Usar variantes existentes, com linguagem consistente. |
| Status de conexão | `connections/components/ConnectionStatus.tsx`, `integrations/ConnectionHealthSummary.tsx` | Não reduzir múltiplas dimensões a um LED. |
| Diagnóstico de entregas | `integrations/DeliveryDiagnostics.tsx` | Reutilizar sem ações de mutação no contexto de saúde. |
| Estados de tela | `broker/components.tsx`, páginas | Padronizar carregamento, erro, vazio e desatualizado, sem esconder diferença entre ausência de dados e zero válido. |

## Linguagem semântica recomendada

| Estado | Uso correto | Apresentação proposta |
|---|---|---|
| UP | O sinal específico satisfez a regra do backend. | Texto contextual: API respondendo, heartbeat recente, destino configurado. Verde só para o significado comprovado. |
| DEGRADED | O sinal demanda atenção. | Âmbar, nome e ação; não chamar todos de indisponíveis. |
| DOWN | O componente consultado falhou ou heartbeat venceu conforme contrato. | Vermelho, alcance e horário; não assumir queda integral da empresa. |
| UNKNOWN | Sem evidência suficiente. | Neutro/âmbar com “Não observado”; nunca equivaler a zero/saudável. |
| FAILED | Registro teve resultado de falha. | “Entrega com falha” ou “Execução com falha”, com entidade e período. |
| UNKNOWN de operação | Resultado externo incerto. | “Resultado incerto”; conferir antes de repetir. |
| Desatualizado | A consulta mais recente falhou ou está fora da política de frescor. | Aviso separado do estado previamente retornado, com última consulta válida. |

A cor sempre acompanha texto. “Não configurado”, “não observado”, “não autorizado”, “indisponível” e “sem registros” são conceitos diferentes. “Operacional” não significa entregue. Datas devem indicar o que foi medido, usando locale pt-BR e timezone contextual; datas sem valor ficam “Ainda não observado”. Não trocar timestamp de observação por horário da renderização.

## Padrão do piloto

Cabeçalho: “Saúde operacional”, descrição curta, Atualizar. Resumo: resultado recebido, consulta em horário legível e advertência de frescor quando necessário. Grupos em seções com títulos; componentes em cartões compactos com nome, estado textual, métrica/unidade, limite do sinal e link real. Alertas priorizados antes da lista completa. Código técnico disponível sem dominar o título.

Usar `--jrc-*` em CSS escopado. Empilhar cartões em viewport estreito; links/botões acessíveis por teclado e foco visível. Evitar tabela larga para leitura primária em celular; se necessária, usar contêiner de rolagem e cabeçalhos. Contagens longas e códigos técnicos devem quebrar linha. Estados de atualização não devem deslocar foco nem desmontar a navegação.

Não adicionar mapas, velocímetros, gráficos de disponibilidade ou séries de latência sem dados correspondentes. Não gerar percentual de saúde a partir de contagem de componentes. Não somar execuções, mensagens, jobs e destinos como se fossem a mesma unidade.

## Acessibilidade e consistência a verificar

O CSS atual já possui `:focus-visible` e o shell usa ARIA/teclado. A melhoria deve ser verificada com: contraste de cada combinação real; ordem de títulos; nomes acessíveis; leitura de alertas; zoom 200%; teclado; layout a partir de 320px; conteúdo longo; estados vazios e erro. Tokens não são prova suficiente de conformidade.

`broker.css` usa diversos valores literais e estilos `.health-*`; gráficos em `broker/components.tsx` também têm cores próprias. Corrigir na superfície piloto primeiro; não transformar uma etapa de diagnóstico em reescrita global. A suíte `packages/ui/tests/tokens.test.ts` verifica exportações/valores, não aparência ou usabilidade.

## Governança proposta

Uma única fonte de tokens; componentes promovidos a `packages/ui` somente quando têm consumidores e API estável; exemplos de estados e acessibilidade junto do componente; revisão visual para mudanças globais; rótulos orientados a tarefas em português. Nome, identidade e claims comerciais novos exigem material de marca ou decisão explícita, não inferência desta pesquisa.
