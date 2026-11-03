// App-role structural verification: no job payload, credential or journal read.
export const integrationDiagnosticsRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=pg_catalog.to_regclass('public.integration_jobs')
   AND a.attname='failure_diagnostic' AND a.atttypid='jsonb'::regtype
   AND NOT a.attnotnull AND a.attnum>0 AND NOT a.attisdropped
   AND pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'SELECT')
   AND pg_catalog.has_column_privilege('jrc_app',a.attrelid,a.attnum,'UPDATE'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=pg_catalog.to_regclass('public.integration_jobs')
   AND c.conname='integration_failure_diagnostic_shape' AND c.contype='c' AND c.convalidated)`;
