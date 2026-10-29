# Public API portal and manual

The public contract is an explicit allowlist of real operations from
`docs/api/openapi.json`. `operation-guide.mjs` adds explanations without modifying
schemas or runtime authorization. It is not the administrative API catalogue.

To regenerate the manual using the authoring Python runtime with ReportLab:

```sh
npx tsc -b apps/api
npm run openapi:generate
node scripts/docs/export-guide.mjs
python scripts/docs/generate-partner-pdf.py
npm run build:web
```

Review rendered pages with Poppler before committing the PDF. The web build fails
if its canonical contract, shared guide, profile generator, exporter, PDF authoring
source, operation count or PDF checksum differs from the manifest. The
PDF is an authored release asset; Python/ReportLab are not production dependencies.
Source text digests normalize CRLF to Git's LF checkout; the PDF digest verifies
the exact binary bytes. Content changes still require regeneration and review.

`build-portal.mjs` packages the local Swagger UI and notices, filtered OpenAPI,
read-only Postman collections, explicit POC and media collections, and PDF. No CDN and no
credential are embedded. The web server serves these files independently of the
SPA/API; missing documents are errors, not console HTML.

## Postman/Newman validation

The four `postman-{instances,messaging,events,chatwoot}.json` downloads contain only
GETs (4/6/3/8 queries); their profiles describe 7/10/5/15 operations. They are not
full write collections. `postman-control.json` covers the existing 15 account-bound
control operations. Each mutation has a separate `allow_*=false` flag, requires
private IDs and a valid control idempotency key, and ends the Runner after its
response. Select only the intended action folder; do not enable every flag.
Identity confirmation is an explicit legacy/replacement decision, not a required
step after every new binding. A new eligible binding enrolls only under the
finite authenticated intent described by the shared guide and runbook.

`postman-media.json` contains three partner operations: binary upload (201),
read-only metadata (200), and reference send (202). Upload and send have separate
`allow_media_upload=false` / `allow_media_send=false` flags; required private
variables and UUID idempotency keys must be supplied deliberately. Run one action
folder at a time. Upload never triggers send, scripts do not copy resource IDs
automatically, and every write stops the Runner after its response. A READY upload
is a storage result; provider delivery still depends on message receipts.

`postman-environment.json` has empty origin/key/resource values and every write
flag false. Fill a private local copy only. The generic key, account-bound control
key and Flow credentials are different contracts; do not merge their scopes or
publish an environment containing secrets. The optional actor header attributes
API-key mutations; campaign reservation requires a numeric remote administrator.

The POC collection has 19 real operations (media download is optional). Writes are disabled by default using
`pm.execution.skipRequest()`; a pre-request exception alone does not prevent HTTP
transmission. Only enable writes for a tenant, recipient and webhook expressly
designated for homologation. Pairing needs human QR scan before continuing.
The collection stops on QR, unexpected status, pending or reconciliation-required
results. The CONNECTED check clears stale state and activation/sending require the
same verified instance. After scanning, resume at the status request. `run_id`
preserves idempotency for that POC; clear it only for a new POC after reconciling
the old one. Connect/disconnect, activation/send and endpoint revocation require
resources created by the same round, including the channel-to-instance link.
Environment/data/local variables must not shadow generated IDs or `run_id`; the
scripts abort before HTTP if they do. The empty environment omits those names;
control-only manual `instance_id` can be filled in its own collection/private copy.
A failed assertion
alone is not a flow barrier: exported scripts use skipRequest/setNextRequest.

The [Postman Runner API](https://learning.postman.com/docs/tests-and-scripts/running-collections/building-workflows/)
supports stopping an iteration with `pm.execution.setNextRequest(null)`; skipping
the current HTTP request uses `pm.execution.skipRequest()` in its pre-request
script. These controls do not certify provider delivery or remote authorization.

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

Focused local gates (no production requests):

```sh
npx vitest run tests/public-api-documentation.test.mjs tests/documentation-assets.test.mjs tests/documentation-client.test.mjs tests/documentation-runtime.test.mjs tests/documentation-source-hash.test.mjs tests/postman-safety.test.mjs apps/api/tests/http/openapi.test.ts --maxWorkers=1 --no-file-parallelism
git diff --exit-code -- docs/api/openapi.json # after regeneration on an otherwise clean contract
git diff --check
```

The script tests execute exported request guards in a synthetic sandbox, including
unsafe progress and disabled mutations. Newman against the local harness verifies
the real route/serializer boundary separately. It is not an end-to-end control,
QR, CCLX or WhatsApp test. The PDF must also be rendered and visually inspected.
