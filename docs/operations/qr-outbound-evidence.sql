-- Bound parameters: $1 organization UUID, $2 integration UUID, $3 expected account ID,
-- $4 expected inbox ID, $5 expected destination revision, $6 original Rails message ID,
-- $7 independently known Rails conversation ID (NULL marks a missing source field).
-- On 0097 use the security-invoker view qr_traced_dispatch_attempts in place of the final qr_dispatch_attempts relation.
-- SELECT only. Uses JSON access to optional 0097 fields and also runs on 0096.
WITH scope AS (
 SELECT $1::uuid org,$2::uuid integration,$3::bigint account,$4::bigint inbox,
        $5::int revision,$6::bigint remote_message,$7::bigint remote_conversation
), facts AS (
 SELECT s.*,c.channel_id,ch.instance_id,c.status AS connection_status,i.status AS instance_status,
        d.revision=s.revision AND d.approval_status='APPROVED' AND a.account_id=s.account AND c.inbox_id=s.inbox AS current_binding,
        j.id AS job,j.status AS job_state,j.last_error,j.payload,
        o.disposition,o.conversation_id AS observed_conversation,o.remote_conversation_id AS observed_remote_conversation,
        cm.conversation_id AS mapped_conversation,
        CASE WHEN j.payload ? 'attendanceObservationId'
             THEN concat('chatwoot:',s.integration,':',s.revision,':',s.remote_message)
             ELSE concat('chatwoot:',s.remote_message) END AS reply_key
 FROM scope s
 LEFT JOIN chatwoot_connections c ON c.organization_id=s.org AND c.id=s.integration
 LEFT JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
 LEFT JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
 LEFT JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
 LEFT JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id
 LEFT JOIN integration_jobs j ON j.organization_id=s.org AND j.integration_id=s.integration
   AND j.kind='CHATWOOT_REPLY' AND j.payload->>'messageId'=s.remote_message::text
 LEFT JOIN chatwoot_attendance_observations o ON o.organization_id=s.org AND o.integration_id=s.integration
   AND o.channel_id=c.channel_id AND o.account_id=s.account AND o.inbox_id=s.inbox AND o.destination_revision=s.revision
   AND o.id::text=j.payload->>'attendanceObservationId' AND o.event->>'kind'='HUMAN_PUBLIC'
   AND o.event->>'remoteMessageId'=s.remote_message::text AND o.remote_conversation_id=s.remote_conversation
 LEFT JOIN chatwoot_conversations cm ON cm.organization_id=s.org AND cm.integration_id=s.integration
   AND cm.remote_conversation_id=s.remote_conversation
)
SELECT f.remote_message,f.remote_conversation,f.connection_status,f.instance_status,f.current_binding,f.job,f.job_state,
  f.disposition,f.last_error,m.id AS part_id,m.state AS canonical_state,a.id AS attempt,a.state AS attempt_state,
  CASE WHEN f.remote_conversation IS NULL THEN 'ORIGINAL_CONVERSATION_MISSING'
    WHEN f.current_binding IS DISTINCT FROM true THEN 'BINDING_CHANGED_OR_ABSENT'
    WHEN f.job IS NULL THEN 'NO_EXACT_REPLY_JOB'
    WHEN f.payload->>'conversationId' IS DISTINCT FROM f.remote_conversation::text THEN 'JOB_CONVERSATION_MISMATCH'
    WHEN f.payload ? 'attendanceObservationId' AND f.payload->>'destinationRevision' IS DISTINCT FROM f.revision::text THEN 'JOB_REVISION_MISMATCH'
    WHEN f.disposition='WAITING_MAP' AND f.observed_conversation IS NULL THEN 'WAITING_MAP'
    WHEN f.observed_conversation IS NULL THEN 'HUMAN_SCOPE_UNPROVEN'
    WHEN f.mapped_conversation IS DISTINCT FROM f.observed_conversation THEN 'MAP_UNPROVEN'
    WHEN m.id IS NULL THEN 'NO_PROVEN_CANONICAL_PART'
    WHEN a.id IS NULL THEN 'NO_DISPATCH_ATTEMPT'
    WHEN (to_jsonb(a)->'physical_dispatch'->>'version') IS DISTINCT FROM '1' THEN 'NO_RUNTIME_GENERATION_PROOF'
    WHEN to_jsonb(a)->>'key_conflict'='true' THEN 'AMBIGUOUS_PHYSICAL_KEY'
    WHEN to_jsonb(a)->>'physical_response_key' IS NOT NULL AND EXISTS (
      SELECT 1 FROM messaging_status_events e WHERE e.organization_id=a.organization_id AND e.channel_id=a.channel_id
        AND e.provider_scope=to_jsonb(a)->'physical_dispatch'->>'receiptScope' AND e.upstream_message_id=to_jsonb(a)->>'physical_response_key'
        AND e.state='READ') THEN 'EXACT_PART_READ_RECEIPT'
    WHEN to_jsonb(a)->>'physical_response_key' IS NOT NULL AND EXISTS (
      SELECT 1 FROM messaging_status_events e WHERE e.organization_id=a.organization_id AND e.channel_id=a.channel_id
        AND e.provider_scope=to_jsonb(a)->'physical_dispatch'->>'receiptScope' AND e.upstream_message_id=to_jsonb(a)->>'physical_response_key'
        AND e.state='DELIVERED') THEN 'EXACT_PART_DELIVERY_RECEIPT'
    WHEN a.state IN ('DISPATCHED','UNKNOWN','ABANDONED') THEN 'PHYSICAL_OUTCOME_UNCERTAIN'
    WHEN a.state='REJECTED' THEN 'REJECTED_PART'
    WHEN a.state='CONFIRMED' AND a.provider_message_id=m.upstream_message_id
      AND to_jsonb(a)->>'physical_response_key'=a.provider_message_id THEN 'ACCEPTANCE_KEY_MATCHES_THIS_PART'
    ELSE 'PHYSICAL_RESPONSE_UNPROVEN' END AS finding
FROM facts f
LEFT JOIN chatwoot_messages link ON link.organization_id=f.org AND link.integration_id=f.integration AND link.remote_message_id=f.remote_message
LEFT JOIN messaging_messages m ON m.organization_id=f.org AND m.id=link.message_id AND m.channel_id=f.channel_id
  AND m.conversation_id=f.observed_conversation AND m.conversation_id=f.mapped_conversation
  AND m.direction='OUTGOING' AND m.source='OPERATOR'
  AND (m.idempotency_key=f.reply_key OR
    (left(m.idempotency_key,length(f.reply_key)+1)=f.reply_key||':' AND substring(m.idempotency_key from length(f.reply_key)+2) ~ '^(0|[1-9][0-9]*)$'))
LEFT JOIN qr_dispatch_attempts a ON a.organization_id=m.organization_id AND a.message_id=m.id
  AND a.channel_id=m.channel_id AND a.conversation_id=m.conversation_id
ORDER BY f.job,m.id,a.created_at,a.id
