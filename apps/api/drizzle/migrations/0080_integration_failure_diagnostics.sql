-- Additive last-failure observation. Existing rows remain NULL: no historical
-- response code, request stage or timestamp is inferred from last_error.
ALTER TABLE integration_jobs ADD COLUMN failure_diagnostic jsonb;
ALTER TABLE integration_jobs ADD CONSTRAINT integration_failure_diagnostic_shape CHECK (
 failure_diagnostic IS NULL OR coalesce((
  jsonb_typeof(failure_diagnostic)='object'
  AND failure_diagnostic ?& ARRAY['version','phase','method','httpStatus','attempt','settlement','failedAt']
  AND failure_diagnostic-ARRAY['version','phase','method','httpStatus','attempt','settlement','failedAt']='{}'::jsonb
  AND failure_diagnostic->'version'='1'::jsonb
  AND failure_diagnostic->>'phase' IN ('TRANSPORT','HTTP_STATUS','RESPONSE_BODY','UNKNOWN')
  AND (failure_diagnostic->'method'='null'::jsonb OR failure_diagnostic->>'method' IN ('GET','POST','PATCH'))
  AND (failure_diagnostic->'httpStatus'='null'::jsonb OR
   (jsonb_typeof(failure_diagnostic->'httpStatus')='number' AND failure_diagnostic->>'httpStatus' ~ '^[1-5][0-9]{2}$'))
  AND jsonb_typeof(failure_diagnostic->'attempt')='number'
  AND failure_diagnostic->>'attempt' ~ '^[1-9][0-9]{0,9}$'
  AND length(failure_diagnostic->>'attempt')<=10
  AND CASE WHEN length(failure_diagnostic->>'attempt')=10 THEN failure_diagnostic->>'attempt'<='2147483647' ELSE true END
  AND failure_diagnostic->>'settlement' IN ('RETRY_SCHEDULED','FAILED','UNKNOWN')
  AND jsonb_typeof(failure_diagnostic->'failedAt')='string'
  AND failure_diagnostic->>'failedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 ),false)
);
-- Table-level tenant RLS and existing column grants remain in force. This
-- observation never makes a FAILED job retryable or an UNKNOWN job safe to send.
