# Validação da refatoração — 15/09/2026

## Parecer

**Build e verificação de tipos aprovados. Suíte completa: 877 testes aprovados e 1 falha de metadados Git, em 114 arquivos de teste.** A console foi inspecionada no navegador em desktop e celular. Esta evidência permite revisar a entrega local; não equivale à homologação operacional do broker.

## Ambiente e base

- Windows, Node.js 24.19.0 e npm 11.17.0.
- Cópia isolada do ZIP de continuação; seus 1.064 arquivos coincidem por SHA-256 com as entradas correspondentes do ZIP maior.
- Dependências recuperadas do ZIP maior, com links locais dos workspaces e reconstrução offline dos executáveis. Não houve instalação limpa pela rede nesta sessão.
- Repositório Git local isolado na branch `codex/broker-refactor`, sem commits. O índice original e o histórico não vieram nos arquivos recebidos.
- Docker instalado, engine indisponível. Não havia PostgreSQL/Redis de teste configurados.

## Verificações executadas

| Verificação | Resultado |
|---|---|
| `npm run build` | Aprovado: TypeScript e Vite; avisos de comentários de anotação do Zod removidos pelo Rollup, sem falha |
| `npm run typecheck` | Aprovado |
| `npm test -- --maxWorkers=2` | 877 aprovados / 1 falhou; 113 arquivos aprovados / 1 falhou; duração de 99,34 s |
| Testes focados da refatoração | 159 aprovados em 25 arquivos; subconjunto da suíte, não soma adicional |
| Regressão do inventário/auditoria | 28 aprovados em 4 arquivos |
| Regressão do overview e HTTP | 5 aprovados em 2 arquivos, incluindo normalização de timestamp PostgreSQL |
| OpenAPI regenerada + teste HTTP/OpenAPI | 5 aprovados |
| `npm run test:web:bundle` | 3 arquivos inspecionados, nenhum achado |
| Ausência do cliente demo no JavaScript de produção | Nenhum dos marcadores de demonstração encontrado |
| `npm run security:contracts` | Aprovado |
| `npm run security:notices` | Aprovado, 7 pacotes do navegador |
| Whitespace dos arquivos alterados contra a base recebida | `git diff --no-index --check` sem erros de whitespace |

Os testes focados fazem parte da mesma entrega e vários também aparecem na execução completa. Eles não devem ser somados para produzir uma contagem maior.

### Falha restante

`tests/evolution-upstream.test.mjs:11` exige que `git ls-files --stage upstream/evolution-api` retorne um gitlink de modo `160000` para o commit `fa09d37892cdbb1d65a250155d293d92230c5b30`.

O código, as licenças, a URL oficial e o commit documentado estão presentes; o índice Git original não está. O teste foi mantido ativo e falhando. É necessário restaurar o submódulo no repositório original antes de liberar a release. O resultado geral de `npm test` continua com código de saída 1 por essa razão.

### Correções descobertas na validação

- O inventário de rotas usava localização textual restrita a chamadas em uma linha. Agora analisa a árvore sintática TypeScript, ignora comentários e encontra handlers formatados em várias linhas. A rota overview foi incluída no inventário de autenticação e isolamento.
- Timestamps retornados pelo JSON do PostgreSQL podem conter deslocamento de fuso; a API normaliza os timestamps de incidentes para ISO UTC antes de validar a resposta.
- Expectativa de navegação móvel e inventário OpenAPI foram atualizados para as novas rotas.

## Navegador e acessibilidade básica

Inspeção visual e navegação na demonstração local:

- Dashboard, conexões, detalhe, providers, provisionamento, Health Center, uso e custos, relatórios e Brain.
- Desktop com a largura natural do painel; teste móvel com viewport de 390 × 844.
- Menu móvel, foco após abrir/fechar, navegação e rolagem da tabela.
- A página móvel não apresentou overflow horizontal no documento; a tabela mantém sua própria rolagem.
- A prévia identifica dados simulados. Custos não configurados mostram indisponibilidade e o Brain informa que usa regras.

Essa revisão não constitui auditoria completa WCAG, E2E com backend real ou ensaio em todos os navegadores/dispositivos.

## Evidências de comportamento cobertas em testes

Autenticação e isolamento do novo endpoint; recusa de API key, período inválido e seleção de tenant pela query; agregação dos estados; séries UTC; falha de banco sanitizada; troca de empresa sem reaproveitar dados antigos; erros e estados vazios; CSV com aspas/BOM/delimitadores, duplicação e limite de tamanho; proteção da exportação contra fórmulas; permissões e interrupção de lote após falha/resultado incerto.

## Ainda não validado

- Consulta SQL nova em PostgreSQL real, RLS real, migrações e plano de execução/índices sob volume.
- Testes `test:integration`, E2E com banco, container, smoke Evolution e pipeline `ci:verify` completo.
- Pareamento Evolution, onboarding Meta, templates, webhook real ou envio/recebimento com número dedicado.
- Integrações WAHA e Twilio, que ainda não possuem adaptadores nesta entrega.
- Vulnerabilidades atuais via `npm audit`, carga, SLO, recuperação de backup e operação de produção.
- Custos financeiros conciliados, IA generativa, provisionamento persistente em background e equivalência completa com as nove telas de referência.

## Origem dos arquivos

SHA-256 dos insumos:

```text
8732b3e3678c22c0d5e56772b40b8a110064bfa02658c55a5417de581f89fdd6  JRC-WhatsApp-Broker.zip
0ef77df7c55b985341a26f5d61176ea9865d047128830244ba348b03455a01a6  JRC-WhatsApp-Broker-continuacao-20260914.zip
c87e1ef18d49a4fa1f7ef7eee1f307ba70a92763948bafbbd4f427b75bac367a  PLANO-MESTRE-JRC-BROKER.md
```

Consulte o [plano validado](PLANO-MESTRE-JRC-BROKER-v2.md) e o [guia de entrega](ENTREGA-20260915.md) para a sequência funcional e as instruções de execução.
