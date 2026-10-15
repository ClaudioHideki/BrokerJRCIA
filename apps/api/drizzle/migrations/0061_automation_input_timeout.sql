-- Explicit versioned input waits only. Historical EVENT/DELAY/IO remain unchanged.
ALTER TABLE automation_events ADD COLUMN admitted_at timestamptz;
UPDATE automation_events SET admitted_at=created_at WHERE type='MESSAGE' AND execution_id IS NOT NULL;
ALTER TABLE automation_waits ADD COLUMN deadline_at timestamptz;
ALTER TABLE automation_waits ADD CONSTRAINT automation_input_deadline CHECK(deadline_at IS NULL OR kind='EVENT');
CREATE INDEX automation_due_input_waits ON automation_waits(organization_id,deadline_at,execution_id)
 WHERE status='WAITING' AND kind='EVENT' AND deadline_at IS NOT NULL;
