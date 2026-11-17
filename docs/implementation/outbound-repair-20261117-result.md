# Reparo outbound — publicação e aceite parcial de 17/11/2026

## Resultado observado

O bloqueio da intenção humana comprovada foi corrigido e publicado. A intenção original, antes PENDING com zero tentativas, passou a SUCCEEDED com uma tentativa, uma mensagem canônica e confirmação DELIVERED, posteriormente READ. A tentativa antiga de espelhamento permanece UNKNOWN/attempts1/CHATWOOT_OUTCOME_UNKNOWN, sem replay ou limpeza manual.

No teste real adicional, o texto chegou com READ. Uma única mensagem central com três anexos produziu três mensagens canônicas: imagem e PDF chegaram com READ e mídia READY; o áudio Ogg foi rejeitado com MEDIA_TYPE_UNSUPPORTED, mídia FAILED e sem identificador do provedor. Não declarar aceite completo de mídia. O segundo contato autorizado ainda não recebeu testes sintéticos.

O áudio exige verificar o Content-Type efetivamente servido pelo JRC/Active Storage/S3. A falha ocorre na classificação de tipo do download, antes de READY; a origem HTTP exata ainda não foi observada. Imagem/PDF funcionando não provam que os cabeçalhos do áudio estejam corretos. Não alterar estados ou repetir o lote que já teve entregas confirmadas.

## Fontes e versões

| Item | Evidência |
| --- | --- |
| Broker funcional | `4919ace7ac1370bb9c8ecf5dcb062bb7d6f60288`, promovido por fast-forward à main |
| Broker API publicada | `ghcr.io/claudiohideki/brokerjrcia-api@sha256:8af6b58036ae79f8f904e2bc0af8e5d0962573fa628d725102429ed77b316f3b` |
| Assinatura / SBOM / provenance | Workflow de imagem concluído; assinatura GitHub OIDC, SBOM e provenance mode=max |
| Broker web preservada | `sha256:64df750728c785e740ac9bb2c134511422fc2856ef6b1e347b420fdb6fbcc9e4` |
| LAB2 main conferida | `89779191b0b4be44929a426c7a924dbcad4c3690`, sem atualização concorrente na consulta |
| LAB2 funcional restaurado | `d468beb8744856c4bcaa972ecde4d885b60ee432` |
| LAB2 imagem | `ghcr.io/claudiohideki/jrc-conversas-lab2@sha256:21dfe92cdde1b2e8c3da838681bec5684bc87261f9aef2d4e39df0510c5128d4` |

A restauração LAB2 alterou somente a referência da imagem, sem restaurar banco. Init exit0, Rails/Sidekiq no SHA esperado e saúde HTTP200 foram observados. A interface passou a mostrar relógio enquanto a intenção estava pendente e check duplo após a confirmação.

O patch Broker persistido foi relido e comparado integralmente: apenas dez referências da API mudaram. O deploy Dokploy terminou DONE em32s no commit4919ace. A engine, PostgreSQL, Redis e web mantiveram seus IDs de container antes/depois. Nenhum profile maintenance/provision foi executado. Não houve nova migration, backup, dump ou restore. A inspeção final individual de todas as nove réplicas API/worker e a captura sanitizada completa do operational-status ainda precisam ser retidas.

## Testes vinculados ao código publicado

- [CI completa 44087913130](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/44087913130): SUCCESS; build, tipos, testes gerais/frontend/PG/Redis/MinIO, navegador, contratos, segurança e container. A etapa de backup/restore foi SKIPPED por escopo.
- [Regressões 44087913024](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/44087913024): SUCCESS, incluindo47 testes focados, regressões de mídia/PG e MinIO.
- [E2E Broker/LAB2 44087913317](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/44087913317): SUCCESS com Broker4919ace e LAB2d468; Rails/Sidekiq/PG/Redis/MinIO reais, provedor sintético.
- [Imagem 44088757260](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/44088757260): SUCCESS, publicação somente API. Artefato `jrc-image-release-4919ace7ac1370bb9c8ecf5dcb062bb7d6f60288`, ID14330924770.
- TDD documentado no [plano](../superpowers/plans/2026-11-17-proven-human-same-conversation.md): RED inicial, RED de status e RED do segundo anexo antes das respectivas correções. Revisão independente final sem achados críticos/importantes.

## Limites e continuação

O controle do navegador/terminal travou repetidamente após a consulta do áudio, inclusive depois da reinicialização da ferramenta. Isso interrompeu o diagnóstico de MIME e a bateria do segundo contato, sem desfazer o deploy. Não confundir esse bloqueio de acesso com falha de publicação.

Retomar pelo checkpoint operacional local e pelo prompt do pacote de continuidade. Primeiro ler o resultado da consulta já submetida ao Rails sobre os tipos dos anexos sintéticos. Depois comprovar o cabeçalho HTTP do áudio, reproduzir em teste RED, corrigir de forma restrita e executar GREEN/CI/imagem antes de outra publicação. Não flexibilizar genericamente tipos/origens nem reprocessar mensagens UNKNOWN. O aceite global de sincronização de todas as caixas, grupos e acervo histórico continua separado destes testes outbound.
