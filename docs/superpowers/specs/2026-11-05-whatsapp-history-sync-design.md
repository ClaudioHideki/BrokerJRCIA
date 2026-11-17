# Sincronização de conversas WhatsApp — Broker e JRC

## Objetivo aprovado na conversa

Ao conectar um número QR/Evolution ao Broker e à inbox autorizada do JRC, sincronizar automaticamente as conversas individuais, grupos, mensagens enviadas/recebidas e mídias disponibilizadas pela origem. Continuar recebendo eventos novos durante a importação, sem duplicar contatos/conversas/mensagens ou executar URA sobre fatos históricos. A lista do Atendimento deve refletir os dados persistidos, com a cobertura e as lacunas visíveis.

Este documento define o desenvolvimento necessário; não comprova implementação ou homologação integral. Escopo QR/Baileys, não importação de histórico via Meta Cloud API.

## Bases conferidas em 05/11/2026

- Broker: `0266ec02a33775cd065217e8e2e6b4fd2b0ef786`, branch `codex/broker-ura-search-candidate-20261104`; main remota `2d30a5a544aa0eae12c208867e4912c369626787`.
- LAB2: `200b4f1ddd7459ec924e314cfe34cb93f11c5d5e`, branch `codex/shared-inbox-history-20261104`; main remota `a92f9bf8dd4a0b8828530f6c5d52d367449fe24b` já incorporada.
- Submódulo Evolution referenciado: `fa09d37892cdbb1d65a250155d293d92230c5b30`; checkout do submódulo não materializado neste worktree. Isso não é prova do digest da engine produtiva.
- Broker tinha somente `tmp/` não rastreado; LAB2 limpo. Preservar esses trabalhos.
- Nenhuma alteração produtiva nesta validação. A evidência anterior de deploy fica em `output/shared-inbox-history-20261104` no workspace; não repetir publicação.

## O que existe e por que não espelha tudo

| Fronteira | Evidência atual | Lacuna |
|---|---|---|
| Evolution → Broker | `packages/providers/src/evolution/messaging.ts:25` assina eventos live/grupos; sem MESSAGES_SET/CHATS_SET | Não há captura histórica completa contratada |
| Journal de origem | `integrations/evolution-origin-journal/src/projection.mjs` aceita notify TEXT individual e ignora messaging-history.set | Durabilidade de live TEXT não comprova continuidade de histórico/grupos/mídia |
| Snapshot Broker | `apps/api/src/modules/history-import/postgres-source.ts` filtra texto individual/LID, teto10000, páginas100, 14MB de admissão | Sem grupos/anexos, sem catálogo de chats vazios, operação limitada ao cache e identidade verificável |
| Identidade | `history-import/service.ts` e `runtime.ts` verificam owner/fleet/fingerprint/availableFrom | Cache antigo não prova a qual número pertencia; não basta remover availableFrom |
| Escrita/retomada | `history-import/store.ts` confirma página, recibo e checkpoint em uma transação; worker só avança operações previamente admitidas | Reutilizar o princípio em V2 e adicionar captura automática autorizada e cobertura por categoria |
| Histórico por webhook | `messaging/qr-events.ts` aceita lote<=100 de TEXT individual; recusa grupos/mídia | Não ligar MESSAGES_SET sem novo receptor; corrigir a prova de proveniência antes de ampliar |
| Broker → JRC | `integrations/chatwoot-client.ts` exige protocolo `jrc-history-import/1`; worker histórico só aceita TEXT | Contrato V2 necessário, sem quebrar receptores V1 |
| Receptor LAB2 | `app/services/jrc_broker/history_import.rb` e `history_bootstrap.rb` aceitam texto/telefone individual, criam pending sem callbacks | Faltam grupo, participante, anexos, mapeamento com conversas live existentes e recibos duráveis V2 |
| Mídia | `media-custody/service.ts` retorna KEEP/physicalStorageVerified=false | Recibo lógico não comprova cópia física no storage JRC |
| Atendimento | Filtros open/pending/all e paginação cronológica já existem | Exibir dados não cria sincronização; acrescentar progresso e não inflar o backlog/SLA com histórico |

