-- Published graphs keep their data semantics for every future conversation.
-- Existing versions and older writers remain textual; new publications opt into JSON.
ALTER TABLE automation_versions ADD COLUMN runtime_state_version integer NOT NULL DEFAULT 1
  CONSTRAINT automation_versions_runtime_state_version_check CHECK (runtime_state_version IN (1,2));
