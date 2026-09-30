# Broker-first — evidência de desenvolvimento

Data: 30/09/2026. Este registro acompanha a implementação local; **BROKER_READY ainda não foi atingido**. Não houve publicação, deploy, exclusão de clientes reais ou envio de mensagens externas nesta execução.

## Base e ambiente

- Branch: `codex/broker-first-completion-20260930`.
- Base: `9466f6a6587034d8b09e1d1f180e2c51d38799fe`; alterações ainda não commitadas neste ponto.
- Node local 24.16.0; o repositório/CI exige 24.19.0. A homologação final deve usar o runtime declarado.
- PostgreSQL 16.4 e Redis 7.4.3 locais, bancos descartáveis e dados sintéticos. Provedores remotos substituídos por adaptadores controlados nos testes.
- Produção e centrais reais não são alvos dos testes abaixo.

## Verificações executadas

| Verificação | Resultado observado | Limite da evidência |
| --- | --- | --- |
| Baseline antes das alterações: npm test | 222 arquivos / 1.423 testes passaram | Resultado da base, não da implementação final |
| Baseline typecheck, build e análise do bundle | Passaram; bundle sem findings | Devem ser repetidos na revisão final |
| U2 canvas — testes focais | 25 passaram | Roda/arraste, histórico, IDs e posições |
| U2 canvas — Playwright | Desktop e celular: 2 passaram | Grafo de 150 nós, editar/salvar/recarregar/exportar e pan |
| A1 grupos — UI / integração | 7 UI e 15 de integração passaram | Renomear/remover grupo preservando empresas e recursos |
| A1 grupos — Playwright | Desktop e celular: 2 passaram | Jornada administrativa com dados sintéticos |
| R3a catálogo — cliente/HTTP | 10 passaram | DTO, protocolo e autorização de consulta |
| R3a catálogo — integração final focal | 9 passaram | Isolamento, revisão de destino/credencial, time e agente |
| U1 após correção da revisão — testes focais | 32 passaram; quatro regressões reproduzidas antes da correção | Subfluxo ausente/recursivo, ID distinto ou em colisão com a raiz |
| U1 — jornada nativa e transição legada | 2 arquivos / 4 testes de integração passaram | Compatibilidade verificada antes de iniciar R1b |
| Integração conjunta R1a/A1/R3a/lifecycle/platform | 7 arquivos / 42 testes passaram | Inclui banco vazio/upgrade; não cobre ainda R1b/c |
| Typecheck integrado inicial | Passou | Antes das correções finais de revisão U1/A3 |
| Primeira suíte npm test integrada | 227 arquivos: 1.460 passaram e 11 falharam | Inventário das quatro rotas novas e manifesto de duas migrations ainda não atualizados naquele momento |
| Repetição dos seis arquivos afetados após correção | 39 testes passaram | OpenAPI, inventário de segurança, artefatos/PDF e manifestos; suíte inteira ainda precisa ser repetida |
| Contratos públicos / avisos de terceiros | Passaram | Checagens locais dos scripts existentes |

## Estado das entregas e revisão

- **B0:** baseline e preservação do checkout documentados. Reconciliar ancestralidade com main antes de publicar.
- **R1a:** armazenamento de proprietário/sessões e constraints implementado, revisado e testado. **R1b/c pendentes:** unificar escritores e reconciliar executor remoto.
- **R3a:** catálogo e validação de destino humano revisados. OpenAPI/inventário integrados. **R3 permanece aberto:** eventos de controle, criação pending e comprovação das capacidades remotas.
- **U2 e A1:** revisão aprovada e E2E aprovado; aguardam gate integrado do candidato.
- **U1:** catálogo/diagnósticos implementados e re-revisão aprovada após corrigir ID de erro de subfluxo fora do grafo raiz. Gate integrado do candidato permanece pendente.
- **A3:** fila/filtros/primeira resposta/auditoria e correções de revisão aprovadas. UI 10/10; matriz de três empresas contra schema 0037 passou, incluindo suspensão com JWT de OWNER emitido antes dela, revogação e negação de exclusões a SUPPORT. E2E de suporte repetido após as correções: desktop/mobile 2/2 passaram em 20,7 s. Gate global do candidato permanece pendente.
- **A4:** catálogo comercial versionado implementado e revisado: 26 testes de integração e 28 UI/unit passaram; revisão independente repetiu 9 testes de integração. Regressão de downgrade concorrente no caminho Flow legado segue com R1b antes do aceite transversal final.
- **U3a parcial:** menus, perguntas e seletor de campos passaram nos testes focais (48 antes das correções de revisão; 18 após) e E2E desktop/mobile de criação sem JSON (2/2). Revisão aprovada; destino humano aguarda R4.
- **R3b parcial:** classificador tem 30 casos e revisão do formato upstream 4.16.2; ainda não integrado ao webhook, às barreiras de execução ou aos ciclos. Não prova assunção humana em runtime.
- **A2a:** operação agregada de exclusão explícita de empresas em desenvolvimento; nenhuma exclusão real foi executada.
- **R2a parcial:** regressões confirmaram truncamento em 4096 caracteres e perda de tipos. Estado versionado JSON implementado com limites explícitos de 65536 bytes por valor e 262144 bytes por estado; 30 testes focais passaram antes dos testes adicionais de I/O/esperas. Serialização de sessão, causalidade de efeitos e integração de controle humano continuam pendentes.
- Demais tarefas R/U/A seguem o plano aprovado. Módulos E1–E4 condicionados a BROKER_READY.

## Gates ainda abertos

Suíte integrada final, integração/Playwright final, build/compiled, runtime da CI, imagem real, restore drill, carga, homologação QR/Meta e das centrais JRC/Chatwoot externo. Testes com adaptadores controlados não comprovam entrega WhatsApp real, transferência humana real nem compatibilidade de uma instalação específica.

Docker local: cliente 29.5.2 e contexto desktop-linux detectados. Consulta ao daemon em 30/09 expirou após 15 segundos; o processo de consulta foi encerrado. Docker Desktop/containers não foram reiniciados. Imagem e restore drill continuam sem evidência neste ambiente.

Referências: [plano principal](../superpowers/plans/2026-09-29-broker-first-completion.md), [baseline](broker-first-baseline.md), [catálogo da central](../integrations/chatwoot-attendance-catalog.md).