## Abordagens e decisão

1. **Pipeline próprio Broker → API de histórico do consumidor — recomendado e alinhado ao usuário.** Evolution permanece motor; Broker mantém journal, isolamento e persistência independente do JRC. LAB2 recebe pela API; outros consumidores usam o mesmo modelo de capacidade/recibos.
2. Importador nativo Evolution → banco do Chatwoot: existe no upstream, mas acopla o motor ao schema e às credenciais de cada consumidor, e criaria um caminho paralelo à identidade/idempotência do Broker. Não adotado.
3. Apenas ativar syncFullHistory/MESSAGES_SET: insuficiente; os receptores atuais recusam classes e tamanhos necessários. Não adotado.

Não exigir acesso direto ao banco do CCLX. Um Chatwoot externo sem receptor V2 deve ser tratado como incompatível até ter adaptador autorizado; não anunciar compatibilidade fictícia.

## Arquitetura e propriedade dos dados

Fluxo: sessão autenticada → captura de histórico com proveniência → journal/páginas duráveis → persistência canônica Broker → fila histórica por destino → receptor JRC silencioso → storage/recibo pós-commit → reconciliação e apresentação.

- Captura e projeção são estados separados. Broker pode concluir persistência local enquanto o JRC está indisponível; a tela não pode dizer que o JRC terminou nesse caso.
- Cada captura pertence a tenant/canal/instância/engineGeneration/identityScope. A identidade lógica do número é separada dessa geração: um registro server-side `historyAccountIdentity` usa fingerprint HMAC de tenant+canal+número proprietário normalizado, sem instanceKey/engineGeneration. Reconectar o mesmo dono no mesmo canal preserva essa identidade; mudar de dono produz outra. O ID estável do fato usa historyAccountIdentity, recipientKind, JID e providerMessageId; runId/chunkId/captureEpoch não entram na chave de deduplicação.
- Compatibilidade de dados V1/live existentes exige adoção explícita dos IDs/mapeamentos canônicos quando a origem/dono puderem ser comprovados. Registros legados ambíguos ficam em conflito consultável, sem receber automaticamente o dono atual e sem criar uma cópia como atalho.
- Uma sessão pode fornecer mensagens com occurredAt anterior ao pareamento atual. Aceitá-las somente quando uma captura autenticada atual comprovar a origem naquela identidade. capturedAt e occurredAt têm funções diferentes.
- Cache legado anterior a availableFrom continua fechado se não houver prova por registro/snapshot. Nunca trocar availableFrom por uma data arbitrariamente antiga. Identidade/proveniência incerta deve gerar item bloqueado consultável, sem ACK de sucesso falso.
- Fonte normativa V2: evento histórico recebido diretamente do socket da sessão autenticada, envelopado no hook com owner verificado, engineGeneration, identityScope e capturedAt, persistido antes da confirmação. Snapshot/chunks congelam essa captura e sua proveniência; não inventam proveniência para linhas de cache. O banco da Evolution pode materializar/paginar fatos V2 que já tenham essa prova; cache legado sem ela permanece no caminho V1/restrito. Para recuperá-lo como histórico do dono atual, obter ressincronização autenticada. Se isso exigir novo pareamento ou restart, registrar dependência e pedir a autorização específica antes de agir.
- História pode chegar antes de o Broker confirmar o owner. Guardar esses chunks em staging durável privado, limitado e isolado por tenant/instância/engineGeneration/sessionGeneration, com checksum e estado PROVISIONAL. Não descartá-los nem depender de retransmissão futura do WhatsApp. Confirmação de persistência no staging não é ACK de identidade validada nem conclusão da importação. Somente promover em transação quando o owner confirmado pertencer à mesma sessão/generation original. Troca de dono/geração antes da promoção deixa o lote bloqueado em quarentena, nunca vinculado ao novo dono. Crash nessa janela deve preservar o staging. Esgotamento da quota interrompe a admissão com lacuna/estado parcial explícitos; sem descarte silencioso ou promessa de ressincronização automática garantida.
- Grupos têm JID e participante próprios. Nunca convertê-los em contatos por telefone. Guardar vínculo ao canal/identidade/destino e restringir visibilidade aos membros autorizados da inbox. A política por conexão `groupsMode=ALL_AUTHORIZED` admitirá histórico e mensagens live de todos os grupos disponibilizados àquela sessão, inclusive os descobertos depois. Materializar escopos centrais idempotentes somente para a inbox autorizada. A política não publica/seleciona bots, nem habilita automação de grupo. Conexões com política antiga SELECTED permanecem assim até configuração/rollout próprio; não alterar outras empresas globalmente.
- Na criação autorizada de uma nova conexão, admitir captura automática após confirmação da identidade. A projeção ao JRC exige também destino READY; a captura no Broker continua independente desse consumidor. Persistir autorização/política; worker sem browser aberto. Conexões atuais não podem disparar backfill produtivo apenas porque uma imagem foi instalada.

