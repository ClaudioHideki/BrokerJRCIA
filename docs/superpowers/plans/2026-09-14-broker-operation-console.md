# Ampliação da console operacional do broker

Continuação do escopo de broker aprovado, guiada pelas capturas Evolution 2.3.7 fornecidas pelo usuário. Preservar conexão humana já pareada, dados, multitenancy e restrições de publicação. Referência Ligo recebida: https://ligo.cloud/plataforma/bots/. Comparação documentada em docs/operations/console-broker-modulos.md; painel privado exige autenticação.

## Diferenças observadas

| Referência | JRC antes desta ampliação | Trabalho necessário |
|---|---|---|
| Cartão com identidade e contagens | Nome e estado | Perfil e indicadores reais por instância |
| Dashboard da instância | Conectar/desconectar | Painel de identidade, sessão, indicadores e navegação contextual |
| Settings | Ausente | Leitura e edição autorizada de configurações Baileys |
| Chat, contatos e histórico | Mensageria Meta parcial | Inbox Baileys com paginação e política de acesso; trilha própria |
| Eventos/Webhook | Webhook Meta de entrada | Histórico operacional agora; entrega de webhook JRC, assinatura/retry e DLQ em trilha própria |
| Proxy | Ausente | Credenciais cifradas, validação de destinos e permissão de configuração |
| WebSocket/RabbitMQ/SQS | Sem configuração por cliente | Definir contratos e infraestrutura; não expor credenciais globais |
| Typebot | API ligada aos canais Meta | Apresentar vínculo e ampliar ingestão/saída Baileys |
| n8n/Chatwoot/OpenAI/Dify/Flowise/EvoAI | Ausente | Adaptadores específicos; não simular disponibilidade |
| Administração JRC | Cadastro/limites/suporte | Visão agregada e organização das áreas administrativas |

## Implementação corrente

- [x] Gateway privado de informações e configurações de instância, com DTO restrito e timeout/tamanho limitados.
- [x] Rotas JRC de painel e configurações: JWT/membership atual, instância e organização validadas antes do provider; API keys legadas recusadas; alterações OWNER/ADMIN e auditoria.
- [x] Dashboard contextual da conexão, perfil/número, contagens, detalhes da sessão, histórico operacional e configurações; dados indisponíveis diferenciados de zero.
- [x] Busca/filtro na lista e organização da administração com indicadores baseados nos dados disponíveis.
- [x] Testes de segurança/regressão e validação local com duas empresas; nenhuma alteração de configuração ou envio na sessão real para teste.
- [x] Atualizar imagens API/web sem reiniciar o motor conectado; documentar matriz de entrega e pendências reais.

As contagens do motor representam registros sincronizados/persistidos e não prometem todo o histórico do telefone. Tokens, senhas, QR e JIDs brutos não entram em DTOs de painel. Mudanças de configuração são registradas antes da chamada externa e finalizadas com resultado observado; falha de rede é resultado desconhecido, nunca sucesso fictício.
