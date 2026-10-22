# Avisos de terceiros

O JRC WhatsApp Broker utiliza componentes da Evolution API como engine interna.

Os textos integrais aplicáveis estão preservados no upstream fixado:

- `upstream/evolution-api/LICENSE`
- `upstream/evolution-api/NOTICE`
- `upstream/evolution-api/TRADEMARKS.md`

O código e a identidade visual próprios da JRC não removem nem substituem essas atribuições. Consulte também `docs/legal/evolution/UPSTREAM.md`.

A console web distribui React, React DOM, React Router, Scheduler, Cookie,
Set-Cookie-Parser e Zod sob licença MIT. O inventário versionado e os textos
integrais que acompanham o bundle ficam em
`apps/web/public/THIRD_PARTY_NOTICES.txt` e são validados pelo gate
`npm run security:notices`.

O gate de armazenamento de CI executa MinIO RELEASE.2025-09-07T16-13-09Z
(Copyright 2015-2025 MinIO, Inc.) sob GNU AGPLv3, sem modificar o vendor.
A origem e o hash do binário e o texto integral da licença estão preservados em
`docs/legal/minio/STORAGE_TEST_FIXTURE.md` e `docs/legal/minio/LICENSE`.
O binário é baixado em diretório temporário do gate e não integra a imagem JRC.
# Swagger UI documentation portal

The public API documentation includes Swagger UI 5.32.6, supplied by the pinned
`@fastify/swagger-ui` dependency. Swagger UI is Copyright SmartBear Software and
licensed under Apache-2.0. The upstream LICENSE, NOTICE and bundled dependency
notices are preserved under `scripts/docs/vendor/` and served with the portal.
No upstream API credentials, engine UI or proprietary source are included.
