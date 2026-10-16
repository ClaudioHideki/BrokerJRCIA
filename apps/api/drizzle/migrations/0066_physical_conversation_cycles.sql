-- Covers all historical cycles of a physical contact. Existing partial uniqueness
-- still selects exactly one current route; no messages or mappings are rewritten.
CREATE INDEX messaging_conversations_contact_cycles
 ON messaging_conversations(organization_id,channel_id,contact_id,id);
