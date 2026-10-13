# Subfluxos versionados no Broker

O Studio permite selecionar uma automação publicada pelo nome e pela versão, sem preencher UUID manualmente. A referência escolhida continua fixa quando outra versão é publicada. O catálogo pertence à empresa autenticada e à automação raiz autorizada; retorna somente metadados e usa paginação por ID/versão, sem truncar o total em 200 registros.

Validação, simulação, publicação e worker usam o mesmo preparador de dependências. O motor recebe cópias imutáveis, sem consultas de rede. Novas publicações recebem `dependencyPolicyVersion: 1` pelo servidor, dentro do checksum: até oito chamadas na pilha, 32 versões únicas incluindo a raiz e 2 MiB UTF-8 agregados. A publicação revalida as dependências na transação final.

Raízes históricas preservam seu grafo, checksum e política original, inclusive uma cadeia de nove chamadas. Filhas já fixadas permanecem legíveis após arquivamento. Espera e substituição do worker mantêm a versão e a política da raiz. Pai e filha compartilham variáveis conforme a semântica existente; o retorno segue a porta `next`.

## Evidências do corte

O candidato foi congelado contra a main `42e58901f0c6d1745a26d6b90d57fc1674c769f2`, baseline `0052_durable_private_media`. Os 19 arquivos foram promovidos somente após conferência dos hashes e revisão independente sem achados críticos ou importantes. Patch revisado: `18488e8f42a7515ba45efc4d65a28d1c8d8994fdf64205deecf580442582a57c`.

- 85 testes de contratos, serviço, HTTP, motor, simulação e regressões focais aprovados.
- 11 testes de editor/canvas aprovados.
- Dois cenários PostgreSQL reais aprovados: espera/reinício, versões imutáveis/arquivadas, RLS entre empresas e compatibilidade histórica.
- O guard confirmou os 19 destinos e todas as evidências congeladas.

A integração habilita `subflow` na paleta e alinha sua matriz documental. A compilação e o CI da revisão publicada verificam o código consolidado. As suítes locais já aprovadas não são repetidas para produzir uma contagem maior.

O primeiro CI da main `3673d59171d6531f5e03c57c7e08dea0f632fab7` falhou antes de gerar imagens. Quatro ajustes de integração foram identificados: registro explícito da nova rota no inventário de segurança/OpenAPI, expectativa antiga de subflow indisponível, fixture do motor sem a versão filha resolvida e ausência de ambiente jsdom no novo teste do editor. A correção preserva a implementação e acrescenta uma asserção para a autorização/metadados da rota. Os três arquivos de contratos/motor/editor passaram 46 testes; os três critérios afetados de OpenAPI/inventário também passaram. As suítes aprovadas do candidato não foram repetidas. A publicação das imagens depende do CI da revisão corrigida.

## Instalação e limites

Esta entrega não acrescenta migration, Compose ou ENV. A baseline continua 0052. Uma instalação ainda na 0051 precisa aplicar primeiro a migration de mídia privada prevista na release C2; trocar somente o container web não atualiza API e workers.

O catálogo comum do Studio não concede autorização delegada a caixas de uma central. Flow/QR incorporados ao JRC Conversas têm contratos e grants próprios. As provas acima não demonstram envio físico de WhatsApp, instalação no servidor ou capacidade de 10.000 conexões. A jornada real será registrada após instalar as imagens correspondentes ao mesmo SHA.
