ALTER TABLE public.chatwoot_connections
  ADD COLUMN live_claims_since_review smallint NOT NULL DEFAULT 0
  CONSTRAINT chatwoot_connections_live_claim_streak CHECK (live_claims_since_review BETWEEN 0 AND 3);
