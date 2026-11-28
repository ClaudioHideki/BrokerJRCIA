-- $1 is one reviewed Rails proof, $2 defaults to dry run when NULL.
WITH evidence AS (
 SELECT * FROM jsonb_to_record($1::jsonb) AS p(organization_id uuid,job_id uuid,channel_id uuid,integration_id uuid,
   intent_id uuid,account_id bigint,inbox_id bigint,conversation_id bigint,message_id bigint,sender_id bigint,
   base_url text,original_sha256 text,admitted_sha256 text,suffix_hex text,reviewed_no_equivalent_delivery boolean)
), candidate AS (
 SELECT j.id,j.organization_id,j.payload,j.updated_at,p.original_sha256,p.admitted_sha256,
        (j.payload#>>'{content,text}') || convert_from(decode(p.suffix_hex,'hex'),'UTF8') AS restored
 FROM evidence p JOIN integration_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id AND j.integration_id=p.integration_id
 JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id AND c.status='READY'
   AND c.inbox_id=p.inbox_id AND c.channel_id=p.channel_id
 JOIN chatwoot_accounts a ON a.organization_id=c.organization_id AND a.account_id=p.account_id AND a.status='READY' AND rtrim(a.base_url,'/')=rtrim(p.base_url,'/')
 JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url AND d.approval_status='APPROVED'
   AND d.revision::text=j.payload->>'destinationRevision'
 JOIN chatwoot_attendance_observations o ON o.organization_id=j.organization_id AND o.integration_id=c.id AND o.channel_id=c.channel_id
   AND o.id::text=j.payload->>'attendanceObservationId' AND o.destination_revision=d.revision AND o.credential_revision=a.credential_version
   AND o.account_id=p.account_id AND o.inbox_id=p.inbox_id AND o.remote_conversation_id=p.conversation_id AND o.event->>'remoteMessageId'=p.message_id::text
   AND o.event->>'senderId'=p.sender_id::text AND o.event->>'outboundIntentId'=p.intent_id::text AND o.event->>'kind'='HUMAN_PUBLIC'
   AND o.event->>'mayForwardReply'='true' AND o.disposition='APPLIED'
 JOIN chatwoot_conversations cm ON cm.organization_id=j.organization_id AND cm.integration_id=c.id AND cm.remote_conversation_id=p.conversation_id
   AND cm.conversation_id=o.conversation_id
 WHERE p.reviewed_no_equivalent_delivery IS TRUE AND j.status='FAILED' AND j.attempts=1 AND j.last_error='CHATWOOT_HUMAN_INTENT_NOT_PROVEN'
   AND j.kind='CHATWOOT_REPLY' AND j.message_id IS NULL AND j.lease_token IS NULL AND j.lease_expires_at IS NULL
   AND j.dedupe_key=concat_ws(':','reply',d.revision,a.account_id,c.inbox_id,p.message_id)
   AND j.payload->>'attendanceKind'='HUMAN_PUBLIC' AND j.payload->>'outboundIntentId'=p.intent_id::text
   AND j.payload->>'messageId'=p.message_id::text AND j.payload->>'conversationId'=p.conversation_id::text
   AND NOT (j.payload ?| ARRAY['campaignIntentId','attachments','caption']) AND j.payload#>>'{content,type}'='TEXT'
   AND length(j.payload#>>'{content,text}')>0 AND p.suffix_hex ~ '^(0d0a|0a)+$' AND length(p.suffix_hex)<=8192
   AND encode(sha256(convert_to(j.payload#>>'{content,text}','UTF8')),'hex')=p.admitted_sha256
   AND NOT EXISTS(SELECT FROM chatwoot_group_scopes g WHERE g.organization_id=j.organization_id AND g.integration_id=c.id AND g.remote_account_id=p.account_id AND g.remote_inbox_id=p.inbox_id AND g.remote_conversation_id=p.conversation_id)
   AND NOT EXISTS(SELECT FROM integration_jobs other WHERE other.organization_id=j.organization_id AND other.id<>j.id AND other.kind='CHATWOOT_REPLY'
     AND (other.payload->>'outboundIntentId'=p.intent_id::text OR (other.integration_id=c.id AND other.payload->>'messageId'=p.message_id::text)))
   AND NOT EXISTS(SELECT FROM chatwoot_messages l WHERE l.organization_id=j.organization_id AND l.integration_id=c.id AND l.remote_message_id=p.message_id)
   AND NOT EXISTS(SELECT FROM messaging_messages m WHERE m.organization_id=j.organization_id AND m.channel_id=c.channel_id AND
     (m.idempotency_key ~ ('^chatwoot(-group)?:('||c.id::text||':[0-9]+:)?'||p.message_id::text||'(:[0-9]+)?$')
      OR (m.conversation_id=cm.conversation_id AND m.direction='OUTGOING' AND m.created_at>=o.created_at-interval '5 minutes'
        AND rtrim(m.content->>'text',chr(13)||chr(10))=rtrim(j.payload#>>'{content,text}',chr(13)||chr(10)))))
   AND NOT EXISTS(SELECT FROM qr_outbound_observations q WHERE q.organization_id=j.organization_id AND q.channel_id=c.channel_id
     AND q.conversation_id=cm.conversation_id AND q.occurred_at>=o.created_at-interval '5 minutes' AND
     (q.disposition IN ('RECONCILE','ABANDONED') OR rtrim(q.content->>'text',chr(13)||chr(10))=rtrim(j.payload#>>'{content,text}',chr(13)||chr(10))))
), eligible AS (
 SELECT * FROM candidate WHERE encode(sha256(convert_to(restored,'UTF8')),'hex')=original_sha256
)
-- APPLY_RECONCILIATION
, resumed AS (
 UPDATE integration_jobs j SET payload=jsonb_set(j.payload,'{content,text}',to_jsonb(e.restored)),status='PENDING',available_at=now(),updated_at=now(),last_error=NULL
 FROM eligible e WHERE $2::boolean IS TRUE AND j.organization_id=e.organization_id AND j.id=e.id
   AND j.status='FAILED' AND j.attempts=1 AND j.last_error='CHATWOOT_HUMAN_INTENT_NOT_PROVEN' AND j.updated_at=e.updated_at AND j.payload=e.payload AND j.message_id IS NULL
 RETURNING j.id,j.organization_id,e.original_sha256,e.admitted_sha256
), audited AS (
 INSERT INTO integration_audit(organization_id,action,resource_id,reason)
 SELECT organization_id,'CHATWOOT_HUMAN_TEXT_RECONCILED',id,concat('admitted_sha256=',admitted_sha256,';original_sha256=',original_sha256) FROM resumed RETURNING resource_id
)
SELECT EXISTS(SELECT FROM eligible) AS eligible,EXISTS(SELECT FROM audited) AS resumed;
