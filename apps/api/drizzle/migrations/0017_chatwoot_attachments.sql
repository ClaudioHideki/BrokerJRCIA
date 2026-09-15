-- A Chatwoot message may contain several attachments, each with an independent WhatsApp delivery state.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='chatwoot_messages'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%remote_message_id%';
 IF constraint_name IS NOT NULL THEN EXECUTE format('ALTER TABLE chatwoot_messages DROP CONSTRAINT %I',constraint_name); END IF;
END $$;
CREATE INDEX chatwoot_messages_remote_lookup ON chatwoot_messages(organization_id,integration_id,remote_message_id);
