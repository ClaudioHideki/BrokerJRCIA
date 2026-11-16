# Confiabilidade WhatsApp ↔ Broker ↔ JRC — 16/11/2026

## Escopo e estado

Incremento de correção em `codex/whatsapp-delivery-reliability-20261116` nos dois checkouts preservados. Broker parte de `c3bae632ea9df9cf263c98a503f5c262f5872a3a`; LAB2 parte de `a24adc6dd8bb660f955b76cce0172ae1638deee2`. As mains remotas foram conferidas no início do trabalho. Não se tomou a main como prova de implantação.

Este documento registra código e testes. O usuário pediu transferir a verificação para GitHub Actions em16/11 após travamento do Docker Desktop; candidata de testes será publicada em branch específica. Isso não autoriza merge, imagem publicada, deploy, migration produtiva, alteração de credenciais, pareamento, envio real ou replay. Backup/dump/restore permanecem fora do escopo. Broker não requer migration nova; LAB2 inclui a migration aditiva local `20261116190000_create_jrc_broker_live_receipts.rb`, descrita abaixo. CI e E2E finais permanecem gates da candidata integral.

## Defeitos reproduzidos e correções

| Defeito | Correção | Evidência |
|---|---|---|
| Resposta humana nova bloqueada por um espelhamento incerto de outro contato | Intenção durável gerada na mesma transação da mensagem no LAB2; Broker exige observação autenticada, GET canônico exato, escopo atual e isolamento positivo de **todos** os UNKNOWNs. Operação incerta não é reenviada. | PostgreSQL: negativo/positivo, múltiplas incertezas, mesmo contato, ciclo físico, revisão, remetente, anexos, callback duplicado e concorrência. |
| Dois workers admitiam jobs da mesma integração após uma leitura concorrente | Revalidar ausência de RUNNING na segunda consulta de claim, depois do lock da conexão. | Regressão antiga encontrou dois contatos; RED determinístico adicional e GREEN após correção. |
| Troca de credencial entre leitura final e COMMIT | Advisory lock do destino antes do canal; locks compartilhados de conexão/conta/destino retidos até COMMIT do outbox. | RED: rotação concluía durante a transação; GREEN: rotação espera o lock. |
| ACK do callback apresentado como envio WhatsApp | Marcador PENDING transacional; PATCH aditivo `broker_delivery` com ID canônico, ID real do provedor e estado. Apresentação distingue fila, admissão e confirmação. | Specs Rails/API/Vue e testes do cliente/worker. |
| Callback de status atrasado sobrescrevia READ | Recibo monotônico sob lock; callbacks legados também consultam a obrigação persistida, inclusive objetos pré-upgrade carregados antes do primeiro recibo. | Regressões READ→SENT/FAILED e stale model; identidade não pode trocar. |
| Retentar na UI podia apagar a evidência e criar outro envio | Retry genérico de mensagem com obrigação Broker devolve 409 `JRC_BROKER_RETRY_REQUIRES_RECONCILIATION`; UI conserva diagnóstico e remove essa ação. | Request specs: mesmos atributos/obrigação e nenhum SendReplyJob novo. |
| Consulta canônica não encontrava mensagem persistida no LAB2 | A consulta `before=id+1` inventava um cursor que o finder cronológico exige existir. Usar intervalo exato `after=id&before=id+1`, conservando validações de conta/caixa/conversa e recusa de ausência/duplicidade. | E2E Rails falhou com `CHATWOOT_MESSAGE_NOT_PROVEN`; dois unitários RED. Intervalo também existe no código oficial Chatwoot 3.16.0 e 4.8.0. |
| Download do anexo mais recente tinha o mesmo cursor e exigia telefone de grupo | GET do envelope valida conversa/conta/caixa, sem exigir telefone; consulta exata por intervalo e IDs de mensagem/anexo. Origem/redirect/limites e ausência de credenciais no arquivo permanecem. | RED definitivo3 falhas/2 recusas já preservadas; GREEN46/46 em3 arquivos. |
| PUT de mídia confirmado sem bytes íntegros | Antes de READY, ler o objeto físico com limite/deadline e conferir tamanho/SHA-256. Em ausência/corrupção/truncamento/timeout, manter staging cifrado, reserva e UNKNOWN; recuperar por inspeção, sem repetir PUT incerto. | Quatro REDs HTTP/FS/PG; 64 testes PostgreSQL e 114 unitários/HTTP aprovados. |
| Grupo live recusava qualquer mídia | Reutilizar armazenamento privado, autorização de tenant/canal/mídia e revalidação do escopo antes/depois do I/O. Mesmo ledger de tentativa/recibo/idempotência; participante e legenda preservados. | Oito REDs; 30 testes PG de grupo e 25 unitários do cliente/mídia aprovados. Histórico nunca usa fallback live. |
| Status de saída de grupo não incluía prova | PATCH de grupo usa ID canônico e `upstream_message_id` real; não inventa ID de provedor para registros legados. | RED por ausência de `broker_delivery`, seguido de GREEN. |
| Saída humana de mídia para grupo não tinha percurso completo | Intenção humana v1 e anexos canônicos; referência privada fixada por revisão; preparação antes do claim; portas GROUP explícitas no runtime/fleet/provider; ACK com JID/id/fromMe; agregado de anexos e representante estável. TEXT e engine preservados. | 48/48 PG e68/68 unitários dirigidos; RED incluiu caminho ausente e confirmação prematura de2 anexos. |
| Bloqueio de grupo era genérico | Persistir somente código fixo do predicado ausente: catálogo, seleção, participação, webhook ou contexto. Diagnóstico não concede autoridade nem libera replay. | Casos negativos preservam zero chamadas remotas/mapas. |

