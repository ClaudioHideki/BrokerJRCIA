> **Checkpoint ativo 11/11/2026:** base 1fed8ff, branch local codex/whatsapp-history-sync-20261111. O texto de05/11 abaixo é histórico e seus50/31casos não são a aprovação deste candidato. A migration recuperada foi reconciliada como0087, sem alterar0085/0086. Nenhuma alteração produtiva.

## Incremento de captura da origem

- Projeção socket em páginas de até 100 registros e 1 MiB; CHAT/CONTACT/MESSAGE/GAP, grupos e participantes separados.
- Callback da engine pinada fa09d37892cdbb1d65a250155d293d92230c5b30 exercitado por classes compiladas e portas sintéticas. Host permanece explicitamente de laboratório e ownership UNPROVEN.
- Snapshot cifrado síncrono antes do primeiro await; reserva limitada para o conjunto de snapshots esperandoPostgreSQL. Falha de append conserva o snapshot em memória para retry limitado; crash antes de COMMIT continua sendo risco, não persistência comprovada.
- Journal PostgreSQL da engine mantém páginas, sequência e obrigações; ACK lógico confirma somente transferência durável ao staging do Broker. Fonte retém os bytes, inclusive após ACK (KEEP).
- Recibo exige scopeKey de captura, runId, chunkId, checksum dos registros e payloadHash do envelope completo. Valores validados são capturados antes deawait; pending é profundamente imutável. HTTP200 sozinho não encerra a obrigação.
- Identidade confirmada é separada da geração imutável da captura. Promoção não reinicia ordinal nem impede o próximo lote; admission_kind guarda a classificação do COMMIT original. Scope atual é validado/copiadocongelado antes da transação.
- O adaptador privado acceptHistorySourceChunk não é uma rota HTTP publicada. Autenticação/ownership produtivos, transporte e daemon de projeção ainda precisam ser fechados.

### Encerramento e mídias

