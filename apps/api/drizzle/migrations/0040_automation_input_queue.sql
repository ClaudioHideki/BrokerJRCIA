-- Stable server-side ordering for admitted input, including equal timestamps.
ALTER TABLE automation_events ADD COLUMN queue_sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX automation_pending_inputs ON automation_events(organization_id,execution_id,queue_sequence)
 WHERE status='PENDING' AND type='MESSAGE';
GRANT USAGE,SELECT ON SEQUENCE automation_events_queue_sequence_seq TO jrc_app;
