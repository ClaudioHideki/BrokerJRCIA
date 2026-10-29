# API de anexos — evidência da candidata de 29/10/2026

Branch: `codex/broker-experience-20261029`; base do incremento: `ed51ae6767e2e4b43293b10d09acfaed85d0f569`.
Escopo: upload privado, metadados e envio individual QR por referência.
API/web serão publicadas pelo mesmo SHA somente após os gates. Não houve deploy,
migration produtiva, credencial nova ou envio real nesta etapa.

## Contrato implementado

| Operação | Autoridade | Resultado |
| --- | --- | --- |
| POST `/v1/messaging/channels/{id}/media` | `media:upload`, API key atual | 201, ref privada e estado; não envia |
| GET `/v1/messaging/channels/{id}/media/{mediaId}` | `media:upload`, API key atual | 200, metadados sanitizados; não faz PUT |
| POST `/v1/messaging/channels/{id}/partner-media` | `messaging:send` e `media:send` | 202, admissão na outbox; entrega por recibos |

Corpo binário validado, 1 byte a 16 MiB, imagem até 5 MiB; legenda até 1.024
caracteres. Referência READY no mesmo tenant/canal BAILEYS/BROKER_TRANSPORT aberto.
Idempotência separada por intenção, sem repetir PUT/envio incerto. Chaves antigas
não recebem escopos por padrão. A rotação preserva referências do tenant, sem
dispensar autoridade atual. Migration aditiva `0074_partner_media`, sem mudar
migrations históricas ou adicionar tabela de tenant.

## Verificação local e revisão

- TDD: contratos, escopos, upload/metadata/send, recuperação após revogação,
  idempotência, channel archive, navegação e sincronização de catálogos tiveram
  falhas demonstradas antes de suas correções.
- Primeira suíte geral: 451 arquivos passaram / 2 falharam; 3.516 testes passaram /
  2 falharam. Inventário OpenAPI e barreira de catálogo foram corrigidos.
- Regressão final congelada: `npm test -- --maxWorkers=4`, **454 arquivos /
  3.525 testes passaram**, exit 0, 308,46 s. Git/OpenSSL no PATH process-local;
  nenhum skip ou retry foi acrescentado para aprovar a execução.
- OpenAPI/portal/PDF: 22 testes passaram após ajustar inventário. PDF de oito
  páginas / 37 operações, exemplos validados contra schemas, renderização revisada.
- Build de produção passou; scanner de bundle: 32 arquivos, nenhum finding.
- Contratos públicos e notices passaram. O gate de submodule exige Git nativo no
  PATH process-local em Windows; o wrapper cmd apresentou EPERM, sem mudança de produto.
- Três P2 da revisão independente foram corrigidos e reavaliados: PUT recuperado
  após revogação, HTTP409 e expiração durante lock wait. Rechecks não adquirem
  locks fora de ordem; SQL também revalida o relógio após obter o lock da chave.
  Revisão final sem P1/P2 pendente neste incremento, condicionada aos gates da CI.
- Newman 6.2.3 real contra API loopback sintética: seis guards geraram zero HTTP;
  três pastas separadas executaram 201/200/202, três assertions, zero falhas.
  Exatamente um upload, uma leitura e uma admissão sintética; nenhum provider send.
  Portal servido pelo build confirmou perfil 29/10, três pastas de anexos com
  flags false e PDF application/pdf de 22.252 bytes. Não é prova de produção.

## Gates de publicação

Full suite local, build/typecheck, diff check e revisão independente final
passaram. Ainda exigida CI bem-sucedida do SHA exato. A CI usa PostgreSQL,
Redis, MinIO fixado, browser journeys, container entrypoint, restore isolado e
checks de segurança. Docker local indisponível não foi substituído por produção.

Após aprovação, o workflow `images.yml` com `publish=true`, `component=all` cria
tags de SHA completo, SBOM/provenance e assinatura GitHub OIDC. Conferir artifact
`image-release.json` e digests independentes no GHCR antes de anunciar publicação.
Usar API/web da mesma revisão; workers usam a imagem API. Deploy/migration no
servidor são outra etapa e não foram executados por esta candidata.

## Limites e roteiro externo

Não houve mensagem, upload ou chamada a provedor real. Testes sintéticos de
contrato/Postman não certificam entrega, reprodução de mídia, CCLX instalado ou
sessões produtivas. Homologar essas fronteiras com ativos e ambiente próprios.
Meta, grupos, voz e publicação pública de Flow permanecem fora deste recorte.
