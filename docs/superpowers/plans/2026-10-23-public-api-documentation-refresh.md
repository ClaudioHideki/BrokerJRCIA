# Public API documentation and Postman refresh

**Goal:** Document the candidate's real QR identity lifecycle and make the public Swagger, PDF and Postman downloads consistent and safe to run deliberately.

**Scope:** Preserve the 19 generic operations and 15 account-bound control operations. Flow has separate authorization and contracts. Documentation is not proof of external CCLX installation or WhatsApp delivery. No production request, pairing, sending, credential creation, publication, commit or push.

## Tasks

- [x] Record RED for Runner stopping on pending/UNKNOWN/disconnected state and for per-action control mutation opt-in.
- [x] Keep runtime schemas authoritative; annotate actual control errors and actor headers in the canonical OpenAPI generator only.
- [x] Explain new authenticated creation enrollment, finite grants, legacy/manual replacement, GET observation and distinct readiness levels in the shared guide and active runbooks.
- [x] Generate a separate control Postman catalogue from its existing OpenAPI profile; mutations require their own disabled-by-default action flag and stop the Runner after the selected action.
- [x] Bind the PDF manifest to all its authored sources and verify operation count. Regenerate canonical contract, PDF and portal assets.
- [x] Run focused documentation/OpenAPI/Runner tests, inspect rendered PDF pages and verify the diff. The parent owns broader final gates.

## Validation constraints

Use one worker and at most 768 MiB Node heap. The parent authorized a single API TypeScript build for canonical generation before its broader build. Local scripts use synthetic services only; Postman requests are not sent to a real tenant. Test failure must not be the only barrier to a later mutation: the exported scripts must skip the request or terminate the run.

The Runner API follows [Postman's execution documentation](https://learning.postman.com/docs/tests-and-scripts/running-collections/building-workflows/). A failed assertion does not itself authorize continuing the workflow.

## Ledger

- Read-only audit: the existing asset builder passed in memory; four profiles contain 7/7/5/15 real operations, and their read-only collections contain 4/5/3/8 queries. The old PDF checksum gate passed but did not bind the profile generator or PDF authoring source.
- Existing active runbook required manual first identity, while the candidate now enrolls only new authorized bindings automatically. The old generic POC asserted CONNECTED without terminating the Runner on failure.
- Genuine RED: the first seven sandbox cases failed because pending/uncertain/disconnected progress did not terminate the Runner, stale CONNECTED state survived, activation/send lacked the matching instance guard and no guarded control catalogue existed. Two further documentation cases failed for undeclared control failures/actor header and incomplete PDF provenance (eight existing cases passed).
- First GREEN: seven documentation/OpenAPI files passed all 39 tests after canonical regeneration. Only control documentation parameters/responses changed: an independent semantic comparison found no new/removed endpoint, requestBody, security or component changes.
- Review RED: modeling higher-precedence environment/data/local values reproduced eight failures (12 passes): connect/send/revoke accepted substituted IDs, and five mutations accepted resources from another run. The correction ties instance, channel-to-instance and endpoint IDs to the current collection run and refuses shadowed runtime identifiers before HTTP. The empty environment omits those managed names.
- Review GREEN: all 20 Postman sandbox cases passed. Final combined GREEN: seven files / 50 tests, 19.79 seconds, exit 0, one worker and 768 MiB heap. These execute exported scripts with a synthetic pm API; no fresh Newman, provider or production execution is claimed.
- API TypeScript build passed in 3.37 seconds. Canonical generator and ReportLab export succeeded. Asset construction passed in memory for 20 public assets; all 68 exported pre/post scripts parsed across the 19 generic and 15 control requests. All exported keys are empty and write opt-ins false.
- PDF QA: final 24-page A4 manual, 51,336 bytes. Poppler rendered all 24 pages; contact sheet plus identity, pair and campaign pages were inspected. No clipping/overlap was observed; pdfplumber found no character outside any page. Local Poppler emitted fallback warnings for Symbol/ArialUnicode; rendered Portuguese text remained legible. The manifest binds canonical schema, shared guide, profile generator, exporter, PDF authoring source, operation count and exact PDF bytes.
- Diff check passed. The parent froze application/generator/test/provenance inputs for its build and broader gates; only this ledger and local output exports were completed afterward. No production request, real QR, message, credential, bot publication, commit or push was performed by this subagent.
- Final inventory regression RED: the parent's broad gate found only the historical route metadata comparison failing. Reproduction showed 12 Chatwoot routes with newly documented actor/error schemas. Handler review additionally found that the decorator's 429 declaration was unsupported: tenant limits use 409, upstream 429 maps to 502, and the public-ingress limiter excludes control routes. A new OpenAPI assertion failed before that declaration was removed.
- Correction: removed only the control decorator's unsupported 429 and clarified 502 to cover both provider and central. The canonical document was generated by the normal createOpenApiDocument/serializeOpenApiDocument functions loaded from source via Vite SSR with HTTP/HMR disabled; no build was run. The inventory builder supplied only requestSchemas/responseSchemas for 12 existing rows: six actor headers and 107 error declarations. All 264 records, handler locations, authentication, permissions, RLS, ownership, idempotency and exposure classifications remain unchanged; no 347-route replacement snapshot or security-report regeneration was performed.
- Final correction GREEN: eight focused security/documentation/OpenAPI files passed 77 tests in 28.52 seconds (exit 0); public-contract boundary passed. The first attempt passed 76 cases but the synthetic history fixture hit sandbox git EPERM; the identical batch passed after subprocess permission was granted, without changing that fixture or product code.
- Final correction PDF: 24 pages / 51,319 bytes, 34 public operations; all pages re-rendered, overview and control pages visually reviewed, no clipping/overlap or out-of-page text found. The five-source/count/binary provenance gate passed. No control-catalogue page declares 429. The seven exported Postman JSON files remain byte-identical because only error metadata changed. Inputs are frozen again for the principal implementer's separately authorized whole-repository regression.
