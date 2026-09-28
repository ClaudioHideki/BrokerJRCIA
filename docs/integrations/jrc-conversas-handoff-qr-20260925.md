# Handoff para a máquina de desenvolvimento do JRC Conversas

Data: 25/09/2026. Este arquivo permite comparar a evolução local do módulo QR com a revisão realmente implantada no JRC Conversas. **Não é instrução para publicar o JRC no LAB.** O Broker pode receber uma release incremental separada, mas A1–A4 e a jornada completa entre os produtos continuam pendentes.

## Referências verificadas

- Repositório JRC: `https://github.com/ClaudioHideki/jrc-conversas-nico-v12-2-7-comercial-integrado`.
- Branch de trabalho enviada: `codex/jrc-qr-pair-status-20260925`.
- Base dos módulos: `239c8358666289846e6e0112ea6c38eccfd956ba`.
- Consulta assíncrona de operação QR: `8e2245ef4581eac7a2a4343da7b5dc6c813d7b30`.
- Nova tentativa explícita após timeout/estado incerto, sem repetição automática: `61b120ab71db8c67484e5de9d5dfae9cbdff9eb2`.
- Checkout verificado nesta máquina: `C:\Users\DEV02\Documents\ChatGPT\New project\JRCConversas-qr-contract-20260925`, limpo no commit `61b120a`.
- Imagem JRC informada anteriormente como usada no LAB: tag `sha-f38fe02`. Confirmar no Dokploy o digest e o label de revisão **do contêiner Rails/Sidekiq em execução**, pois a tag/Compose por si só não comprova a revisão executada.

## Contrato introduzido pela branch

O módulo JRC consulta `GET /v1/integrations/chatwoot/control/connections/{connectionId}/pair-operations/{operationId}` no Broker para recuperar QR/código tardio ou estado terminal. A resposta de pareamento conserva `operationId`; o JRC não cria outro `POST pair` em laço. Após timeout ou resultado incerto, uma nova tentativa só é oferecida de modo explícito, depois de conferir o estado da conexão. O Broker desta entrega protege o QR temporário com leitura única e revalida o vínculo após a chamada ao provedor e antes de entregar o código; pausa ou revogação devolve 409 sem código. Se o CONNECT anterior continua incerto, a tentativa permanece bloqueada até reconciliação segura: status `DISCONNECTED` isolado não basta. A leitura única usa `GETDEL`, então uma resposta HTTP perdida pode exigir nova operação depois da reconciliação.

Na branch JRC, foram verificados 33 testes do módulo Vue QR/Flows, lint sem erros e `git diff --check`. Isso é evidência de componente, não de pareamento HTTPS real, autorização entre duas Accounts ou compatibilidade com o digest do Broker que está em produção.

## Procedimento de conciliação na outra máquina

1. Buscar as duas branches remotas e identificar a **revisão real** do JRC em produção pelo contêiner, sem pressupor que `main` ou `sha-f38fe02` representam o que está rodando.
2. Comparar o intervalo `239c835..61b120a` com a branch ativa do DEV03; integrar apenas as alterações de QR ainda ausentes, preservando NICO, CRM, inboxes e migrações em andamento. Evitar reaplicar commits equivalentes pelo nome.
3. Conferir o contrato do endpoint com o commit Broker desta entrega. O JRC antigo deve receber resposta clara caso a operação ainda não exista no Broker; não reativar repetição automática de `POST pair` para mascarar incompatibilidade.
4. Validar grant do usuário/Inbox antes e depois da chamada, pausa/revogação durante o GET, QR tardio, timeout, duas Accounts, reconexão e desvinculação sem apagar histórico.
5. Só após Q3 completo, implementar A1/A2 (sessão de Flow delegada com credencial independente), A3 (um único motor de automação por Inbox com fence/drain) e A4 (handoff/retomada idempotentes). Migrar `jrc_flows` reais por prévia, corte reversível e testes com dados anonimizados.
6. Homologar por HTTPS no LAB com duas empresas e o Broker revisado antes de propor imagem JRC ou deploy. Esta entrega **não** altera o JRC do servidor.

Nenhum token, senha, payload de cliente ou `.env` é necessário para comparar esses commits. Registrar diferenças de schema e ENV por **nomes de variáveis**, nunca pelos valores.