## Contrato V2 proposto, aditivo

Preservar todos os endpoints/schema V1. Criar recurso público `/v2/channels/:id/history-sync`, onde `:id` é o UUID canônico de messaging_channels; devolver instanceId separadamente. V1 usa um identificador de instância sob nome channel: não transportar essa ambiguidade para V2.

- GET `/capability`: fontes/categorias suportadas, autorização, cobertura conhecida/desconhecida, motivo de indisponibilidade.
- POST recurso: `Idempotency-Key`, mode=FULL_AVAILABLE, categorias INDIVIDUAL/GROUP/MEDIA; origem/destino derivados pelo servidor. OWNER/ADMIN; sem URLs, SQL ou credenciais fornecidos pelo browser.
- GET `/:runId`: estágios de captura, persistência, projeção, anexos, erros e contagens por categoria.
- POST `/:runId/resume` e `/:runId/cancel`: idempotentes e revisionados; cancelar não apaga o que foi importado.
- No Control existente, fornecer fachada history-sync por integração/inbox usando a chave já instalada e escopos chatwoot:read/manage; revalidar autoridade, limitar agente a leitura autorizada, nunca criar credenciais novas por conveniência.
- Receptor JRC V2: capability, bootstrap, mensagem e consulta de recibo sob namespace `jrc_history_sync/v2`. Exigir account/org/inbox/integration/identity/destinationRevision e autenticação de serviço. Rotas descritas no plano são propostas, não endpoints já disponíveis.
- Tipos de registro: CHAT, CONTACT, MESSAGE; MESSAGE discriminada em texto e referência privada de mídia, com direction, participant, occurredAt, providerMessageId e checksum. Tipos não suportados entram no relatório de lacunas, não são descartados silenciosamente.

## Reuso e deduplicação

- Antes de criar uma conversa histórica, resolver o mapeamento já existente live/histórico. Reutilizar quando o escopo canônico for o mesmo; conflito/ambiguidade bloqueia o item em vez de criar outro contato/conversa.
- Concorrência live/backfill deve convergir para a mesma mensagem e anexos, independentemente da ordem de chegada. Separar atualização de recibo de autorização para enviar.
- As datas originais são preservadas; histórico não reabre conversa resolvida nem altera responsável/time. Conversa exclusivamente histórica não entra na fila operacional/SLA como atendimento novo, mas aparece em Todas e histórico. Inbound novo passa pelo fluxo live normal.
- Não limpar as53 atribuições antigas de bot, escolher membros ou alterar ownership para facilitar a importação; são decisões independentes.

## Mídia física e KEEP

Salvar referências privadas e metadados mínimos validados; nenhum raw auth state/token/mediaKey em logs ou respostas públicas. O worker baixa com limites de tamanho, MIME e host/redirect validados, armazena, calcula SHA256 e confirma leitura física. O JRC registra seu próprio recibo somente depois do commit do vínculo mensagem/anexo. URL vencida é renovada pela identidade do objeto, não por URL arbitrária.

