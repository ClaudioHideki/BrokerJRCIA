# Baseline da continuação de 977ab0e

Este conjunto documenta o diff local de 01/11/2026. A publicação anterior e os relatórios numerados permanecem históricos; não autorizam a promoção deste diff.

| Fonte | Evidência conferida nesta execução |
|---|---|
| Broker | `ClaudioHideki/BrokerJRCIA`, checkout existente `image-release-20260924` |
| Branch | `codex/broker-jrc-2-redesign-homologacao-20261030` |
| HEAD inicial | `977ab0eed78ac3ad1aac75f38e6bba723eb86db2` |
| PR #6 | Aberta, rascunho, HEAD remoto 977ab0e; base empilhada `codex/broker-audit-fixes-20261029` em `d1b66a56fe6d4f9202969784301abdf61490db45` |
| Main consultada | `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371` |
| Preservação | Nenhuma alteração rastreada inicialmente no Broker; auditoria, output e tmp não rastreados preservados. Nenhum patch antigo reaplicado. |
| LAB2 correto | `ClaudioHideki/jrc-conversas-lab2`; default `codex/cadastro-mestre-20261002`, fetch `128243d925617c08896a2a9448b2bb9f6e5da115` |
| Checkout LAB2 usado | `.worktrees/release-grupojrc-20261022`, HEAD `abc1f7c57f55a7d9871101cd5b70c8b93becc7ca`, descendente do default. Policy/control/access/spec iguais ao default antes do patch. Workflow local alheio preservado. |
| Checkout LAB2 recusado | `JRCConversas-development-20261015` contém deleções staged preexistentes; não alterado. |

## Publicação histórica e estado atual

O ZIP `Broker_JRC_Publicacao_Evidencias_2026-11-01_977ab0e.zip` foi localizado e seu SHA256 reconferido: `c80c0437dbd3c9c1dbbe599279fe6eb2b26619eba58ab11707892010be93310a`. Registra API/web 977ab0e, migration 0078, schema 78 CURRENT e 13 containers. Os digests registrados são:

- API: `e2bba6518304ee5f792c6ee69177ddb2548a07023b7133c60f4b43390f94d8fb`.
- Web: `4ab92d9aa581fadea7f39379dcad3b35976a86e1c79d7a5033682b833642aeea`.

Isso é evidência da publicação anterior. A leitura atual da aba do servidor retornou `browser.user is unavailable`, mesmo após nova seleção da aba existente. Estado atual: **BLOQUEADO_POR_ACESSO**. Não inferimos versão implantada, filas ou saúde atuais pelo inventário de abas.

Os resultados históricos de CI dos runs 41352772688, 41352779024 e imagens 41352774487 não validam o novo diff. Nenhuma nova imagem, CI remota, push, merge ou implantação integra a evidência local. Compose/ENV não foram modificados. A engine produtiva não recebeu este código.

`git diff origin/main HEAD -- infra/dokploy/compose.yaml` retornou vazio nesta execução: os dois arquivos de fonte continuam iguais. Isso não verifica o Compose atualmente salvo no Dokploy nem elimina o desalinhamento entre branch configurada e imagens pinadas; falta a leitura efetiva do servidor.

## Ambientes e identificação da prova

Node 24.19; TypeScript e Vite existentes, sem atualização de dependências. PostgreSQL e MinIO dedicados com portas somente loopback 15439/15440; Redis dedicado 15441 para E2E. Credenciais de fixtures apenas em memória do runner. Sem acesso aos dados reais. Testes PostgreSQL criam bancos aleatórios no cluster explicitamente descartável; testes que alteram roles exigem flag de exclusividade.

Memória Windows livre inicialmente: 397600 KiB. Execuções pesadas serializadas; nenhuma aplicação/serviço compartilhado encerrado. O runner Ruby usa imagem local pinada, rede desabilitada e fontes montadas somente leitura; não equivale ao Rails completo.

Os arquivos `ESTADO-FINAL.json` e `TESTES-E-EVIDENCIAS.md` são o checkpoint vigente. Contagens de suites sobrepostas não devem ser somadas. As matrizes registram explicitamente inspeção estática, teste local e prova operacional.
