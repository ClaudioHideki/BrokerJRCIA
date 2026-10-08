# Primeiro corte P3/P4/C1a/P10a — instalação e teste real

Este documento descreve o procedimento do candidato. Publicação, digests e CI precisam ser registrados no arquivo de release correspondente antes da instalação. O agente não aplicou esta atualização ao servidor. O programa P0–P10 permanece aberto.

## Escopo entregue pelo candidato

- Espera com prazo persistido; simulador com relógio virtual e eventos, sem envio real.
- Horário semanal/fuso/exceções; importação que exige credenciais locais.
- Tentativas e observações de saída QR, correlação pelo ID do provedor, espelhamento sem reenvio e reconhecimento explícito de resultado incerto.
- Pools PostgreSQL configuráveis por componente, encaminhados pelo Compose.
- Diagnóstico local sanitizado e registro offline da matriz de homologação.

Grupos, chamadas com áudio, S3, distribuição de motores QR e Flow delegado ainda exigem seus incrementos próprios. O teste lógico de 500 empresas e 10.000 canais não comprova sessões físicas nem throughput.

## Migração e implantação no Dokploy

1. Registrar as imagens efetivas e uma janela de recuperação com backup restaurável. Preservar volumes, conexões e resultados UNKNOWN.
2. Usar os novos digests API/web da mesma revisão aprovada na main, conforme registro de release. Todos os workers e sandbox usam o digest API. Atualizar também o checkout/Compose; só trocar a imagem não adiciona os novos encaminhamentos dos pools.
3. A última evidência do operador foi `0046_central_transport/true`. Se esse ainda for o baseline, aplicar a cadeia completa `0047_central_dispatch`, `0048_central_cutover` e `0049_qr_outbound_observations`. O migrator aplica a cadeia pendente; não executar SQL avulso nem reinicializar o banco.
4. No Advanced do Dokploy, executar maintenance com o novo digest API:

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

Dokploy acrescenta `docker`. Conferir conclusão e logs do migrator. Restaurar o Run Command padrão e implantar os serviços completos. O deploy normal não executa o profile maintenance sozinho. API, web e workers precisam ser da revisão esperada; Evolution conserva seu digest aprovado e suas sessões.

5. No Open Terminal do container `api`, executar o comando já incluído no binário:

```sh
node /app/apps/api/dist/commands/operational-status.js
```

Esperado: `status: "READY"`, flag V2 `true`, `schema.baseline: "0049_qr_outbound_observations"`, `schema.compatible: true`, banco alcançável e readiness local. Registrar também heartbeats recentes de messaging, automation, automation IO e scheduler, além do estado do lifecycle worker e sandbox. O diagnóstico não consulta o WhatsApp nem identifica a imagem do container; isso exige os registros do Dokploy. Compartilhar somente o JSON sanitizado e metadados de versão, sem `.env` ou tokens.

## Jornada de homologação na conexão Welton

A caixa de testes física existente é preservada. Não substituí-la por transporte CENTRAL para executar este roteiro.

1. Conferir a automação publicada e o vínculo da caixa. Uma conversa em HUMAN/PAUSED exige a ação coordenada de retomada, respeitando a revisão da central; alterar a flag global não muda autoridade humana.
2. De outro WhatsApp de teste, enviar uma mensagem com identificador de homologação. Confirmar ingresso único no Broker e na central, execução/versionamento e resposta do menu. Responder uma opção, capturar uma variável, transferir para time/agente, responder pela central e retomar o bot explicitamente.
3. Enviar pelo aparelho do número conectado uma mensagem para essa conversa. Confirmar que aparece uma vez com a origem externa observada, sem atribuir um agente fictício nem reenviar ao WhatsApp. Conferir que o bot deixa de produzir novas respostas conforme a autoridade da conversa.
4. Responder pela central e comparar IDs de mensagem/recibos. O eco do envio do Broker deve ser classificado como eco, sem criar uma segunda mensagem externa nem outra resposta automática.
5. Exercitar espera e agenda da automação publicada, incluindo mensagem durante a espera, reinício de worker e caminho fora do horário. Comparar o resultado observado com o simulador; simulação não serve como recibo de transporte.
6. Somente em teste controlado, verificar UNKNOWN após falha do provedor/worker: não reenviar automaticamente nem tratar como entregue. Reconhecer a incerteza pelo painel administrativo com motivo e revisão atual; conservar a auditoria e o histórico. Os testes locais cobrem races de exclusão e ingressos tardios; não excluir a conexão Welton para demonstrá-los no servidor.

Para mídia, conferir arquivo recebido, acesso autorizado e mensagem externa única. Um ACK de envio não comprova entrega nem leitura no aparelho. Registrar timestamp, execução, versão, IDs de correlação e resultado, evitando conteúdo real de clientes.

## Aceite por perfil

Repetir a jornada standalone e, depois dos módulos P9, JRC tenants A/B e Chatwoot externo. As fixtures adicionais foram adiadas pelo usuário para o final. Meta e voz exigem ativos/capacidades elegíveis nos perfis correspondentes. A matriz H01–H24 e o registro offline organizam evidências; não aprovam homologação automaticamente nem substituem observação real.

Rollback de imagem exige conferir compatibilidade do schema e estados persistidos. Reversão de uma caixa CENTRAL é operação própria, com histórico e resultado remoto observado; não usar rollback de imagem para apagar pendências ou resultados incertos.
