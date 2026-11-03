# Gate de imagem Evolution — candidata isolada

Incremento local posterior a `840168959be211515ca56219761df9209590f681`.
Não publica nem substitui a engine produtiva durante os testes locais.

## Implementação

- `.github/workflows/engine-image.yml`: verifica alterações relevantes em PR e permite publicação apenas por execução manual com `publish=true`. O padrão é não publicar. O workflow novo precisa estar disponível no GitHub para que o disparo manual seja utilizável; a execução de PR não depende de presumir essa disponibilidade.
- Um único build gera o IID. Os quatro testes de admissão, o boot provisionado e o teste do handler real usam esse mesmo IID. A publicação adiciona uma tag ao IID já testado e confere sua igualdade antes do push; não faz outro build.
- PostgreSQL e Redis usam imagens fixadas por digest, bancos e rede descartáveis. Nenhum número ou dado de cliente entra no gate.
- O verificador correlaciona revisão do Broker, pin da Evolution, usuário não root, entrypoint, captura desligada, quatro casos de admissão, cleanup, catálogo SQL preservado e os recibos físicos dos testes.
- O crash exige PIDs distintos, observação efetiva de SIGKILL da origem e término controlado da recuperação. Recibos de processo que já estava morto, PID divergente, efeito legado repetido, canário divulgado ou falta de persistência são rejeitados.
- Custódia por módulos e handler real com socket sintético ficam explicitamente separados de homologação WhatsApp. Ownership continua `UNPROVEN`; captura e sessão produtiva continuam não aprovadas.

## Testes executados

`npm test -- tests/engine-image-workflow.test.mjs --maxWorkers=1`.

- Primeiro incremento: 15/15 GREEN, incluindo 13 contraprovas do contrato do verificador e o contrato de publicação.
- Hardening: RED 11 falhas / 14 controles; depois GREEN 25/25. Os 25 substituem os 15 anteriores, não somam a eles.
- Evidências: `output/engine-workflow-hardening-{red,green}-20261102.{json,log}`.
- YAML interpretado localmente. Revisão independente do agente responsável pela engine conferiu os campos com os produtores dos recibos.

Esses 25 testes usam recibos sintéticos: validam o verificador, não comprovam que a imagem final passou pelos testes físicos. O build e seus quatro testes de admissão e testes provisionados precisam ser executados no IID final. CI, push, assinatura, digest publicado, deploy, propriedade operacional e sessões reais são provas distintas e ainda não são afirmadas por este documento.

Nenhuma rotina de backup, dump, restore ou política de backup é invocada pelo workflow. Ele não executa Compose, migrações produtivas, conexão de números ou deploy.
