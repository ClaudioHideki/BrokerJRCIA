# Histórico WhatsApp: mídia na origem e progresso V2

Incremento local posterior a `ece27d13584b8eee661ccc2e8a792308c7fcd827` (Broker) e `e919b0ac7eaa95f844880e6f60bb8092d603f94b` (LAB2). Não publicado. Os checkpoints anteriores continuam válidos somente para os respectivos commits.

## Comportamento implementado

O callback compilado da Evolution pinada prepara páginas e descritores mínimos de mídia antes de entregar o evento à fila volátil. O descritor privado fica cifrado no mesmo COMMIT do journal da origem; não entra em página pública, log ou resposta HTTP. A opção `captureMedia` é estrita, desligada por padrão e conservada no bootstrap do host explícito de laboratório.

O worker de mídia lê uma obrigação por tick, com lease, backoff e ordem que evita que um arquivo com falha impeça as primeiras tentativas dos demais. Confere scope, run, referência, tamanho e SHA-256, revalida autoridade e só marca READY após recibo físico correlacionado. ACK perdido repete a mesma referência, sem trocar o objeto. Os dados permanecem em KEEP.

A Baileys pinada `7.0.0-rc.9` não repassa signal/redirect em `getHttpStream`. O downloader estreito deste incremento usa a derivação `getMediaKeys` por port privado e controla a requisição HTTPS, timeout, abort, limite de bytes e redirect proibido. Autentica CBC/HMAC e entrega bytes para a verificação SHA-256 antes da custódia. Não altera o vendor nem o fetch global. Referência primária: [messages-media.ts da versão pinada](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc.9/src/Utils/messages-media.ts).

MIME com parâmetro Opus é normalizado antes de congelar referência e digest. Formato não suportado vira lacuna explícita, sem bloquear o lote indefinidamente na validação do upload público. O caminho histórico conserva os limites de tipo/tamanho do provider; o upload público mantém sua validação própria.

O progresso é leitura de metadados, nunca operação de admissão ou replay:

| Consumidor | Rota | Autoridade |
| --- | --- | --- |
| Portal Broker | `GET /v1/channels/:id/history-sync/v2/progress` | JWT e membro atual; `id` é o canal canônico, não o ID público da instância V1 |
| Backend consumidor | `GET /v1/integrations/chatwoot/control/connections/:integrationId/history-sync/v2/progress` | Permissão atual ou chave Control vinculada; Account/inbox/destino/revisão revalidados |
| JRC Conversas | `GET /api/v1/accounts/:account_id/jrc_broker/inboxes/:inbox_id/history-sync` | Sessão e permissão locais antes e depois do HTTP; resposta filtrada e correlacionada |

As telas React/Vue exibem captura, persistência, recibos da central e mídias separadamente. Uma consulta em andamento não remonta a lista de conversas; troca de empresa/caixa cancela e descarta resposta antiga. A atualização periódica é de uma leitura por vez e para quando a aba está oculta. PT-BR, sem percentual inventado e sem botão que inicie captura, pareamento ou envio.

## Persistência e compatibilidade

- Migration Broker **0090_history_source_media**: ramo privado HISTORY em `messaging_media`, com identidade de origem/run/referência/hash; campos de peer no resultado por registro e índice para contagem distinta de conversas processadas. Os ramos públicos e de automação permanecem separados.
- Origem: tabela aditiva `jrc_evolution_origin.history_media` no instalador explícito do journal, com descritor cifrado, estado, lease, tentativas e recibo. O runtime não executa DDL automaticamente neste incremento.
- LAB2: nenhuma nova migration nesta rodada. Utiliza recibos/intenções e ActiveStorage já introduzidos na candidata anterior.
- V1 permanece independente. Nenhuma página histórica é enviada como webhook live para contornar capability ausente.
- Rollback operacional: pausar/desligar o recurso e manter os registros. Não aplicar a constraint antiga sobre linhas HISTORY existentes nem executar down destrutivo. Conferir compatibilidade do binário e migrations antes de uma futura publicação autorizada.

## Defeitos reproduzidos e corrigidos

| Defeito | Reprodução | Correção |
| --- | --- | --- |
| Scope mutável depois de await | Worker recebia a mutação durante o claim | Snapshot antes do primeiro await e correlação da obrigação |
| HTTP preso/redirect sem limite efetivo | Requisição loopback que não termina e resposta 307 | Abort real, teto de bytes e redirect:error, sem patch global |
| Arquivo em falha ocupa todas as tentativas | Duas mídias; primeira tenta novamente antes da segunda | Ordenação por tentativas e criação |
| Tipos históricos caem na regra do upload público | Formatos suportados pelo provider recusados no sink | Separação do validador HISTORY e GAP para tipo sem suporte |
| Opus aceito no Broker e recusado no LAB2 | `audio/ogg; codecs=opus` chega com parâmetro ao receptor | MIME base congelado na origem; E2E com voz Opus |
| Bootstrap descartava o opt-in de mídia | Hook compilado sem journal previamente injetado | Repasse explícito `captureMedia === true` |
| Progresso indica zero conversas | Chats repetidos em páginas e grupo vazio | Contagem distinta por run/categoria/peer com resultado durável |
| Parser aceita `run: false` | Rails retorna falso como se fosse ausência | Apenas null ou objeto de run válido; metadados e contadores estritos |

