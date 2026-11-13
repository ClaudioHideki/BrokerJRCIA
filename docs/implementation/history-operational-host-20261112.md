# Host de origem, admissão e convergência — 12/11/2026

Incremento sobre Broker `6522938097781d099e46f594eefc51e9149e783c`, branch `codex/whatsapp-history-sync-20261111`. LAB2 consolidado com A–G `cad427d400d824fc1fdc06c1c1079f324e7f3f6c` e runtime/Scout `d11c879a3d6e27499e1aea45736797a6e913b829`. Mains reconferidas e preservadas: Broker `29095bea35702893e1a5b80f5131bdd13b901a7e`, LAB2 `d8a83b824b11cc68ddbbce7c79681f368051fb70`.

## Implementação

O loader verifica o inventário do artefato antes de instalar o host privado PostgreSQL. Um LOGIN dedicado por engine, registrado pelo administrador, deriva os escopos atuais da frota e das políticas autorizadas. O processo de aplicação não substitui esse principal. A sessão autenticada comprova o dono; nomes de exibição, browser e payloads não concedem ownership.

Uma capability opaca é congelada ao registrar cada callback do socket. Reconexão invalida a capability anterior antes do primeiro await. O callback antigo não pode usar o owner, geração ou scope do novo socket. A remoção nativa da instância drena capturas/fanouts, cancela retry e libera o nome para uma nova instância sem reaproveitar a autoridade antiga.

A fila da origem tenta novamente somente a persistência do lote congelado: classes de erro de conexão PostgreSQL, deadlock/serialização/lock e backpressure explícito. O pg também emite três mensagens de conexão sem código; elas foram reproduzidas e tratadas de forma exata. Enqueue, conflitos e erros de domínio não entram em replay. Espera exponencial limitada, cancelamento e teto de capturas pendentes evitam loop apertado e crescimento sem limite.

O onboarding admite automaticamente **novas conexões autorizadas** quando a flag V2 estiver habilitada. Uma conexão ainda sem owner recebe escopo QR provisório sem inventar número; os lotes ficam duráveis e a promoção depende da confirmação da mesma sessão. `ALL_AUTHORIZED` materializa grupos da conexão/inbox correta sem ativar bot. Instalar uma imagem não inicia importação nas conexões existentes.

Journal live e descritor privado de mídia compartilham COMMIT. Descritores mínimos cifrados sobrevivem a SIGKILL sem depender da cache Prisma ou de reemissão do callback. O worker existente faz uma unidade por tick, prioriza live e mantém budgets distintos. Mídia é baixada com timeout, limite, host/redirect restritos, autenticação CBC/HMAC e verificação SHA/tamanho. READY exige leitura física do objeto privado; KEEP permanece.

Live e histórico convergem por identidade lógica, peer e provider ID, em ambas as ordens. Reuso exige recibo e mesmo fato imutável: bytes, MIME, tipo, nome e legenda. Grupos mantêm JID/participante e inbox próprios. IDs LID esperam resolução no scope comprovado; alias PN/LID não altera dono antigo. O receptor LAB2 continua silencioso: não roda bot, campanha, notificação ou atribuição sobre histórico e não muda responsável/status existentes.

## Migrations e infraestrutura

| Migration nova | Conteúdo | Reversão segura |
| --- | --- | --- |
| 0091_history_source_authority | Políticas, engines/principals, sessões, owner cifrado, RLS e funções com autoridade até COMMIT | Desabilitar captura/política, preservar tabelas e recibos |
| 0092_history_source_journal | Journal/lotes/chunks/mídia cifrados na mesma base Broker; chave live privada única | Pausar leitor; não apagar pendências nem executar DOWN |
| 0093_group_media_facts | Conteúdo de mídia de grupo aditivo e validado | Pausar ramo novo; manter fatos e armazenamento privado |

Nenhuma delas foi aplicada à produção neste checkpoint. O runtime exige a estrutura real, owner/grants/índices e constraints, não só a numeração no ledger. São aditivas e posteriores a 0090; migrations antigas e Evolution auth/session DB não foram movidos ou reescritos.

O host necessita principal dedicado registrado e configuração privada explícita da engine. Nenhuma credencial foi criada/alterada nesta execução. A flag produtiva de captura permanece desligada por padrão e o artefato mantém `deliveryOwnership=UNPROVEN`. A ativação exige imagem efetiva, registro do principal, conexão autorizada e inventário de origem comparável. Não usar credencial administrativa como fallback.

## Evidências desta rodada

- `npm test` com backup/recovery explicitamente excluídos: **4363 testes, 574 arquivos, zero falhas/skips**, 1298,53 s. Não executou rotinas excluídas.
- PostgreSQL focado após revisão: **86 testes/6 arquivos**, incluindo autoridade, deriva de schema, writer, recibo e onboarding. Depois do ajuste adicional do pg, o arquivo de host passou **25/25** (três novos casos). Suítes se sobrepõem.
- Origem/journal/crash: **116 testes**, zero falhas/skips. O ajuste posterior de erros pg sem código foi exercitado no callback nativo compilado contra PostgreSQL, com RED 3/3 e GREEN 25/25.
- E2E final de host operacional: **1 teste aprovado**, HTTP Rails, PostgreSQL, Redis/Sidekiq e MinIO reais de laboratório; dois tenants, duas imagens, indisponibilidade da origem, retry, custódia/hash e Minhas na inbox correta. A engine fornece callback compilado e eventos sintéticos, não telefone real.
- Outro E2E de histórico cobre **12 mensagens/8 anexos** (texto, imagem/legenda, áudio, PDF, vídeo, grupos e direções), ACK perdido, recaptura, dedupe e isolamento. Duas Accounts na mesma instalação Rails, não dois consumidores independentes.
- Revisão independente: oito achados reproduzidos/corrigidos, último retry confirmado com recuperação, erro de domínio terminal e enqueue único. Nenhum P1/P2 remanescente nos achados revisados.

Logs brutos privados ficam no ledger local, não são dados de clientes nem credenciais para distribuição. CI e imagens precisam da própria prova no novo SHA. Gates antigos não aprovam esta revisão.

## Limites e aceite operacional pendente

1. A compilação/testes de laboratório não comprovam o ownership da engine produtiva nem uma sessão WhatsApp física. Não ativar captura, reiniciar/parear números ou reprocessar UNKNOWN por conveniência do release.
2. A origem pode não fornecer todo o telefone; `isLatest` e `progress=100` não comprovam cobertura completa. A interface conserva total desconhecido e lacunas. Recaptura não garante recuperar arquivo expirado.
3. Um arquivo pendente ainda segura a materialização da sua página histórica atômica. As outras mídias têm tentativas justas e live permanece independente; checkpoint parcial por registro é um incremento separado.
4. Progresso público é leitura; start/resume/cancel V2 continuam privados, sem criar endpoint público incompatível. As políticas de caixas, URA e exclusividade existentes são preservadas.
5. Faltam CI no SHA final, provas das imagens atuais, implantação verificável e comparação real autorizada de origem/Broker/JRC. Capacidade 50/400/900 e duas instalações Chatwoot independentes não foram homologadas por estes testes.
6. O controle do Dokploy continua indisponível (`failed to write kernel assets`, os error 3). Não houve leitura nem alteração produtiva nesta rodada. A autorização de release foi recebida; execução depende de acesso funcional e gates verdes.

Backup/dump/restore, novos envios reais, limpeza de registros, migração de números e alteração de outras empresas permanecem fora do escopo.
