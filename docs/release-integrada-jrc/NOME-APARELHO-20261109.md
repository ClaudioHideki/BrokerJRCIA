# Nome do aparelho vinculado — Broker JRC

Incremento solicitado em 09/11/2026. Base: `56f9e772c9331710bed65d1d46a4f925f3d3d86d`, preservando a integração de documentos/URA Branef. Nenhuma alteração na engine, credenciais, dados, pareamentos ou sessões produtivas.

O serviço `evolution` do Compose passa a encaminhar `CONFIG_SESSION_PHONE_CLIENT` (padrão **Broker JRC**) e `CONFIG_SESSION_PHONE_NAME` (padrão **Chrome**). São os parâmetros de identificação suportados pelo motor, sem alterar o protocolo Baileys ou remover licenças/atribuições do código.

O nome solicitado é enviado nos novos pareamentos. O WhatsApp pode manter o nome previamente armazenado em aparelhos existentes e pode apresentar o navegador/sistema operacional junto da marca. Não há garantia de que renomeie retroativamente todas as sessões. Não desconectar/reparear clientes automaticamente para mudar o rótulo.

No Dokploy, a aplicação futura exige que o Compose efetivo contenha as duas entradas de ambiente do serviço, além de preservar a imagem pinada atual do motor. Alterar somente ENV sem encaminhar os valores pelo Compose não modifica o ambiente do container. Não é necessário reconstruir ou substituir a engine para estas duas variáveis.

Validação: teste de regressão da renderização `docker compose config --format json`, sem daemon, credenciais de registro ou chamadas de WhatsApp. O teste verifica o padrão e uma marca personalizada. Homologação do nome mostrado pelo aplicativo depende de um novo pareamento autorizado; não executada neste incremento.

Referência upstream: `EvolutionAPI/evolution-api`, configuração de sessão de aparelho. A identidade Chrome foi preservada por compatibilidade; não usar nomes arbitrários como nome do navegador.
