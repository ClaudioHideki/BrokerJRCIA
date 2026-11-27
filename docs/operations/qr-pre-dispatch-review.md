# Revisar um espelho QR interrompido antes do despacho

Este procedimento atende um líder SENT, de saída individual observada no WhatsApp, que já tinha destino aprovado e exigia recibo nativo. O trabalho precisa ter um claim, nenhum lease, diagnóstico genérico registrado e o payload original da admissão, sem progresso de operação. Todos os irmãos precisam corresponder à mesma observação e continuar pendentes com zero claims. Existe um caminho separado no produto para uma operação que chegou a gravar evidência de despacho.

Use um processo avulso da imagem API aprovada pelo digest do commit que contém este comando, com a rede e o ambiente do Broker correto. A CLI exige a role `jrc_app` e abre um pool de até duas conexões. Para mídia já armazenada, o processo também precisa da configuração de leitura do objeto. A consulta e a aprovação são executadas com as mesmas opções de escopo. Os valores deste exemplo representam identificadores a preencher a partir da investigação de um único original.

```sh
node apps/api/dist/commands/review-pending-mirror.js --pre-dispatch --org "$ORG" --integration "$INTEGRATION" --job "$JOB" --message "$CANONICAL" --account "$ACCOUNT" --inbox "$INBOX" --conversation "$CONVERSATION"
```

A simulação retorna `ELIGIBLE` e um digest depois de verificar origem QR, sessão/identidade aprovada, escopo, telefone, contato, mídia disponível quando aplicável e família sem mapa, tentativa ou envio físico. A leitura da conversa e de suas páginas pesquisa marcadores da mensagem. O receptor nativo precisa confirmar capacidade e ausência de recibo para o canônico. Somente o 404 JSON específico do receptor vale como ausência. O código HTTP sozinho é inconclusivo.

Para aprovar esse original, repita o comando acrescentando `--approve "$DIGEST"`. A CLI repete as verificações, adquire as travas de configuração e mensagem e revalida o retrato local. Ela recoloca só o líder na fila com o contador e o diagnóstico preservados. A auditoria guarda o digest da decisão. O worker existente volta a verificar a rota e usa o protocolo de recibos para persistir o espelho. Os irmãos dependem do recibo desse líder. Para encerrar o caso, confira o mapa do Broker, o recibo persistido e uma única linha pública no JRC, na caixa, conversa e direção corretas.

O diagnóstico `INTEGRATION_PROCESSING_FAILED` com fase `UNKNOWN` cobre várias exceções. Nesta recuperação, a prova de que o despacho de mensagem não ocorreu vem da ordem durável do worker combinada com o payload original, a família íntegra e as verificações remotas. A limpeza de ciclo que remove o ledger de tentativas também remove a conexão e os próprios trabalhos na mesma transação. Um timeout, conflito, histórico incompleto, recibo existente ou mudança de rota mantém o original em revisão.
