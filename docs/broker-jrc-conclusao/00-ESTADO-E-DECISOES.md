# Estado e decisões — 01/11/2026

Missão: PROMPT_MESTRE_BROKER_JRC_EXECUCAO_REDESIGN_HOMOLOGACAO.md, recebido em 01/11. Relatório de 30/10 é histórico, não estado corrente.

Base d1b66a56fe6d4f9202969784301abdf61490db45; piloto b076e05864c168f88eb303177016543c68583ad7. Branch codex/broker-jrc-2-redesign-homologacao-20261030. Main remota conferida be1e9441146d3ce8f9bc29b2f1b2fd135daf4371. Trabalho anterior e arquivos não rastreados preservados.

Autorização: desenvolvimento, testes isolados, commits e PRs revisáveis. Publicação da candidata solicitada anteriormente: workflow41320633958 concluído. Deploy não executado. Autorização específica recebida para abrir Environment e editar somente JRC_API_IMAGE/JRC_WEB_IMAGE; nenhuma variável foi gravada. Tentativa de clipboard integral bloqueada e abandonada; nenhum segredo foi exportado.

Decisão mais recente exige backup/restore antes da implantação e invalida usar dispensa histórica como gate. Dokploy mostra No backups configured; cópia externa não comprovada. Banco real não foi migrado. Fotografias396FAILED/4UNKNOWN/1382PENDING continuam históricas; nenhuma dessas filas foi reprocessada.

Referência única de andamento: esta pasta. Documentação detalhada anterior preservada em ../broker-jrc-2-redesign-homologacao/ e ../auditoria-900/. Não confundir AUD-Bxx com GO-Bxx; documento GO inicialmente não localizado; localização e leitura posterior registradas abaixo, com correspondência explícita.

Políticas consultadas em01/11/2026: https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App (vigência23/09/2026) e https://business.whatsapp.com/policy (redireciona https://whatsappbusiness.com/policy/, atualização23/09/2026). As regras gerais de opt-in/opt-out e as condições específicas da Platform são distintas; não foram construídas técnicas de evasão. Consulta documental não homologa o Broker.

## Reconciliação posterior do GO400

Localizado e lido integralmente Downloads/Broker_JRC_GO_400_READY_900_Validacao_DEV.docx, versão1.0 de29/10/2026, SHA2561d5f605f229f0658fcb9fc1b92c4f50a3ae1444a719527ea7418f96f7ace5729. Isso substitui o registro anterior de não localização, sem inventar resultados.

|DocumentoGO|Relação com auditoria|Estado|
|---|---|---|
|GO-B01 contratoCCLX|Contratos/entidades; não equivale aAUD-B01|Parcial; depende de fork/grants/aceite externo|
|GO-B02 fonteEvolutiondurável|AUD-B02|Aberto; journalemdesenvolvimento|
|GO-B03 mídianocliente|AUD-B03|Parcial; KEEP; restorefísicocompleto pendente|
|GO-B04 CustodyACK|ParteAUD-B03 e contratosparceiro|Reciboexiste; ACKdeclaratório não comprova cópiafísica|
|GO-B05 inbox/outboxCCLX|Receptor/consumidor; AUD-B12 trata outrodomínio|Simuladoresparciais; CCLXrealnãohomologado|
|GO-B06 sessão/logs|AUD-B05 + recuperaçãosessão/B02/B07|Parcial; semensaioenginerereal|

Divergências resolvidas pela missão maisrecente: piloto50durante30dias antecedeGO400, emvezde400iniciais; 250mil mensagens não equivale a250mil eventos, poisstatus/retries/mídiasmultiplicamtrabalho; backlogzero éaceite deensaiofinito, enquantooperação contínua exige estabilidade/aging. MetasCPU/RAM/pool doGO são propostas, nãocapacidademedida. GO exige24–72h sustentadas para400; isso não foiexecutado.
