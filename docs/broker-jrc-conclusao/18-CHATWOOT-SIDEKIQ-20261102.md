# Incremento — contrato comum e Sidekiq real

Continuação do escopo definitivo Chatwoot/CCLX/JRC Conversas, preservando Brokerf79d4a6 e LAB201fd99c6. Sem mudança de engine, migration, segredo ou recurso produtivo. O workflow anterior do LAB2 permanece fora do diff.

## Código alterado

No backend externo `integrations/partner-qr/backend.mjs`, uma autorização lida somente no início podia sobreviver à revogação ou troca de tenant durante o HTTP. Três testes reproduziram resposta200 após revogação/troca e POST indevido após o preflight. A correção reautoriza antes de cada POST e antes da resposta; o tenant inicial é capturado como string imutável; listas aplicam o escopo atual além do escopo inicial. O hook continua sendo responsabilidade do backend do host, com CSRF e credencial permanente fora do navegador.

Revogação após uma mutação remota não desfaz o efeito: resposta é bloqueada, a intenção permanece incerta e o painel preserva sua chave. Não há segundo POST automático nem desconexão para esconder o resultado.

Testes RED:3 falhas/21 passes no backend. GREEN:37/37 no backend+painel. Comando final obrigatório do repositório também passou com37/37 em11,30s. Revisão independente não encontrou novoP1/P2 nem assertions removidas. A API pública Broker não mudou; esses caminhos `/jrc-qr` são BFF externo, não novas rotas publicadas do SaaS.

No LAB2, foram versionados `spec/homologation/broker_sidekiq_{control,worker}.rb` e README. O entrypoint recusa ambiente/banco errados antes do boot, usa apenas uma fila de laboratório e bloqueia o carregamento geral de cron. Ruby syntax e boot do worker protegido foram verificados. A consulta Redis não encontrou chaves de cron. Não se iniciaram agendamentos agregados, backup, dump ou restore.

## Sidekiq real executado

Rails7.1.5.2, Sidekiq7.3.1, Redis7.4 e PostgreSQL16/pgvector reais, em containers exclusivos com rede interna e sem portas públicas. Nenhum .env privado foi usado. ActiveJob trocou para adapter Sidekiq nos produtores/worker deste probe, sem mudar configuração da aplicação.

1. Duas contas sintéticas independentes dentro do LAB2 geraram duas obrigações. Jobs foram realmente publicados no Redis.
2. Worker com concurrency1 recebeu SIGKILL (exit137) após o COMMIT do primeiro recibo no receptor PostgreSQL modelado, antes de liquidar a obrigação.
3. Novo processo publicou recuperação e duplicatas. O lease do fixture foi expirado controladamente para evitar esperar cinco minutos; isso não valida o decurso real desse TTL.
4. Sidekiq reiniciado consumiu a fila. Resultado:duas obrigações delivered, tentativas2/1, dois recibos distintos, cada um vinculado à sua conta e ao hash do corpo; nenhum efeito adicional para jobs duplicados.

A primeira verificação deu DELIVERY_TIMEOUT por query cache do observador Rails de longa duração. SQL independente demonstrou que ambas já estavam delivered. O observador foi corrigido para leitura uncached e passou sem reenvio. Erro e resultado posterior foram preservados, sem chamar essa falha de perda de mensagem.

O receptor usa porta sintética com PostgreSQL real: não há HTTP/TLS/WhatsApp no transporte desse teste. São duas contas em uma instalação, não dois consumidores Chatwoot independentes e não a instalação CCLX. O probe cobre crash real do worker e processamento Redis, não perda do Redis, codecs ou custódia física de mídia. O bloqueio adicional de cron e os caminhos relativos dos probes versionados tiveram boot próprio; o cenário de crash foi executado pelo snapshot original dos scripts incluído no pacote.

## Contrato e pendências

`17-CONTRATO-COMUM-CHATWOOT-20261102.md` registra arquitetura, identidades, rotas reais, quatro eventos públicos e os limites dos providers. Nenhuma compatibilidade Meta foi inferida a partir do kit QR. A versão/fork CCLX e seus pontos de extensão continuam desconhecidos; não foi acessado ou alterado o cliente. O fluxo legado informado está rotulado como relato e os fluxos de entrada/protocolo/roteamento ainda exigem código ou amostras sanitizadas autorizadas.

O kit QR é externo e reutilizável, não depende do LAB2 completo. Ele exige sessão/credencial no host; não é instalador autônomo autenticado do CCLX, não implementa o adaptador de mensagens e não pode ser declarado nativo. O portal Broker já existente não se instala automaticamente dentro do Chatwoot. Essas diferenças são mantidas na matriz de aceite.

Próximos gates:segundo Chatwoot stock isolado identificado, sem copiar LAB2; percurso real TLS/webhook/API bidirecional; mídia privada e recibo/readback; Meta no módulo; adaptação legada CCLX com versão/acesso/autorização. Fonte engine/journal e migration0079 permanecem preservadas; imagem final/ownership, CI do candidato e capacidade continuam pendentes. Nenhum número, mensagem ou replay real nesta rodada.
