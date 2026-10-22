# Public API portal and manual

The public contract is an explicit allowlist of real operations from
`docs/api/openapi.json`. `operation-guide.mjs` adds explanations without modifying
schemas or runtime authorization. It is not the administrative API catalogue.

To regenerate the manual using the authoring Python runtime with ReportLab:

```sh
npm run openapi:generate
node scripts/docs/export-guide.mjs
python scripts/docs/generate-partner-pdf.py
```

Review rendered pages with Poppler before committing the PDF. The web build fails
if its canonical contract, guide or PDF checksum differs from the manifest. The
PDF is an authored release asset; Python/ReportLab are not production dependencies.

`build-portal.mjs` packages the local Swagger UI and notices, filtered OpenAPI,
read-only Postman collections, the explicit POC collection and PDF. No CDN and no
credential are embedded. The web server serves these files independently of the
SPA/API; missing documents are errors, not console HTML.

## Postman/Newman validation

The POC collection has 19 real operations (media download is optional). Writes are disabled by default using
`pm.execution.skipRequest()`; a pre-request exception alone does not prevent HTTP
transmission. Only enable writes for a tenant, recipient and webhook expressly
designated for homologation. Pairing needs human QR scan before continuing.

The local contract harness uses the actual Fastify routes, authentication guards,
validators and serializers with explicitly synthetic services/provider. It does
not certify WhatsApp, PostgreSQL durability or external CCLX behavior. PostgreSQL
integration tests cover persistence separately.

```sh
npm run build
node scripts/docs/postman-contract-harness.mjs
# In another terminal; only the local synthetic environment generated above:
npm exec --yes --package=newman@6.2.3 -- newman run .sessions/postman/collection.json --environment .sessions/postman/environment.json --bail
```

Do not share raw Newman reports from a real tenant: they can contain headers,
messages, transient QR data and webhook signing secrets. Deliver only sanitized
counts/evidence. The local harness contains fictional data only.
