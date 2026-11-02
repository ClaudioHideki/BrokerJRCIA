# Continuação executável sobre 977ab0e — 01/11/2026

Este plano operacional aplica o prompt de finalização fornecido pelo usuário. A publicação anterior de API/web não será repetida. Nenhuma autorização antiga de deploy é aplicada automaticamente a este novo diff.

## Baseline e limites

- Checkout existente: `image-release-20260924`; branch `codex/broker-jrc-2-redesign-homologacao-20261030`; HEAD inicial `977ab0eed78ac3ad1aac75f38e6bba723eb86db2`.
- PR #6 aberta/rascunho, base `codex/broker-audit-fixes-20261029` em `d1b66a56fe6d4f9202969784301abdf61490db45`. Main consultada: `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`.
- Nenhuma alteração rastreada no início; arquivos não rastreados históricos preservados.
- Backup, dump, restore e políticas fora do escopo. Não executar `ci:verify` ou suítes que acionem essas rotinas. Código existente preservado.
- Sem produção, replay, envio, sessão real, credencial, merge ou alteração da engine produtiva neste incremento.
- Memória livre observada: 397600 KiB; testes serializados. Não encerrar aplicações/containers de terceiros para liberar recursos.

## Incrementos coordenados

| ID | Entrega de código | Regressão e aceite | Responsável/limite |
|---|---|---|---|
| I1 | ACK negociado HTTP legado / recibo de persistência v1; validação correlacionada e persistência da evidência | RED do falso aceite 2xx; escopo, formato, tamanho, lease, compatibilidade 204; SQL isolado quando disponível | agente ACK; backend, contratos, migration0079 |
| I2 | Receptor de laboratório compatível com recibo após COMMIT + MinIO/readback | worker real, ACK perdido, idempotência, KEEP; nenhuma alegação de criptografia por extensão | raiz; labs/cclx-postgres-simulator |
| I3 | Corrigir autorização obsoleta na janela de pareamento LAB2, se reprodução confirmar | comparação com fonte remota atual; revogação/troca de binding durante operação; duas contas | agente LAB2; adaptador/harness e patch da fonte correta |
| I4 | Diagnóstico acionável e responsivo nos painéis admin/empresa | códigos de histórico sem orientação; falha/ausência/permissão distintas; cards acessíveis | agente produto; apps/web |
| I5 | Consolidação, revisão, matriz real de APIs/telas e evidências | typecheck, build e testes afetados; integração completa apenas quando efetivamente executada | raiz; sem deploy |
| I6 | Habilitar e validar as quatro jornadas móveis omitidas | RED com menu fechado; navegação acessível e revogação da chave exata; E2E final 41 passes/um skip desktop intencional | agente produto + raiz; sem afrouxar assertions |

## Preflight e conflitos resolvidos

| Frentes | Interface compartilhada | Decisão |
|---|---|---|
| I1/I2 | Contrato ACK | I1 define schema; I2 consome o mesmo contrato. Mídia/custódia permanece separada do ACK do evento. |
| I1/I4 | APIs públicas vs diagnóstico Chatwoot | I4 mantém contratos atuais de diagnóstico; sem edição de contratos backend. |
| I3/I4 | Conexões | I3 trata autorização no consumidor Rails; I4 não altera pareamento/autoridade. |
| Todas | Build/PG/RAM/checkpoint | Slot único de testes pesados; raiz mantém checkpoints e geração OpenAPI. |
| I1 | Compatibilidade | Default HTTP mantém 2xx/204; recibo obrigatório somente no modo negociado. |
| I2 | Custódia | Resposta depois de COMMIT não comprova verificação física independente pelo Broker; KEEP mantido. |
| I3 | Repositório | Não editar checkout antigo com deleções staged; conferir GitHub correto antes de patch. |
| I4 | UX | Sem botões simulados e sem remover skips mobile sem execução real dos testes. |
| I5 | Escopo | Excluir testes de backup/restore mesmo se scripts agregados os incluírem. Bloqueios de acesso não suspendem código independente. |

## Gates não encerrados por este plano

Engine final construída e instalada com ownership comprovada; sessões reais; Rails/LAB2 completo; investigação atual no servidor; piloto50/30dias; capacidade física400/900. Resultados históricos continuam históricos. Atualizar CONTINUE-AQUI.md após cada incremento executado.