## Contratos e compatibilidade

- `content_attributes.jrc_broker_outbound`: versão 1, PENDING, UUID da obrigação, integração e inbox. Gravado pelo servidor; entrada do navegador não autoriza despacho.
- PATCH de status existente admite `broker_delivery` opcional: `{version:1, canonical_message_id:UUID, provider_message_id:string|null, state:SENT|DELIVERED|READ|FAILED}`. Identificador de provedor tem até 512 caracteres, sem whitespace/controles; null somente para FAILED. Sem prova, consumidores antigos conservam o contrato legado.
- Campos originais de intenção são retidos quando o recibo chega. DELIVERED/READ não regridem por callback antigo ou FAILED; a identidade canônica/provedor não pode ser substituída.
- `presentationText` é argumento interno do cliente multipart, não campo novo de API pública. Preserva o limite original da legenda do provedor e permite apresentar participante junto dela no JRC.
- Envio humano de mídia de grupo é aditivo e exige prova canônica por IDs, não URLs do callback. Legenda acima de1024 e sticker com legenda são recusados explicitamente; não há truncamento ou descarte silencioso. A porta de telefone individual não foi aberta a JIDs de grupo.
- Importação histórica continua silenciosa e separada de mensagens live. Não altera responsáveis, liga bots nem transforma histórico em novas mensagens enviadas.
- Minhas continua condicionado a associação de caixa, supervisão/exclusividade e ownership. Nenhum filtro foi aberto a outra conta ou a conversas ainda sob autoridade de bot.

