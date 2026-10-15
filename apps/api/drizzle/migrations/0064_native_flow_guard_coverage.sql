-- Keep the original 0053 bytes. A consumable native proof must cover every
-- responder now required by the host contract. Historical activated bindings
-- remain historical facts; this migration never changes an executor or sends.
ALTER TABLE flow_executor_cutovers DROP CONSTRAINT flow_executor_cutovers_check4;
--> statement-breakpoint
UPDATE flow_executor_cutovers SET phase='UNKNOWN',proof_valid_until=NULL,
 lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE host_kind='JRC_NATIVE' AND phase='DRAINED';
--> statement-breakpoint
ALTER TABLE flow_executor_cutovers ADD CONSTRAINT flow_executor_cutovers_drain_proof CHECK(
 phase<>'DRAINED' OR COALESCE((admission_closed
  AND proof_observed_at IS NOT NULL AND proof_valid_until IS NOT NULL AND proof_valid_until>proof_observed_at
  AND proof_valid_until<=proof_observed_at+interval '30 seconds' AND (
   (host_kind='STOCK' AND ((qr_identity_revision IS NOT NULL AND qr_identity_fingerprint IS NOT NULL AND remote_bot_id IS NULL)
    OR (remote_bot_id IS NOT NULL AND remote_bot_callback IS NOT NULL AND qr_identity_revision IS NULL)))
   OR (host_kind='JRC_NATIVE' AND fence_dispatched_at IS NOT NULL AND host_fence_revision IS NOT NULL AND host_fence_revision=revision
    AND live_runs IS NOT NULL AND live_runs=0 AND legacy_jobs IS NOT NULL AND legacy_jobs=0 AND uncertain_effects IS NOT NULL AND uncertain_effects=0
    AND host_source_sha IS NOT NULL AND host_image_digest IS NOT NULL
    AND cardinality(guarded_paths)=19 AND ARRAY['listener','dispatch','resume','recovery','workflow-turn','runner','workflow-runner',
     'remote-event','remote-resume','remote-recovery','remote-runner','playbook-webhook','playbook-resume','automation-rule',
     'native-reply','agent-bot-listener','agent-bot-webhook','api-bot-actor','native-policy-config']::text[] <@ guarded_paths)
  )),false));
