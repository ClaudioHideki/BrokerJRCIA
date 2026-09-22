# Condições operacionais locais

Estas condições são sinais de diagnóstico. Elas não constituem um SLO contratual.

| Código | Condição | Ação operacional |
|---|---|---|
| `SCHEMA_INCOMPATIBLE` | A migration `0028` não está aplicada | bloquear publicação e aplicar migrations revisadas |
| `WORKER_HEARTBEAT_STALE` | heartbeat com mais de 45 segundos | conferir container, dependências e último correlation ID |
| `WORKER_NEVER_OBSERVED` | nenhum heartbeat para o tenant | conferir se o serviço está implantado e se há canal/automação |
| `OUTBOX_AGED` | item mais antigo acima de 300 segundos | inspecionar outbox e provider sem reenviar itens `UNKNOWN` |
| `QUEUE_DEPTH_HIGH` | mais de 1.000 itens pendentes | verificar capacidade, bloqueios e degradação externa |
| `CHATWOOT_DESTINATION_DEGRADED` | identidade, acesso ou conexão do destino falhou | testar destino e credencial aprovada |
| `UNKNOWN_GROWTH` | existe execução em estado incerto | abrir Execution Explorer e reconciliar o efeito |
| `WEBHOOK_FAILURE_REPEATED` | três ou mais falhas consecutivas na janela operacional | validar assinatura, destino e replay; manter token redigido |

## Regras para `UNKNOWN`

1. O dispatcher grava `UNKNOWN` antes de executar o efeito externo.
2. Uma queda de processo não produz reenvio automático.
3. O operador consulta o provider pelo correlation ID e referência externa.
4. `CONFIRMED_SENT` encerra o item como enviado.
5. `CONFIRMED_NOT_SENT` é a única decisão que devolve o item à fila.
6. `UNRESOLVED` mantém o bloqueio.
7. Toda decisão registra operador, evidência padronizada, resultado e horário, sem conteúdo da mensagem ou segredo.

## Rastreamento

O Execution Explorer deve ser usado na ordem: entrada, canal, execução, versão, node, outbox, provider ou destino e resultado. Logs JSON carregam `correlationId` e o UUID interno da organização. O redator central remove corpo, cabeçalhos de autenticação, cookies, tokens, QR Codes, telefones e credenciais.
