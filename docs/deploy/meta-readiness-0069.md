# Atualização Meta — baseline 0069

Esta entrega altera somente o Broker (API e web). Não exige trocar a imagem do JRC Conversas ou do runtime NICO. Não cadastra números nem ativa automações. Publicação de imagem e implantação no servidor são etapas distintas.

## Alterações

- Páginas públicas `/privacy`, `/data-deletion` e `/terms`, disponíveis sem login ou JavaScript, com os dados da OPERADORA JRC TELECOMUNICACOES LTDA fornecidos pelo responsável. Os textos precisam da avaliação jurídica da empresa antes da liberação comercial.
- Uma WABA pertence a uma organização do Broker; essa organização pode ter vários números. A propriedade permanece reservada após revogação ou exclusão de uma conexão. Não existe transferência automática entre clientes.
- `messages` mantém o processamento existente. Os sete eventos de gestão assinados na Meta são reconhecidos e registrados por nome, hash e data de recebimento, sem armazenar o corpo bruto. Eventos de conta/número invalidam a prontidão de todas as conexões afetadas antes da consulta Graph. Falhas de consulta mantêm a conexão pendente. Eventos de template ficam visíveis; a aprovação continua sendo consultada no Graph antes do envio.
- Cadastro incorporado recupera cancelamento, erro de SDK e tentativa com estado consumido, ignorando retornos atrasados. Revalidação antiga não pode sobrescrever uma autorização ou notificação mais recente.

## Dokploy — serviço Broker

1. Em Environment, substitua somente `JRC_API_IMAGE` e `JRC_WEB_IMAGE` pelos digests verificados da entrega. Preserve as demais variáveis. API, migrador e workers devem usar a mesma imagem de API.
2. Salve. Em Advanced → Run Command, use temporariamente:

```sh
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

3. Salve e execute General → Deploy para rodar o migrador com PostgreSQL já ativo. Se aparecer `META_WABA_OWNERSHIP_CONFLICT`, pare e reconcilie o vínculo entre empresas; não ignore a migração nem escolha um proprietário automaticamente.
4. Após o migrador terminar com sucesso, apague Advanced → Run Command, salve e execute General → Deploy novamente. O comando normal inicia/recria API, web e workers. Não execute `down --volumes`.
5. No Terminal do container `api`, com `/bin/sh`, execute:

```sh
node /app/apps/api/dist/commands/operational-status.js
```

O esperado é `status: READY`, `schema.baseline: 0069_meta_waba_ownership`, `schema.compatible: true` e `readiness.httpStatus: 200`. Isso comprova prontidão técnica, não entrega de mensagens nem aprovação comercial da Meta.

6. Abra as três páginas públicas e a tela Conectar WhatsApp Oficial. Os avisos de gestão aparecem após eventos assinados serem recebidos. Ainda será necessária homologação com ativos de teste para comprovar autorização real, assinatura, recebimento, envio e vinculação ao atendimento.

## Limites e operação

- Nenhum número de produção precisa ser conectado para implantar esta entrega.
- Os testes de integração utilizam Graph simulado e PostgreSQL isolado. Não comprovam permissões aprovadas, cadastro comercial, faturamento ou comportamento de uma conta Meta real.
- Duplicatas idênticas de eventos são ignoradas por conexão. Uma consulta Graph que falhe deixa a conexão pendente; use a revalidação da conexão após resolver a causa.
- A migração acrescenta tabelas, restrições e uma revisão de prontidão; não apaga histórico. A reserva de propriedade pode bloquear cadastros que anteriormente vinculavam uma WABA a empresas diferentes, de forma intencional.
