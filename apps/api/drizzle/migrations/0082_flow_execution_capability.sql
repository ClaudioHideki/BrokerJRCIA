-- Additive capability only. Existing credential/session/member grants are unchanged.
ALTER TABLE flow_delegation_credentials DROP CONSTRAINT flow_delegation_credentials_scopes_check;
ALTER TABLE flow_delegation_credentials ADD CONSTRAINT flow_delegation_credentials_scopes_check
 CHECK(cardinality(scopes) BETWEEN 1 AND 5 AND array_position(scopes,NULL) IS NULL
 AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind','flow:executions:read']::text[]);
--> statement-breakpoint
ALTER TABLE flow_delegation_session_grants DROP CONSTRAINT flow_delegation_session_grants_scopes_check;
ALTER TABLE flow_delegation_session_grants ADD CONSTRAINT flow_delegation_session_grants_scopes_check
 CHECK(cardinality(scopes) BETWEEN 1 AND 5 AND array_position(scopes,NULL) IS NULL
 AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind','flow:executions:read']::text[]);
--> statement-breakpoint
ALTER TABLE flow_member_grants DROP CONSTRAINT flow_member_grants_scopes_check;
ALTER TABLE flow_member_grants ADD CONSTRAINT flow_member_grants_scopes_check
 CHECK(cardinality(scopes)<=5 AND array_position(scopes,NULL) IS NULL
 AND scopes <@ ARRAY['flow:read','flow:edit','flow:publish','flow:bind','flow:executions:read']::text[]);
