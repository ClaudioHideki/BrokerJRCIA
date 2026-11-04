-- Native survey invitations are transport only. Preserve the existing reply
-- kinds and add a separate, bounded proof instead of calling a survey human.
ALTER TABLE chatwoot_attendance_observations
 DROP CONSTRAINT chatwoot_attendance_observations_check;
ALTER TABLE chatwoot_attendance_observations
 ADD CONSTRAINT chatwoot_attendance_reply_transport_v2 CHECK(
  reply_payload IS NULL OR (
   event->>'mayForwardReply'='true' AND (
    event->>'kind' IN ('HUMAN_PUBLIC','EXTERNAL_BOT','AUTOMATED_REPLY') OR (
     event->>'kind'='NATIVE_CSAT'
     AND event @> '{"mayForwardReply":true,"interruptsBot":false}'::jsonb
     AND NOT event ? 'senderId'
     AND NOT event ? 'campaignIntentId'
     AND reply_payload->>'messageId'=event->>'remoteMessageId'
     AND reply_payload->>'conversationId'=event->>'remoteConversationId'
     AND reply_payload->>'conversationId'=remote_conversation_id::text
     AND reply_payload->'content'->>'type'='TEXT'
     AND jsonb_typeof(reply_payload->'content'->'text')='string'
     AND length(reply_payload->'content'->>'text') BETWEEN 1 AND 4096
     AND NOT reply_payload ? 'attachments'
     AND NOT reply_payload ? 'campaignIntentId'
    ) IS TRUE
   )
  )
 );
