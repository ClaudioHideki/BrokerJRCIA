# Broker para a versão JRC Conversas com Flows

Direção do usuário em 17/09: focar no JRC Conversas próprio. Flows executa em Rails/Sidekiq, e o Broker continua transporte/controle das conexões. O editor React experimental permanece em branch separada, fora desta entrega.

Consolidar main remoto a16c1cd com as alterações locais até ce878f8. Resolver o Compose preservando a configuração do servidor e as novas flags. Manter a credencial de administração somente na API, conforme a arquitetura aprovada. Testar o código, contratos e configuração resultantes. Preparar imagens API/web e guia de atualização; não fazer deploy nesta tarefa.

Integração nativa usa CHATWOOT_CONTROL_ENABLED; a aba incorporada para Chatwoots externos permanece beta com CHATWOOT_EMBED_ENABLED=false. Destinos por organização requerem aprovação administrativa mesmo no caso JRC.