ACK perdido repete a mesma intenção e devolve o mesmo recibo. Falha de storage conserva retry durável e indica mídia pendente. Arquivo ausente/expirado na origem aparece como indisponível com motivo verificável; não se promete recuperar bytes ausentes. Política KEEP permanece; nenhuma exclusão automática faz parte deste trabalho.

## Carga, infraestrutura e segurança

Não copiar todo o histórico para RAM. Partir de páginas100 e orçamento de bytes já existente; dividir em chunks duráveis e aplicar backpressure. Remover o teto de cobertura de10000 por paginação de múltiplas operações, sem aumentar ilimitadamente o orçamento de uma operação. Priorizar live; limitar simultaneidade por tenant/engine com medição antes de alterar pools.

Usar PostgreSQL para fatos/recibos/checkpoints; Redis apenas coordenação/cache conforme arquitetura existente. Reutilizar S3/MinIO privado, sem bucket público, novo banco obrigatório ou nova credencial por padrão. Verificar configuração efetiva da engine, SAVE_DATA.HISTORIC, retenção/cache e acesso READ ONLY antes de escolher fonte. Esses valores produtivos não foram relidos nesta validação.

Migrations somente aditivas, numeradas depois de buscar a main no momento da implementação. Ledger V1 não será reescrito. Downgrade do app pausa V2 sem apagar suas tabelas/objetos; nunca usar down destrutivo. Backup/dump/restore fora do escopo; não rodar scripts agregados que os acionem.

## Aceite obrigatório

- Fonte → Broker → JRC reconciliados por IDs e hashes, separando capturado/persistido/duplicado/pendente/bloqueado/indisponível, individuais/grupos/mídia e incoming/outgoing. Total da fonte desconhecido continua desconhecido.
- Replay do mesmo chunk; ACK perdido; crash antes/depois de cada commit; reinício do worker; cancelamento; concorrência com live: zero duplicidade e sem perda silenciosa de IDs.
- Troca de número, engine/binding/destino, LID conflitante, revogação e tenant cruzado: não compartilhar dados do escopo antigo.
- Mensagem antiga capturada legitimamente na sessão atual é aceita; mensagem antiga de cache misturado sem prova permanece bloqueada.
- Histórico chegando antes do owner, crash nessa janela e mudança de dono antes da promoção: staging preservado e promoção somente para a geração original comprovada. Quota esgotada nunca aparece como captura completa.
- Grupo com participante LID e mídia nas duas direções, texto com mesmo timestamp, chats sem mensagem recuperável, MIME incorreto, URL expirada e storage fora do ar têm resultado explícito.
- Nenhum send, bot, campanha, notificação ou atribuição live é causado pelo backfill; conversa live existente não duplica nem muda de status/responsável.
- Teste sintético e MinIO físico são distintos da homologação com sessão real. Só declarar espelhamento após comparar uma sessão autorizada; não afirmar universalmente que o WhatsApp fornece100% do celular.

## Validação executada agora

Inspeção dos dois HEADs e mains remotas, sem mudança de produto/servidor. Quatro arquivos focais passaram: **63/63** (contrato público V1, contrato privado snapshot, normalizador QR e painel de importação), em12,37s. Esses testes confirmam o comportamento atual, inclusive restrições; não comprovam V2, grupos/mídia ou sessão real. Não foram iniciados PostgreSQL/Redis/engine, migrations ou testes de carga nesta rodada. A consulta de RAM por CIM foi negada; os zeros desse comando não foram usados como capacidade real.

## Fontes primárias conferidas

- Evolution pinado, handler histórico e importador: https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts e `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` no mesmo commit.
- Baileys: https://github.com/WhiskeySockets/docs/blob/main/advanced/history-sync.mdx . A documentação corrente contextualiza o comportamento; não substitui teste na imagem efetiva pinada.
