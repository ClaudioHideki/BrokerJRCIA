export const inputTimeoutRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.automation_waits')
   AND attname='deadline_at' AND atttypid='timestamptz'::regtype AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.automation_events')
   AND attname='admitted_at' AND atttypid='timestamptz'::regtype AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.automation_waits')
   AND conname='automation_input_deadline' AND contype='c' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.automation_due_input_waits') AND indisvalid)
`;
