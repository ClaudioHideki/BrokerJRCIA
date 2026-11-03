# Servidor — conferência somente de leitura em 02/11/2026

## Limites da evidência

Leitura autenticada do Dokploy e do painel do Broker; consultas PostgreSQL em `BEGIN READ ONLY`, limitadas ao tenant Grupo JRC, e GETs de correlação na integração já configurada. Nenhum deploy, replay, envio, pareamento, alteração de credenciais ou de registro foi executado neste incremento. Sem leitura/exportação de conteúdo de mensagens, telefones, tokens ou anexos.

## Imagens efetivas

| Serviço | Container observado | Referência implantada | ID local da imagem |
| --- | --- | --- | --- |
| API | `789b5174a690` | `ghcr.io/claudiohideki/brokerjrcia-api@sha256:ae6229ed0d67cf2bd582291e4c6275dd641d57fbb75c88931fee14476cff6cd1` | `sha256:20588c6fe707bc2620a8a02840a66beb78c6825e16ec46115f14e4e976570125` |
| Web | `24c829322ed0` | `ghcr.io/claudiohideki/brokerjrcia-web@sha256:466c3d32aaa6729d8d2783bc9001a14ce9cf4cb728b8fd8c9caaf1623bef5546` | `sha256:71a4b917ac3d2dd35dfc02cce4da1a4a0982c1e674a40d6314d0275554f9bc32` |

As referências correspondem às evidências da release `ea7dc741`. Os containers foram criados às 18:50 UTC. A API estava saudável. Os 13 containers estavam em execução; a Evolution permanecia com seis semanas de uptime. Não houve repetição de publicação.

O comando de status do ledger executado com o papel da aplicação retornou `SCHEMA_STATUS_UNAVAILABLE`. Isso não permite atestar novamente os hashes do ledger; a readiness estrutural do painel estava normal. O código restringe a leitura do ledger ao migrador, mas esta consulta não capturou um SQLSTATE que comprove a causa concreta dessa indisponibilidade.

## Entregas e destino

Fotografia do painel às 22:37 UTC: 436 FAILED, 4 UNKNOWN, um destino Chatwoot degradado, uma conexão de integração pausada, 1.031 pendências vinculadas ao destino pausado e 1 UNKNOWN nesse destino. A lista geral mostrava 1.383 pendências. As contagens são fotografias de um sistema ativo, não um inventário imutável.

| Código persistido | FAILED observadas | Limite de interpretação |
| --- | ---: | --- |
| CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION | 119 | Política exigida na execução histórica; não prova a configuração atual |
| CHATWOOT_INVALID_RESPONSE | 19 | Resposta rejeitada pelo contrato; faltam metadados históricos de fase/status |
| CHATWOOT_REQUEST_REJECTED | 9 | Rejeição; sem status histórico suficiente para atribuir uma causa específica |
| GROUP_CENTRAL_SCOPE_CHANGED | 274 | Guarda agrega condições distintas; não identifica sozinha qual condição falhou |
| MEDIA_DOWNLOAD_FAILED | 5 | Download falhou; origem/HTTP/fase não comprovados por esse código |
| MEDIA_TYPE_UNSUPPORTED | 2 | Tipo não aceito; conteúdo não foi inspecionado |
| OTHER | 8 | Classificação insuficiente para causa raiz |

Datas consultadas eram de criação de jobs, não timestamps de falha ou resolução. Uma consulta posterior encontrou **282** jobs `GROUP_CENTRAL_SCOPE_CHANGED` na inbox 1: o total dessa categoria aumentou em oito entre as leituras. Não atualizar a fotografia de 436 por soma inferida sem nova consulta global.

Na consulta posterior, as condições **atuais** desses 282 jobs eram: instância desconectada 0, catálogo ausente 0, catálogo expirado 282, grupo não selecionado 282, mapeamento não pronto 0 e participação não comprovada 251. Isso explica impedimentos atuais para eventual nova tentativa, mas não prova qual guarda causou cada falha histórica. Não foi feita seleção automática de grupos nem replay.

## Quatro UNKNOWN

Todos eram `MIRROR_MESSAGE`, tentativa 1, fase persistida `SEND_MESSAGE`, sem `remote_message_id`. Portanto, houve entrada na etapa de efeito remoto, e a falta de recibo não comprova ausência de mensagem no destino.

| Job | Conversa remota | Leitura de correlação |
| --- | ---: | --- |
| `4c3766f1-b888-45f4-89ad-04a5d2d98f4d` | 399 | Não encontrado na página limitada consultada |
| `a9b57360-9968-436d-9e10-5ade7db5e859` | 528 | `CHATWOOT_REQUEST_REJECTED` |
| `bf6ceecf-7156-443a-a25f-6b7be58476eb` | 6 | Não encontrado na página limitada consultada |
| `d8193227-b00d-4374-b72a-7baa3342c277` | 184 | Não encontrado na página limitada consultada |

O cliente conferiu conta/inbox e buscou `content_attributes.jrc_broker_message_id` por GET. A busca implementada consulta uma página limitada; três resultados negativos não autorizam concluir ausência em todo o histórico. É necessário reconciliar com busca histórica paginada/recibo do consumidor antes de qualquer decisão de reenvio. Nenhum dos quatro registros foi alterado.

## Correção em desenvolvimento

A migration 0080 e o worker candidato registram diagnóstico limitado de fase, método, status HTTP, tentativa, desfecho e instante. A correção tem evidência PostgreSQL em dez testes, incluindo isolamento e UNKNOWN sem segunda chamada. Não reconstrói retroativamente dados que não foram guardados, e ainda não está publicada.

Próximos passos verificáveis: testar reconciliação histórica paginada sem efeitos externos; concluir os gates do candidato; validar a configuração de grupos com o administrador responsável antes de qualquer habilitação ou tentativa real.