A compatibilidade da consulta por intervalo foi conferida nas fontes oficiais: [Chatwoot3.16.0](https://raw.githubusercontent.com/chatwoot/chatwoot/v3.16.0/app/finders/message_finder.rb) e [Chatwoot4.8.0](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.8.0/app/finders/message_finder.rb). Ambas usam limites inclusivo/exclusivo para `after`+`before`; isso não exige modificar o finder do LAB2.

## Recibo LIVE nativo, interoperabilidade e migration

Contrato completo: [live-ingress-receipt-v1-20261116.md](live-ingress-receipt-v1-20261116.md). Protocolo `jrc-live-ingress/1`, raiz `/api/v1/accounts/:account_id/jrc_broker/inboxes/:inbox_id/live-ingress/v1`:

| Método/caminho | Efeito |
|---|---|
| POST `/capability` | Leitura autenticada de features/escopo; não envia. |
| POST `/messages` | Texto JSON ou multipart envelope+arquivo; recibo de custódia, não entrega WhatsApp. |
| POST `/receipts/:broker_message_id` | Consulta imutável por hash/escopo; nunca reenvia. |

Escolha persistida antes do POST. Somente404/405 de capability ausente, antes da primeira tentativa, seleciona genérico. Native UNKNOWN só admite consulta do recibo original. Retry de rejeição conhecida exige REJECTED sem receipt_id, mesmo corpo/hash/configuração/mapa e nenhuma outra tentativa DISPATCHED/UNKNOWN para a mensagem. Mapa removido é recusado antes de bootstrap, com RED→GREEN PostgreSQL.

Inspeção automática limitada a um UNKNOWN nativo novo vencido por organização/tick, orçamento15s e leitura com timeout3s. Genéricos/legados e FAILED excluídos. Pending/missing/revogado permanece UNKNOWN. Lease/contexto revalidados antes/depois de HTTP e antes de confirmar; locks seguem destino→instância→canal→configuração. Expiração após POST conserva incerteza; não permite leitura adicional por esse worker.

LAB2 adiciona controller/serviços live_ingress*, ingress_identity/presentation/live_history_custody, LiveReceipt e jobs de publicação/recovery. Migration20261116190000 cria recibo/escrow, índices/constraints/trigger imutável e origin_context nullable/imutável no histórico; antigos ficam NULL, sem prova inventada. Texto usa callbacks normais; histórico continua silencioso. Mídia limita16MiB/arquivo e64MiB pendentes/Account sob lock; libera bytea só no COMMIT PERSISTED, conservando o objeto KEEP.

LIVE/histórico compartilham lock de origem. Reuso exige recibo imutável, mesmo escopo/conversa/direção/apresentação e bytes privados verificados; não adota marcador editável. Duas concorrências PostgreSQL reais verificam um único Message. Guardas extras preservam escrow se um genérico sem prova surgir antes da publicação.

`occurred_at` opcional usa o relógio canônico da origem, faz parte do hash e fica congelado na prova; ausência mantém contrato/hash antigos. MessageBuilder aplica o clock somente no receiver interno. Atividade da conversa usa CAS monotônico no banco e reload antes dos callbacks; só a conversa vazia troca a âncora inicial. RED→GREEN cobriu relógio recent→old e interop. Nomes de arquivo são limitados uma vez a255bytes UTF-8 antes do hash/multipart, preservando extensão limitada; RED/GREEN multibyte corrigiu incompatibilidade real entre Broker e receptor.

**Bloqueio de compatibilidade pré-release:** FKs RESTRICT protegem Message/Inbox/Account/Blob com recibo. Jobs antigos de hard delete podem falhar até reconciliar remoção com histórico preservado e expurgo separado. Não usar CASCADE para apagar prova. Migration down é irreversível; rollback autorizado deve pausar admissão/recovery nativos e preservar schema/recibos/escrow/arquivos com binário compatível. Nenhuma reversão foi executada. Receptor/migration devem preceder admissão nativa pelo Broker; CI/imagem/runtime têm gates próprios. ADR LAB2: `docs/adr/0002-recibo-live-custodia-broker.md`.

## Verificação local

Evidências completas em `.superpowers/sdd/2026-11-16-delivery-reliability/` e no `output/whatsapp-delivery-reliability-20261116/lab2/` do checkout LAB2. Resultados de cada execução são independentes; não somar baterias sobrepostas.

| Bateria | Resultado observado |
|---|---|
| Broker `npm test`, excluindo somente testes operacionais de backup/recovery | 4.395/4.395, 577 arquivos, exit 0. Execução iniciou antes dos últimos deltas de grupo/paginação; esses deltas recebem regressões focais posteriores. |
| Broker PG — isolamento/intenção/status/grupos antes do incremento de mídia de grupo | 54/54, 4 arquivos. |
| Mídia privada — PostgreSQL | 64/64, 4 arquivos. |
| Mídia privada — unidades/HTTP | 114/114, 3 arquivos. |
| Grupos completos após mídia | 30/30. |
| Grupos completos após saída humana MEDIA e agregado | 48/48 PG;68/68 unidades de contrato/provider/fleet/composição/referência. |
| Cliente/mídia após presentationText | 25/25, 3 arquivos. |
| Cliente/cursor/download após último ajuste | 46/46,3 arquivos; unidades canônicas/contrato do ajuste anterior96/96,6 arquivos. |
| LAB2 frontend PT-BR | 36/36 após projeção legada; três textos sem fallback em inglês. |
| LAB2 Rails consolidado | 126/126 antes do último predicado de display FAILED; esse delta recebe regressão própria. |
| Typecheck Broker após mídia | Exit 0; repetir gate após fechamento do cursor. |
| Build e E2E integrado final | Em execução; registrar resultados abaixo antes do fechamento. |

Falhas intermediárias não são omitidas: gate PG inicial teve 170 aprovações/1 falha real de concorrência; o teste focal demonstrou a causa e passou após correção. Preparação LAB2 encontrou PostgreSQL sintético em recovery/OOM; somente o container rotulado do teste passou de 256 para 512 MiB, sem restart. Duas expectativas antigas de campanha foram ajustadas para o diagnóstico agora comum. Launcher E2E apontava banco administrativo inexistente e o seed tentava mudar destino já vinculado: corrigidos somente launcher/ordem de seed, sem retirar guardas. O E2E seguinte reproduziu o defeito real de cursor descrito acima. Uma rodada de grupo teve7 falhas por cast SQL da revisão; cast explícito corrigido e48/48 posteriores aprovados.

A segunda bateria geral foi interrompida para serializar recursos após medição de RAM livre de125MiB, sem tocar Vite/containers/dados. Antes da interrupção houve uma falha de20,4s no teste de sessão da página Platform; não se declara aprovação dessa rodada. O E2E ampliado com multipart também teve timeout conservador de15s no POST de vínculo, sob a mesma pressão. Não foi atribuído com certeza a memória ou a payload. A rodada e seus logs permanecem como falha/incompleta até repetição serial; nenhum timeout de produção foi aumentado e nenhum POST incerto foi repetido.

O runtime Rails disponível é Ruby 3.4.4; Gemfile/lock do produto permanecem em 3.4.12. A compatibilidade usada existe somente na cópia descartável do runner. Aprovação nesse laboratório não substitui CI/container com a versão exata do produto.

## Limites e pendências verificáveis

1. **Recibo LIVE nativo implementado localmente, não publicado/homologado em produção.** O receptor genérico continua sem recibo imutável: não se promove UNKNOWN genérico pelo marcador editável. Os caminhos individual/GROUP nativos usam prova versionada. O fechamento HTTP e a CI do candidato continuam necessários; não se declara perda zero.
2. Operações antigas UNKNOWN permanecem preservadas. Ausência remota ou passagem do tempo não provam que o POST não executou. A nova intenção não libera reenvio antigo. Reconciliação GROUP agora existe somente com prova nativa exata e escopo atual; grupo genérico sem prova continua bloqueado. Mídia humana de grupo foi testada localmente, não homologada em aparelho.
3. Grupos cuja seleção/participação/webhook/escopo não estão comprovados continuam bloqueados, com diagnóstico mais específico. Não foi alterada configuração produtiva para satisfazer o teste.
4. Mídias já ausentes no storage não são recuperadas por um novo status. É necessário encontrar bytes válidos na origem/staging e conferir integridade. Não foi comprovada a causa dos objetos ausentes ou HTTP 422 da fotografia produtiva anterior.
5. Conversas ainda sob bot/URA não recebem liberação em massa. A transição exige ownership/revisão/drenagem comprovados. Comparar registros por IDs e caixa, não apenas quantidade ou aparência.
6. Captura V2/host ownership continuam default off/UNPROVEN onde ainda não homologados. Teste sintético não autoriza ativação produtiva ou garante que o telefone fornecerá todo o histórico.
7. Permanecem separados: código local, CI do candidato, imagem publicada, implantação, reconciliação operacional e aceite no aparelho. Não se declara perda zero, todas as conversas atuais sincronizadas ou capacidade de 900 sessões.

## Próximo aceite operacional

Após release coordenada explicitamente autorizada e CI no SHA consolidado: reconferir schema/versões, mapear canais/identidades/bindings atuais, reconciliar fila sem replay cego e comparar IDs WhatsApp/origem→Broker→JRC. Verificar ambas as direções de texto/mídia individual, entrada de grupo com mídia, nome/telefone/participante, hashes privados, status e visibilidade da caixa. A verificação física do aparelho permanece pendente por escolha anterior do usuário.

## Resultados adicionais do receptor nativo

- Broker individual native+isolamento:31/31 em2 arquivos,47,25s, após lease/retry/mapa/clock.
- Helpers native/dispatch:60/60 em2 arquivos, incluindo RED/GREEN de nome UTF-8 e relógio.
- GROUP native/reconcile/retry:74/74 antes do clock; depois do clock17/17 (16 unidades+1 PG focal). Baterias sobrepostas, não somar.
- LAB2 receiver/interop/concurrency:44/44 antes do clock, incluindo duas concorrências PostgreSQL; focal clock/guardas:57/57. Genéricos finais ainda em validação.
- Geral final Broker, build/tsc final e HTTP native final em execução/preparação; não registrados como aprovados.

Atualização15:18: geral Broker aprovado **4487/4487 em581 arquivos**,1765,44s, exit0 (somente backup/recovery operacionais excluídos). A regressão PostgreSQL passou **193/193 em7 arquivos**,261,59s. Build React/TypeScript, typecheck, contratos públicos e gate de32 arquivos do bundle passaram.

Depois da bateria geral, dois deltas estreitos receberam RED/GREEN próprios: nome truncado em code units podia deixar surrogate inválido (normalização UTF-8 via Buffer,61/61 helpers/dispatch); bootstrap podia substituir operation=SEND_MESSAGE legado antes de selecionar protocolo (captura da operação original,32/32 native+isolamento PostgreSQL). Não se atribui a rodada geral anterior à cobertura desses dois deltas posteriores. Build/tsc após o último delta e E2E HTTP finais serão registrados no fechamento.

O relógio de publicação servidor `published_at` do recibo é diferente do relógio de origem. Texto normal o grava na transação; mídia só em PERSISTED; adoção histórica mantém NULL e não cria unread. Esse campo é imutável e alimenta contador/lista/badges, sem alterar a janela24h. Focal Rails de publicação/unread passou66/66; revisão encontrou quatro contadores adicionais e cursor manual ainda usando created_at e exigiu RED/GREEN desses caminhos reais, em fechamento. A primeira rodada genérica295 teve14 falhas de fixtures/baseline em investigação/repetição; não se registra como verde.

**Build frontend LAB2 BLOQUEADO POR RECURSOS:** tentativa Vite4096MiB falhou por heap OOM. O guard do produto exige Linux e≥8GiB disponíveis; host tem7,84GiB totais/Docker3,74GiB. Guard não foi burlado, não houve tentativa6GiB incompatível nem aprovação falsa. É necessário CI Linux elegível e Ruby3.4.12; runtime local3.4.4 não substitui esse gate.

## Fechamento das verificações

Em atualização ao término dos processos locais. Nenhuma execução pendente será registrada como aprovada.
# Retomada da CI em 16/11/2026

A candidata Broker `730ff44240a1f891855bd83d3cae476117be0196` foi enviada somente à branch de testes. A execução GitHub Actions `43936822804` aprovou build/tipos, 4479 testes gerais em 579 arquivos, 9 testes PDF e 884 testes web (baterias sobrepostas). PostgreSQL terminou com 1900 aprovações, 14 falhas e 3 E2Es ignorados por exigirem o laboratório dedicado. A execução inteira **não passou**.

Rastreamento das falhas: quatro simuladores do Chatwoot genérico lançavam erro de transporte na nova consulta de capacidade, em vez de representar a ausência do endpoint com HTTP 404; o simulador de armazenamento retornava MISSING mesmo depois de armazenar bytes. Correção restrita às fixtures: ausência explícita da capacidade e inspeção de tamanho/SHA dos bytes armazenados. Os guardas produtivos não foram afrouxados. Regressão PostgreSQL independente foi acrescentada à CI para verificar essas cinco suítes; resultado ainda pendente. Nenhum deploy, pareamento, envio real ou rotina de backup/dump/restore.
