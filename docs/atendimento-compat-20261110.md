# Compatibilidade de mensagens Evolution — 10/11/2026

Base: 29095bea35702893e1a5b80f5131bdd13b901a7e. Branch local: codex/atendimento-compat-evolution-20261110. Sem deploy, push, merge, engine nova, alteração de sessão ou dados reais. tmp/ preexistente preservado.

`apps/api/src/modules/messaging/qr-events.ts`: documentWithCaptionMessage foi acrescentado às duas rotinas existentes de unwrap limitado. O envelope consta da engine Evolution pinada. Preservados identidade, direção, ordem e descritor de mídia. Não foi habilitado histórico de mídias nem modificado KEEP.

Regressões em `apps/api/tests/unit/qr-events.test.ts`: entrada de documento com legenda; saída aninhada, com ordem e identidade; rejeição histórica de mídia preservada. RED de três falhas antes da correção, GREEN de 266 testes em 15 arquivos de mensagens/provedores depois. Typecheck e build aprovados. Build frontend apresentou aviso de chunks acima de 500 kB.

Suíte ampla local: 4.310 testes contabilizados, 4.305 passaram, 2 falharam, 3 pendentes; três arquivos falharam, incluindo coleta/artefato. JSON success=false, embora o processo tenha retornado exit0. Uma falha foi ENOSPC no teste sintético de limite de recuperação; duas em verificações de artefatos/PDF. Não há aprovação integral de CI. O filtro por nome não excluiu recovery.test.mjs, que usou fixtures locais; não repetir essas rotinas fora do escopo. Nenhum banco real, dump ou restore produtivo foi usado.

Evidências brutas ignoradas: `.superpowers/sdd/atendimento-compat-20261110/`. O relatório completo do incremento também está no LAB2, `docs/superpowers/plans/2026-11-10-atendimento-voz-estavel-resultado.md`.

Histórico integral de chats/contatos/grupos/mídias, mídia ao vivo de grupos e equivalência total com a Evolution não foram implementados por este patch. Não confundir rolagem das conversas armazenadas no JRC com espelhamento completo do WhatsApp. PostgreSQL/Redis e sessão real continuam gates de homologação separados.
