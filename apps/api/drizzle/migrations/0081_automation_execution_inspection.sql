-- Metadata pagination for the execution explorer. No payload or tenant data is rewritten.
CREATE INDEX automation_execution_inspection_page
  ON automation_executions(organization_id,started_at DESC,id DESC);