## Prova ponta a ponta e limites

O teste usa PostgreSQL de origem/Broker, HTTP Rails, Redis/Sidekiq e MinIO reais, com eventos e credenciais sintéticos. Dois tenants e duas Accounts na **mesma** instalação Rails. Compara independentemente IDs, direção, texto/data e hashes físicos de 12 mensagens e 8 anexos: imagem com legenda, Ogg/Opus, PDF e vídeo, incluindo grupos/LID e saída histórica.

Perde intencionalmente ACK da mídia, da página e da mensagem; recria leitores; recaptura com outras referências; verifica o mesmo fato/anexo e permissões cruzadas. Consulta real de Minhas retorna somente as duas conversas da inbox do membro, apesar de resolvidas e não atribuídas. Preserva exclusividade/URA e não executa bots nem autoatribuição sobre histórico.

Isso não é comprovação de sessão WhatsApp real, duas instalações Chatwoot independentes, navegador E2E ou capacidade de 50/400/900 conexões. O E2E HTTP usa transporte injetado. Separadamente, uma imagem local da engine pinada foi construída e o gate executado dentro dela conferiu a Baileys 7.0.0-rc.9 real: derivação HKDF independente, download autenticado e recusa de MAC corrompido para cinco tipos de mídia. O gate é sem rede e com transporte sintético; a composição no host operacional continua pendente.

Imagem somente local: `jrc-history-engine:media-progress-20261112`, ID `sha256:14bf9ecfddbe952bdceda39bb0817090095e295993aa348ecc8ec08fa5a82eb0`. Passaram também quatro gates do artefato: inventário de 34444 arquivos, execução não-root, flag de captura recusada, flag inválida e recibo adulterado recusados, sem carregar o main/canário ou acessar rede. Esses quatro cenários incluem um contrato positivo e três recusas; não somá-los como sessões reais. Scripts explícitos: `tests/engine-image-gates.mjs` e `tests/engine-history-media-gate.mjs` dentro de `integrations/evolution-origin-journal/`.

## Pendências internas explícitas

1. **Host operacional**: substituir somente com prova os ports privados de autoridade/admissão/destino, instalar bootstrap de sessão com ownership comprovado e manter revogação até COMMIT. O host atual continua LAB/UNPROVEN; não habilitar a flag em produção.
2. **Admissão e política por conexão**: capturar automaticamente apenas nova conexão autorizada; persistir política imutável, grupos ALL_AUTHORIZED e continuidade headless. Não disparar backfill de conexões atuais por instalação de imagem. O painel deste incremento observa; não implementa start/resume/cancel públicos V2.
3. **Convergência live**: concluir prova/dedupe para saída e mídia live e admissão de grupos recém-descobertos. Os testes deste incremento não autorizam remover seleção ou guard de identidade legado.
4. **Fechamento de cobertura**: isLatest/progress100 não provam que todo o telefone foi fornecido. Continuar mostrando total desconhecido até existir prova verificável; mídias antigas inacessíveis precisam de diagnóstico sem descarte prematuro.
   Uma mídia ainda pendente segura a materialização da sua página histórica atômica. As demais mídias recebem tentativas justas e o caminho live é independente, mas isso não comprova continuação de todos os outros registros históricos daquela página. Checkpoint parcial por registro exige incremento próprio, sem descartar bytes ou substituir recibos.
5. **Release/homologação**: CI no novo SHA, imagem efetiva, bootstrap/engine+Baileys reais, falha/reconexão com sessão autorizada e comparação origem/Broker/JRC; duas instalações independentes e benchmark continuam gates próprios.

Gates finais:4363 testes gerais/572 arquivos; origem113; empacotamento31; PostgreSQL60 mais8 de estrutura; contratos/HTTP/UI38; documentação43; Rails34 de progresso e63 de regressão; UI LAB26 mais4 InboxView. Suítes se sobrepõem e não devem ser somadas. Typecheck/build Broker e build LAB2 passaram. Browser do componente desktop/mobile usa API sintética e teve zero overflow/violações automáticas. Somente teste de backup foi excluído por escopo; nenhuma rotina operacional dessa área foi executada.

O gate estrutural da0090 foi reproduzido RED removendo peer_jid no banco descartável: a versão anterior aceitava. A correção exige colunas, constraint/index, função imutável/owner/grants e constraint do upload. A execução geral inicial falhou também por catálogo/PDF anteriores e restrição de spawn Git/OpenSSL; a execução geral final foi repetida completa e passou. ESLint do componente novo e seu teste limpos; avisos e métricas anteriores permanecem documentados, sem alegar lint global limpo.

Resultados exatos, tentativas falhas, contagens e hashes do pacote: relatório e checkpoint atualizados ao encerrar esta rodada. Não confundir implementação local com recurso implantado, CI remota ou imagem efetiva da engine homologada.
