# Align error response documentation with runtime tracing

User-authorized scope: accurate Broker API documentation for external integrators.

The existing HTTP onSend hook includes requestId and correlationId in JSON error responses. The strict shared ProblemDetails schema omitted correlationId, so the generated OpenAPI rejected a valid runtime authentication error. Add the optional UUID field while keeping unknown fields rejected and preserving every existing required property. No runtime behavior, route, permission or transport changes.

- RED: the shared contract rejects a synthetic runtime-shaped401 with correlationId, and the OpenAPI regression confirms its field is absent. A third golden-file failure is caused by the newly patched Zod email pattern and requires deterministic regeneration.
- GREEN gate: rebuild, regenerate the canonical OpenAPI, run the focused contract/OpenAPI examples, then the mandatory full suite with the security dependency updates. Confirm the route catalogue remains347 operations.
- Keep customer documentation free of tenant data and customer/product integration names. Regenerate the external19-operation exports from the current canonical schema after the fix.

Evidence: .sessions/api-error-tracing-red-20261026.log (two focused failures plus one generated-artifact drift). The schema fix is additive and does not make error parsing permissive.
