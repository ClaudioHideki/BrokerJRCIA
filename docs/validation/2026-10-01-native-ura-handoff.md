# Validação local: URA nativa e transferência confirmada

Data: 01/10/2026. Base imutável: `135bd952d0b782d33b22c8f5f88492586dee6f08`.
Branch local: `codex/native-ura-handoff-20261001`. Nenhum commit remoto, push,
merge, imagem, migration em produção ou alteração de configuração foi executado.

## Resultado de desenvolvimento

- Menu nativo escolhe destino humano pelo catálogo da mesma empresa/caixa
- Configuração versionada e validação de publicação, vínculo e execução
- Pausa persistente, abertura/atribuição e confirmação canônica remota
- Ledger por efeito, controle humano prioritário e conciliação somente leitura
- Upgrade aditivo 0041→0042, isolamento RLS/FKs e proteção de lifecycle
- Simulação e exploração de execução distinguem pedido, incerteza e confirmação

## Verificações executadas

Ambiente: Node.js 24.19.0, npm 11.9.0 e PostgreSQL 16.14 descartável em loopback.
Os testes da central usam HTTP sintético com o cliente real do Broker. Nenhuma
credencial ou conversa real foi usada.

| Verificação | Resultado |
| --- | --- |
| Build TypeScript + bundle Vite | Passou |
| Typecheck agregado | Passou |
| Suite Vitest geral, exceto arquivo Docker Compose | 251 arquivos / 1.679 testes passaram |
| Web (subconjunto da suite geral) | 57 arquivos / 356 testes passaram |
| Integração PostgreSQL focada e regressiva | 19 arquivos / 135 testes passaram |
| Workspace compilado | 1 passou; 1 teste de entrypoint real pulado por falta de Redis |
| OpenAPI gerado | Sem alteração no documento versionado |
| Bundle e contratos públicos | Passaram |
| Avisos de licenças e submódulo Evolution | Passaram |
| `git diff --check` | Passou |

A primeira execução geral detectou a expectativa antiga da migration final,
atualizada para incluir 0042. Quatro testes de `dokploy-compose-config.test.mjs`
não executaram a interpolação porque o executável Docker não existe neste
ambiente; o rerun geral excluiu apenas esse arquivo. Não são quatro testes aprovados.
O rasterizador fornecido pelo ambiente emitia erro de cache Fontconfig sem escrita;
a verificação PDF passou com o Poppler já instalado da distribuição e cache temporário,
sem modificar o teste ou o PDF. Não foram executados E2E com PostgreSQL+Redis,
build de containers, restore drill ou promoção de imagem.

A revisão focal cobriu a autoridade tenant/caixa, mutações, confirmação, incerteza,
callbacks, prioridade humana e migração. Nenhum bloqueador permaneceu nesse escopo;
essa avaliação não equivale a aceite de produção nem à auditoria integral do Broker.

## Cobertura funcional importante

- Menu → sessão persistida → outbox → worker → cliente Chatwoot → readback
- Time e agente reais no catálogo sintético; membros da caixa e alvo obsoleto
- Duas empresas com os mesmos IDs remotos numéricos sem cruzamento
- Credencial, destino, Inbox, owner, binding e sessão com revisão alterada
- Espera pelo recibo do transporte anterior, sem confundir aceite com envio
- Duas entregas concorrentes; crash antes/depois da criação do ledger
- Timeout na abertura e atribuição, restart e nenhuma repetição automática de POST
- Callback de abertura atrasado, humano durante HTTP e comando manual HUMAN→HUMAN
- Conclusão manual exata após abertura incerta, confirmada só por leitura remota
- Handoff antigo sem destino não produz confirmação fictícia; nova publicação e
  cutover alternativo não contornam a exigência de configuração

## Reprodução em ambiente autorizado

1. Use o checkout limpo da base indicada e aplique o patch depois de `git apply --check`
2. Inicialize os submódulos; use Node.js 24.19.0 e `npm ci`
3. Execute `npm run build`, `npm run typecheck`, `npm test`, `npm run test:web:bundle`
4. Com PostgreSQL de testes, defina `TEST_DATABASE_ADMIN_URL` e rode
   `npm run test:integration -- apps/api/tests/integration/native-handoff*.test.ts`
5. Repita as suites attendance, chatwoot-attendance, automations e legacy-owner
   relacionadas, além dos gates completos de CI no ambiente com Docker/Redis

## Etapas ainda necessárias para release

Tarefa separada autorizada: revisão do patch no repositório, CI completo com
Docker/Redis, backup, migration 0042 em homologação, imagens e workers compatíveis.
Depois, provar HTTPS e permissões em duas empresas de homologação: menu para time,
menu para agente, pausa humana, atraso de callback, timeout/restart e revogação.
Só então avaliar ativação controlada. O default de runtime continua `false`.

Stock Chatwoot não tem CAS de atribuição: persiste a pequena janela entre GET e
POST. Não há descarte forçado de operação incerta nem retomada automática; resultados
remotos diferentes ou contexto revogado podem exigir investigação e manter lifecycle
bloqueado. Ver [contrato e limites](../automations/native-handoff.md).