O campo isLatest do Baileys 7.0.0-rc.9 indica a primeira sincronização. progress é por fase. Nenhum deles comprova sozinho o fim de todo o histórico; o projetor não fabrica isLast=true. Falta implementar uma prova de fechamento da cobertura. Fonte primária: [process-message.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc.9/src/Utils/process-message.ts#L243-L273), [history.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc.9/src/Utils/history.ts).

Referência de mídia válida nesta fronteira não é download nem recibo físico. Sem referência privada fornecida pelo journal de mídia, fica GAP/MEDIA_UNAVAILABLE. Download/descriptografia, cópiaS3, checksum/readback, recibo e retenção ponta a ponta continuam pendentes. Não apagar fontes.

### Evidências novas

- Contratos focais: 28/28; PostgreSQL real: 16/16 em 3 arquivos. Script completo do journal de origem: 93/93, incluindo crash real e callback compilado.
- Suíte completa final: 4.340/4.340 testes em 567 arquivos; typecheck e build API/frontend passaram. Compilados: 1 passou/1 skipped por falta de container de imagem. Tentativas iniciais e suas falhas estão preservadas no ledger, não contam como aprovação.
- Os 3 arquivos Node novos integram test:origin-journal, já chamado na CI e no workflow de imagens. CI remota e imagem não executadas neste incremento.

---

# Histórico V2 — contrato e núcleo privado em implementação

Data: 05/11/2026. Base Broker `0266ec02a33775cd065217e8e2e6b4fd2b0ef786`; consumidor LAB2 `200b4f1ddd7459ec924e314cfe34cb93f11c5d5e`.

## Situação e limite

Este incremento implementa contratos estritos e um núcleo privado de staging PostgreSQL. **Não existe uma rota V2 publicada, um host Evolution V2 conectado, nem projeção V2 operacional no JRC.** Os caminhos V2 citados no plano são propostas, não endpoints disponíveis aos clientes. V1 permanece intacto.

O plano completo está em `docs/superpowers/plans/2026-11-05-whatsapp-history-sync.md`. Captura da engine, escrita canônica live/histórico, receptor Rails silencioso, transferência física de mídia e homologação ponta a ponta continuam necessárias.

## Contratos implementados

- `HistorySyncStartSchema`: `FULL_AVAILABLE`, categorias distintas e limitadas; INDIVIDUAL e/ou GROUP delimitam os chats. MEDIA acrescenta cobertura de anexos aos chats escolhidos; MEDIA sozinho é incoerente. CONTACT pertence à seleção INDIVIDUAL. Um GAP global pode relatar indisponibilidade sem inventar uma conversa.
- Progresso separa captura, persistência local, projeção ao consumidor e mídias. Contadores contraditórios e conclusão com pendências são rejeitados.
- Envelope privado estrito: tenant, canal canônico, instância, engine/generation, sessionGeneration, binding fingerprint, identidade lógica e scope de identidade. Cada lote tem UUID, ordinal, checksum canônico, capturedAt, terminal/progresso e até 100 registros/1MiB antes da cifragem.
- Registros CHAT, CONTACT, MESSAGE e GAP. Mensagem individual/grupo preserva direção, provider ID, timestamp e participante. Mídia nesta fronteira é somente uma referência privada com tipo, tamanho e SHA-256: **não significa download realizado ou custódia física**. URLs, media keys, credenciais e campos desconhecidos são recusados.
- Mensagem antiga de um socket atual não é rejeitada apenas pela data. `provenance: SOCKET` é um discriminante de formato; **não substitui autenticação ou prova de origem do host da engine**.

## Persistência e núcleo privado

Migration aditiva `0087_history_sync`:

| Tabela | Finalidade |
|---|---|
| history_account_identities | Identidade lógica por tenant/canal/HMAC do dono, independente da reconexão/geração |
| history_sync_runs | Seleção imutável, proveniência da captura, estágios, revisão, contadores e erro sanitizado |
| history_sync_chunks | Lotes privados cifrados e imutáveis; estado PROVISIONAL/VALIDATED/PERSISTED/QUARANTINED |
| history_sync_receipts | Chave de deduplicação lógica e referência à mensagem canônica; ainda não há writer V2 admitido |

As quatro tabelas usam RLS forçada, chaves compostas tenant/canal, grants mínimos e bloqueio de admissão do lifecycle existente. A função de exclusão explícita do canal foi ampliada para respeitar a ordem das novas FKs; **não foi criada nem executada retenção automática**.

`createHistorySyncStore` oferece admissão idempotente, leitura tenant-scoped, staging, promoção e PAUSE/RESUME/CANCEL com revisão esperada. Não é um serviço HTTP, não possui um worker montado e não registra bots, envios ou campanhas.

O host futuro precisa fornecer:

1. Transação tenant-scoped com `jrc_app` e orçamento de staging medido, não controlado pelo navegador.
2. Chave AES-256-GCM por configuração privada existente/aprovada; este incremento não altera nem cria credenciais produtivas.
3. `assertCurrentScope`, que autentica origem/autoridade, revalida a identidade e mantém a trava de revogação até COMMIT. O callback vazio das fixtures é **exclusivamente sintético**, nunca um adaptador de produção.

O payload cifrado vincula organização/run/chunk/hash de scope como AAD. A quota é serializada por tenant e calcula bytes da representação JSONB efetivamente persistida. A falta de quota produz GAP explícito e run PARTIAL, sem confirmação de um lote inexistente. Não há descarte de lotes guardados.

Um recibo STAGED confirma somente o commit provisório. VALIDATED confirma classificação local sob a identidade informada; **nenhum dos dois é ACK final de mensagem importada, recibo do JRC ou recibo de mídia**. Retry do mesmo chunk compara o envelope completo, inclusive marcador final. Mesmo ID/ordinal com envelope diferente é conflito.

Promoção exige a mesma engine/generation/session/binding da captura. Scope diferente mantém o lote em quarentena. A identidade lógica não usa a geração na chave, permitindo preservar deduplicação do mesmo dono quando o writer for ligado. Dados de outro dono não são adotados por inferência.

## Atualização e pausa

0085 foi executada somente em bancos locais descartáveis, incluindo upgrade com fatos V1 pré-existentes. Não houve migration em produção. Antes de uma release, conferir novamente a numeração da main, o catálogo de lifecycle, grants e a compatibilidade do binário efetivo.

A reversão prevista é manter V2 sem admissão/host/worker e usar o comportamento V1 existente. Não executar DOWN destrutivo nem remover tabelas para voltar ao binário anterior. Nenhuma habilitação produtiva está implícita neste documento.

## Evidências deste incremento

- Contratos V1/V2 e privados: 50 casos focais, com RED→GREEN.
- PostgreSQL: 31 casos entre ledger V2, staging/concorrência/categorias/comandos, ledger V1 e upgrade populado V1. Banco local separado, não dados reais.
- Subprocesso real morto depois do COMMIT e antes do ACK: nova instância do store encontrou um único chunk e retomou sem segundo INSERT.
- Typecheck `tsc -b` executado. Não confundir essa compilação com imagem Docker, CI remota ou homologação de WhatsApp.

Os logs locais e os resultados exatos ficam no ledger `.superpowers/sdd/2026-11-05-whatsapp-history-sync/` e no pacote de evidências do workspace. A suíte integral, engine isolada, MinIO físico, Rails/Sidekiq e benchmark V2 ainda são gates pendentes.
