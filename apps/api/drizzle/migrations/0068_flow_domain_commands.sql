-- Finite native domain commands share the fenced conversation-effect ledger.
ALTER TABLE automation_conversation_effects DROP CONSTRAINT automation_conversation_effects_operation_check;
ALTER TABLE automation_conversation_effects ADD CONSTRAINT automation_conversation_effects_operation_check
 CHECK(operation IN ('tag','attribute','note','resolve','media','domain'));
