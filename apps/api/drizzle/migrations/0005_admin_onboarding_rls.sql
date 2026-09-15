CREATE POLICY provider_accounts_migrator_onboarding_read ON provider_accounts
  FOR SELECT TO jrc_migrator
  USING (provider = 'BAILEYS');
CREATE POLICY provider_accounts_migrator_onboarding_insert ON provider_accounts
  FOR INSERT TO jrc_migrator
  WITH CHECK (provider = 'BAILEYS');
CREATE POLICY provider_accounts_migrator_onboarding_update ON provider_accounts
  FOR UPDATE TO jrc_migrator
  USING (provider = 'BAILEYS')
  WITH CHECK (provider = 'BAILEYS');
--> statement-breakpoint
CREATE POLICY audit_logs_migrator_insert ON audit_logs
  FOR INSERT TO jrc_migrator
  WITH CHECK (true);
