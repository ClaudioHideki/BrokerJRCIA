-- Candidate only. Apply after the frozen, reviewed 0055 predecessor.
-- No destination URL, credential, telephone or auth state is persisted here.
CREATE TABLE evolution_engines (
 id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9_-]{0,63}$'),
 generation bigint NOT NULL CHECK(generation>0 AND generation<=9007199254740991),
 destination_fingerprint text NOT NULL CHECK(destination_fingerprint ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('ACTIVE','DRAINING','DISABLED')),
 session_budget integer CHECK(session_budget BETWEEN 1 AND 100000),
 operation_budget integer NOT NULL DEFAULT 8 CHECK(operation_budget BETWEEN 1 AND 256),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(session_budget IS NOT NULL OR id='legacy')
);
CREATE TABLE evolution_instance_bindings (
 organization_id uuid NOT NULL,instance_id uuid NOT NULL,engine_id text NOT NULL REFERENCES evolution_engines(id),
 generation bigint NOT NULL,destination_fingerprint text NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,instance_id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id) ON DELETE CASCADE,
 CHECK(generation>0 AND destination_fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE INDEX evolution_binding_load ON evolution_instance_bindings(engine_id);
CREATE TABLE evolution_io_leases (
 token uuid PRIMARY KEY,organization_id uuid NOT NULL,instance_id uuid NOT NULL,engine_id text NOT NULL,
 generation bigint NOT NULL,destination_fingerprint text NOT NULL,operation_id uuid,intent_id uuid,intent_kind text CHECK(intent_kind IN('QR_DISPATCH','GROUP_WEBHOOK')),
 mutation boolean NOT NULL,outcome text NOT NULL DEFAULT 'DISPATCHED' CHECK(outcome IN ('DISPATCHED','UNKNOWN','SETTLED','RESOLVED')),expires_at timestamptz NOT NULL,settled_at timestamptz,
 FOREIGN KEY(organization_id,instance_id) REFERENCES evolution_instance_bindings(organization_id,instance_id) ON DELETE CASCADE
);
CREATE INDEX evolution_io_engine_active ON evolution_io_leases(engine_id,expires_at) WHERE settled_at IS NULL;
CREATE TABLE evolution_io_backoff (
 organization_id uuid NOT NULL,instance_id uuid NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz,waiting_since timestamptz,last_error_code text,
 PRIMARY KEY(organization_id,instance_id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES evolution_instance_bindings(organization_id,instance_id) ON DELETE CASCADE
);
ALTER TABLE provider_operations ADD COLUMN engine_id text,ADD COLUMN engine_generation bigint,ADD COLUMN engine_fingerprint text;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operation_engine_shape CHECK(
 (engine_id IS NULL AND engine_generation IS NULL AND engine_fingerprint IS NULL) OR
 (engine_id IS NOT NULL AND engine_generation>0 AND engine_fingerprint ~ '^[0-9a-f]{64}$'));
ALTER TABLE lifecycle_cleanup_items ADD COLUMN engine_id text,ADD COLUMN engine_generation bigint,ADD COLUMN engine_fingerprint text;
ALTER TABLE lifecycle_cleanup_items ADD CONSTRAINT lifecycle_cleanup_engine_shape CHECK(
 (engine_id IS NULL AND engine_generation IS NULL AND engine_fingerprint IS NULL) OR
 (engine_id IS NOT NULL AND engine_generation>0 AND engine_fingerprint ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
ALTER TABLE evolution_engines ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_engines FORCE ROW LEVEL SECURITY;
CREATE POLICY evolution_engines_migrator ON evolution_engines TO jrc_migrator USING(true) WITH CHECK(true);
ALTER TABLE evolution_instance_bindings ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_instance_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE evolution_io_leases ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_io_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE evolution_io_backoff ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_io_backoff FORCE ROW LEVEL SECURITY;
CREATE POLICY evolution_binding_tenant ON evolution_instance_bindings FOR SELECT TO jrc_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY evolution_binding_migrator ON evolution_instance_bindings TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY evolution_io_migrator ON evolution_io_leases TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY evolution_backoff_migrator ON evolution_io_backoff TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON evolution_engines,evolution_instance_bindings,evolution_io_leases,evolution_io_backoff FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT ON evolution_instance_bindings TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('evolution_instance_bindings'),('evolution_io_leases'),('evolution_io_backoff');
--> statement-breakpoint
CREATE FUNCTION evolution_require_tenant(org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'jrc_app' OR org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
  RAISE EXCEPTION 'EVOLUTION_ENGINE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION evolution_require_tenant(uuid) FROM PUBLIC;

CREATE FUNCTION evolution_register_engines(config jsonb,first_registration boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE entry jsonb;total integer:=0;legacy_fingerprint text;legacy_generation bigint;has_registry boolean;
BEGIN
 IF session_user<>'jrc_migrator' AND current_setting('role',true) IS DISTINCT FROM 'jrc_migrator' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(570056);
 SELECT EXISTS(SELECT 1 FROM public.evolution_engines) INTO has_registry;
 IF jsonb_typeof(config)<>'array' OR jsonb_array_length(config) NOT BETWEEN 1 AND 129 OR
  (NOT has_registry AND NOT first_registration) OR (has_registry AND first_registration) THEN
  RAISE EXCEPTION 'EVOLUTION_ENGINE_REGISTRATION_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM public.evolution_engines e WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config) x WHERE x->>'id'=e.id)) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_REGISTRATION_INVALID';END IF;
 IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(config) x)<>jsonb_array_length(config) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_REGISTRATION_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config) x WHERE x->>'id'='legacy') THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_REGISTRATION_INVALID';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(config) LOOP
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(entry) k WHERE k NOT IN('id','generation','destinationFingerprint','sessionBudget','state','operationBudget')) THEN
   RAISE EXCEPTION 'EVOLUTION_ENGINE_REGISTRATION_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM public.evolution_engines e WHERE e.id=entry->>'id'
    AND (e.generation<>(entry->>'generation')::bigint OR e.destination_fingerprint<>entry->>'destinationFingerprint')) THEN
   -- A live historical session cannot be moved by registry refresh.
   RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
  INSERT INTO public.evolution_engines(id,generation,destination_fingerprint,state,session_budget,operation_budget)
   VALUES(entry->>'id',(entry->>'generation')::bigint,entry->>'destinationFingerprint',entry->>'state',
    (entry->>'sessionBudget')::integer,(entry->>'operationBudget')::integer)
   ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,session_budget=EXCLUDED.session_budget,
    operation_budget=EXCLUDED.operation_budget,updated_at=clock_timestamp();
  total:=total+1;
 END LOOP;
 IF NOT has_registry THEN
  SELECT destination_fingerprint,generation INTO legacy_fingerprint,legacy_generation FROM public.evolution_engines WHERE id='legacy';
  INSERT INTO public.evolution_instance_bindings(organization_id,instance_id,engine_id,generation,destination_fingerprint)
   SELECT i.organization_id,i.id,'legacy',legacy_generation,legacy_fingerprint FROM public.instances i
   JOIN public.provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id WHERE pa.provider='BAILEYS';
  UPDATE public.provider_operations p SET engine_id=b.engine_id,engine_generation=b.generation,engine_fingerprint=b.destination_fingerprint
   FROM public.evolution_instance_bindings b WHERE p.organization_id=b.organization_id AND p.instance_id=b.instance_id;
  UPDATE public.lifecycle_cleanup_items SET engine_id='legacy',engine_generation=legacy_generation,engine_fingerprint=legacy_fingerprint WHERE engine_id IS NULL;
  UPDATE public.qr_dispatch_attempts a SET engine_id=b.engine_id,engine_generation=b.generation,engine_fingerprint=b.destination_fingerprint,engine_instance_id=b.instance_id
   FROM public.messaging_channels c,public.evolution_instance_bindings b WHERE a.organization_id=c.organization_id AND a.channel_id=c.id AND b.organization_id=c.organization_id AND b.instance_id=c.instance_id;
  UPDATE public.whatsapp_group_webhook_operations a SET engine_id=b.engine_id,engine_generation=b.generation,engine_fingerprint=b.destination_fingerprint
   FROM public.evolution_instance_bindings b WHERE a.organization_id=b.organization_id AND a.instance_id=b.instance_id;
 END IF;
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION evolution_register_engines(jsonb,boolean) FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION evolution_register_engines(jsonb,boolean) TO jrc_migrator;
--> statement-breakpoint
CREATE FUNCTION evolution_pin_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE binding public.evolution_instance_bindings%ROWTYPE;selected public.evolution_engines%ROWTYPE;kind text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.status='SUCCEEDED' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.engine_id IS NOT NULL THEN
   IF NOT public.evolution_assert_binding(NEW.organization_id,NEW.instance_id,NEW.engine_id,NEW.engine_generation,NEW.engine_fingerprint,false,false) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
   UPDATE public.evolution_io_leases SET outcome='RESOLVED',settled_at=coalesce(settled_at,clock_timestamp()) WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND operation_id=NEW.id AND outcome IN('UNKNOWN','DISPATCHED');
  END IF;
  IF (NEW.engine_id,NEW.engine_generation,NEW.engine_fingerprint) IS DISTINCT FROM(OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint) AND session_user<>'jrc_migrator' AND current_setting('role',true) IS DISTINCT FROM 'jrc_migrator' THEN
   RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
  RETURN NEW;
 END IF;
 SELECT pa.provider::text INTO kind FROM public.instances i JOIN public.provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id
  WHERE i.organization_id=NEW.organization_id AND i.id=NEW.instance_id;
 IF kind<>'BAILEYS' THEN RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(570056);
 IF NOT EXISTS(SELECT 1 FROM public.evolution_engines) THEN RETURN NEW;END IF;
 SELECT * INTO binding FROM public.evolution_instance_bindings WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id;
 IF NOT FOUND THEN
  IF NEW.operation_type<>'PROVISION' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
  SELECT e.* INTO selected FROM public.evolution_engines e
   LEFT JOIN(SELECT engine_id,count(*) AS used FROM public.evolution_instance_bindings GROUP BY engine_id) load ON load.engine_id=e.id
   WHERE e.state='ACTIVE' AND e.session_budget IS NOT NULL AND coalesce(load.used,0)<e.session_budget
   ORDER BY coalesce(load.used,0)::numeric/e.session_budget,e.id LIMIT 1 FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_CAPACITY_REQUIRED';END IF;
  INSERT INTO public.evolution_instance_bindings(organization_id,instance_id,engine_id,generation,destination_fingerprint)
   VALUES(NEW.organization_id,NEW.instance_id,selected.id,selected.generation,selected.destination_fingerprint) RETURNING * INTO binding;
 END IF;
 NEW.engine_id:=binding.engine_id;NEW.engine_generation:=binding.generation;NEW.engine_fingerprint:=binding.destination_fingerprint;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evolution_pin_operation() FROM PUBLIC;
CREATE TRIGGER evolution_operation_pin BEFORE INSERT OR UPDATE OF status,engine_id,engine_generation,engine_fingerprint ON provider_operations FOR EACH ROW EXECUTE FUNCTION evolution_pin_operation();
CREATE FUNCTION evolution_pin_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid;b public.evolution_instance_bindings%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.engine_id,NEW.engine_generation,NEW.engine_fingerprint) IS DISTINCT FROM(OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint) AND session_user<>'jrc_migrator' AND current_setting('role',true) IS DISTINCT FROM 'jrc_migrator' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
  RETURN NEW;
 END IF;
 SELECT organization_id INTO org FROM public.lifecycle_deletions WHERE id=NEW.deletion_id;
 SELECT * INTO b FROM public.evolution_instance_bindings WHERE organization_id=org AND instance_id=NEW.instance_id;
 IF FOUND THEN NEW.engine_id:=b.engine_id;NEW.engine_generation:=b.generation;NEW.engine_fingerprint:=b.destination_fingerprint;
 ELSIF EXISTS(SELECT 1 FROM public.evolution_engines) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evolution_pin_cleanup() FROM PUBLIC;
CREATE TRIGGER evolution_cleanup_pin BEFORE INSERT OR UPDATE OF engine_id,engine_generation,engine_fingerprint ON lifecycle_cleanup_items FOR EACH ROW EXECUTE FUNCTION evolution_pin_cleanup();
--> statement-breakpoint
CREATE FUNCTION evolution_resolve_binding(org uuid,upstream text,operation uuid)
RETURNS TABLE("instanceId" uuid,"engineId" text,generation bigint,"destinationFingerprint" text,state text,traditional boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE iid uuid;b public.evolution_instance_bindings%ROWTYPE;op public.provider_operations%ROWTYPE;
BEGIN
 PERFORM public.evolution_require_tenant(org);
 SELECT i.id INTO iid FROM public.instances i JOIN public.provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id
  WHERE i.organization_id=org AND (i.upstream_instance_key=upstream OR i.external_reference=upstream) AND pa.provider='BAILEYS';
 IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO b FROM public.evolution_instance_bindings WHERE organization_id=org AND instance_id=iid;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM public.evolution_engines) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
  RETURN QUERY SELECT iid,NULL::text,NULL::bigint,NULL::text,'ACTIVE'::text,true;RETURN;
 END IF;
 IF operation IS NOT NULL THEN
  SELECT * INTO op FROM public.provider_operations WHERE organization_id=org AND instance_id=iid AND id=operation;
  IF NOT FOUND OR (op.engine_id,op.engine_generation,op.engine_fingerprint) IS DISTINCT FROM(b.engine_id,b.generation,b.destination_fingerprint) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
 END IF;
 RETURN QUERY SELECT iid,b.engine_id,b.generation,b.destination_fingerprint,e.state,false FROM public.evolution_engines e WHERE e.id=b.engine_id
  AND e.generation=b.generation AND e.destination_fingerprint=b.destination_fingerprint;
END $$;
CREATE FUNCTION evolution_assert_binding(org uuid,iid uuid,engine text,gen bigint,fingerprint text,is_traditional boolean,mutating boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.evolution_require_tenant(org);
 PERFORM 1 FROM public.instances WHERE organization_id=org AND id=iid FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF is_traditional THEN RETURN NOT EXISTS(SELECT 1 FROM public.evolution_engines);END IF;
 PERFORM 1 FROM public.evolution_instance_bindings b JOIN public.evolution_engines e ON e.id=b.engine_id
  WHERE b.organization_id=org AND b.instance_id=iid AND b.engine_id=engine AND b.generation=gen AND b.destination_fingerprint=fingerprint
  AND e.generation=b.generation AND e.destination_fingerprint=b.destination_fingerprint AND (NOT mutating OR e.state<>'DISABLED') FOR SHARE OF b,e;
 RETURN FOUND;
END $$;
CREATE FUNCTION evolution_assert_operation(org uuid,operation uuid,mutating boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.provider_operations%ROWTYPE;
BEGIN
 PERFORM public.evolution_require_tenant(org);
 SELECT * INTO op FROM public.provider_operations WHERE organization_id=org AND id=operation FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF op.engine_id IS NULL THEN RETURN NOT EXISTS(SELECT 1 FROM public.evolution_engines);END IF;
 RETURN public.evolution_assert_binding(org,op.instance_id,op.engine_id,op.engine_generation,op.engine_fingerprint,false,mutating);
END $$;
REVOKE ALL ON FUNCTION evolution_resolve_binding(uuid,text,uuid),evolution_assert_binding(uuid,uuid,text,bigint,text,boolean,boolean),evolution_assert_operation(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evolution_resolve_binding(uuid,text,uuid),evolution_assert_binding(uuid,uuid,text,bigint,text,boolean,boolean),evolution_assert_operation(uuid,uuid,boolean) TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION evolution_acquire_io(org uuid,iid uuid,engine text,gen bigint,fingerprint text,lease uuid,mutating boolean,lease_ms integer,operation uuid,intent jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.evolution_engines%ROWTYPE;b public.evolution_io_backoff%ROWTYPE;op public.provider_operations%ROWTYPE;intent_uuid uuid;intent_type text;clock timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.evolution_require_tenant(org);
 -- Match confirmation's operation -> instance -> engine order. Do not take an
 -- engine SHARE lock before UPDATE: competing acquisitions must not upgrade it.
 IF operation IS NOT NULL THEN
  SELECT * INTO op FROM public.provider_operations WHERE organization_id=org AND instance_id=iid AND id=operation FOR SHARE;
  IF NOT FOUND OR (op.engine_id,op.engine_generation,op.engine_fingerprint) IS DISTINCT FROM(engine,gen,fingerprint) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
 END IF;
 PERFORM 1 FROM public.instances WHERE organization_id=org AND id=iid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
 SELECT * INTO e FROM public.evolution_engines WHERE id=engine FOR UPDATE;
 IF NOT FOUND OR e.generation<>gen OR e.destination_fingerprint<>fingerprint OR NOT public.evolution_assert_binding(org,iid,engine,gen,fingerprint,false) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
 IF mutating AND e.state='DISABLED' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_DISABLED';END IF;
 IF lease_ms NOT BETWEEN 1 AND 60000 THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_CONFIGURATION_INVALID';END IF;
 IF intent IS NOT NULL AND mutating THEN
  intent_type:=intent->>'kind';
  IF intent_type='QR_DISPATCH' THEN
   SELECT a.id INTO intent_uuid FROM public.qr_dispatch_attempts a WHERE a.organization_id=org AND a.engine_instance_id=iid AND a.message_id=(intent->>'messageId')::uuid AND a.lease_token=(intent->>'leaseToken')::uuid AND a.state='DISPATCHED' AND a.lease_expires_at>clock;
  ELSIF intent_type='GROUP_WEBHOOK' THEN
   SELECT w.id INTO intent_uuid FROM public.whatsapp_group_webhook_operations w WHERE w.organization_id=org AND w.instance_id=iid AND w.id=(intent->>'operationId')::uuid AND w.phase='DISPATCHED' AND w.lease_expires_at>clock;
  ELSE RAISE EXCEPTION 'EVOLUTION_ENGINE_CONFIGURATION_INVALID';END IF;
  IF intent_uuid IS NULL THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 END IF;
 INSERT INTO public.evolution_io_backoff(organization_id,instance_id) VALUES(org,iid) ON CONFLICT DO NOTHING;
 SELECT * INTO b FROM public.evolution_io_backoff WHERE organization_id=org AND instance_id=iid FOR UPDATE;
 -- Reads remain possible while mutations wait for a safe retry or QR action.
 IF mutating AND EXISTS(SELECT 1 FROM public.evolution_io_leases l WHERE l.organization_id=org AND l.instance_id=iid AND l.mutation AND (l.outcome='UNKNOWN' OR l.outcome='DISPATCHED' AND l.expires_at<=clock)) THEN
  RAISE EXCEPTION 'EVOLUTION_ENGINE_RECONCILIATION_REQUIRED';END IF;
 IF mutating AND b.next_attempt_at>clock THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.evolution_io_leases WHERE organization_id=org AND instance_id=iid AND settled_at IS NULL AND expires_at>clock AND (mutation OR mutating)) THEN RETURN false;END IF;
 IF (SELECT count(*) FROM public.evolution_io_leases WHERE engine_id=engine AND settled_at IS NULL AND expires_at>clock)+(SELECT count(*) FROM public.evolution_cleanup_io WHERE engine_id=engine AND settled_at IS NULL AND expires_at>clock)>=e.operation_budget OR
  EXISTS(SELECT 1 FROM public.evolution_io_backoff wait JOIN public.evolution_instance_bindings bind USING(organization_id,instance_id)
    WHERE bind.engine_id=engine AND wait.waiting_since>clock-interval '60 seconds' AND coalesce(wait.next_attempt_at,clock)<=clock
     AND (wait.waiting_since,wait.organization_id,wait.instance_id)<(coalesce(b.waiting_since,clock),org,iid)) THEN
  UPDATE public.evolution_io_backoff SET waiting_since=coalesce(waiting_since,clock),next_attempt_at=clock+interval '1 second',last_error_code='EVOLUTION_ENGINE_RETRY_LATER' WHERE organization_id=org AND instance_id=iid;
  RETURN false;
 END IF;
 INSERT INTO public.evolution_io_leases(token,organization_id,instance_id,engine_id,generation,destination_fingerprint,operation_id,intent_id,intent_kind,mutation,expires_at)
  VALUES(lease,org,iid,engine,gen,fingerprint,operation,intent_uuid,intent_type,mutating,clock+(lease_ms*interval '1 millisecond'));
 UPDATE public.evolution_io_backoff SET waiting_since=NULL WHERE organization_id=org AND instance_id=iid;
 RETURN true;
END $$;
CREATE FUNCTION evolution_settle_io(org uuid,iid uuid,lease uuid,ok boolean,error_code text,uncertain boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l public.evolution_io_leases%ROWTYPE;attempt integer;delay integer;
BEGIN
 PERFORM public.evolution_require_tenant(org);
 -- Read the immutable lease identity, then lock authority before the lease;
 -- provider/QR confirmation also locks authority before resolving its lease.
 SELECT * INTO l FROM public.evolution_io_leases WHERE token=lease AND organization_id=org AND instance_id=iid;
 IF NOT FOUND THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 IF ok AND NOT public.evolution_assert_binding(org,iid,l.engine_id,l.generation,l.destination_fingerprint,false) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 SELECT * INTO l FROM public.evolution_io_leases WHERE token=lease AND organization_id=org AND instance_id=iid FOR UPDATE;
 IF NOT FOUND OR l.settled_at IS NOT NULL THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 IF ok AND l.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 IF error_code IS NOT NULL AND error_code !~ '^[A-Z][A-Z0-9_]{0,127}$' THEN error_code:='PROVIDER_OPERATION_FAILED';END IF;
 UPDATE public.evolution_io_leases SET settled_at=clock_timestamp(),outcome=CASE WHEN uncertain AND mutation THEN 'UNKNOWN' ELSE 'SETTLED' END WHERE token=lease;
 IF ok THEN
  IF l.mutation AND NOT EXISTS(SELECT 1 FROM public.evolution_io_leases WHERE organization_id=org AND instance_id=iid AND mutation AND outcome='UNKNOWN') THEN UPDATE public.evolution_io_backoff SET attempts=0,next_attempt_at=NULL,last_error_code=NULL,waiting_since=NULL WHERE organization_id=org AND instance_id=iid;END IF;
 ELSIF l.mutation THEN
  UPDATE public.evolution_io_backoff SET attempts=least(attempts+1,20),last_error_code=error_code WHERE organization_id=org AND instance_id=iid RETURNING attempts INTO attempt;
  -- Bounded deterministic jitter survives process restart and spreads tenants.
  delay:=least(300000,(1000*power(2,least(attempt,8)))::integer)+(abs(hashtextextended(org::text||iid::text||attempt::text,0)%501))::integer;
  UPDATE public.evolution_io_backoff SET next_attempt_at=clock_timestamp()+(delay*interval '1 millisecond') WHERE organization_id=org AND instance_id=iid;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION evolution_acquire_io(uuid,uuid,text,bigint,text,uuid,boolean,integer,uuid,jsonb),evolution_settle_io(uuid,uuid,uuid,boolean,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evolution_acquire_io(uuid,uuid,text,bigint,text,uuid,boolean,integer,uuid,jsonb),evolution_settle_io(uuid,uuid,uuid,boolean,text,boolean) TO jrc_app;

--> statement-breakpoint
CREATE TABLE evolution_operation_history (
 operation_id uuid PRIMARY KEY,tenant_reference uuid NOT NULL,instance_id uuid NOT NULL,engine_id text NOT NULL,
 generation bigint NOT NULL,destination_fingerprint text NOT NULL,operation_type text NOT NULL,outcome text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE evolution_cleanup_history (
 deletion_id uuid NOT NULL REFERENCES lifecycle_deletions(id),instance_id uuid NOT NULL,
 engine_id text NOT NULL,generation bigint NOT NULL,destination_fingerprint text NOT NULL,status text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(deletion_id,instance_id)
);
ALTER TABLE evolution_operation_history ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_operation_history FORCE ROW LEVEL SECURITY;
ALTER TABLE evolution_cleanup_history ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_cleanup_history FORCE ROW LEVEL SECURITY;
CREATE POLICY evolution_history_maintenance ON evolution_operation_history TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY evolution_cleanup_history_maintenance ON evolution_cleanup_history TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON evolution_operation_history,evolution_cleanup_history FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE FUNCTION evolution_archive_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.engine_id IS NOT NULL THEN
  INSERT INTO public.evolution_operation_history(operation_id,tenant_reference,instance_id,engine_id,generation,destination_fingerprint,operation_type,outcome)
   VALUES(OLD.id,OLD.organization_id,OLD.instance_id,OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint,OLD.operation_type,OLD.status) ON CONFLICT DO NOTHING;
 END IF;RETURN OLD;
END $$;
CREATE FUNCTION evolution_archive_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.engine_id IS NOT NULL THEN
  INSERT INTO public.evolution_cleanup_history(deletion_id,instance_id,engine_id,generation,destination_fingerprint,status)
   VALUES(OLD.deletion_id,OLD.instance_id,OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint,OLD.status) ON CONFLICT DO NOTHING;
 END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION evolution_archive_operation(),evolution_archive_cleanup() FROM PUBLIC;
CREATE TRIGGER evolution_operation_archive BEFORE DELETE ON provider_operations FOR EACH ROW EXECUTE FUNCTION evolution_archive_operation();
CREATE TRIGGER evolution_cleanup_archive BEFORE DELETE ON lifecycle_cleanup_items FOR EACH ROW EXECUTE FUNCTION evolution_archive_cleanup();
-- A lifecycle lease authenticates a private snapshot after instances are gone.
-- Deletion remains driven by the canonical lifecycle worker, never a new executor.
CREATE TABLE evolution_cleanup_io (
 token uuid PRIMARY KEY,deletion_id uuid NOT NULL REFERENCES lifecycle_deletions(id),instance_id uuid NOT NULL,
 engine_id text NOT NULL,generation bigint NOT NULL,destination_fingerprint text NOT NULL,mutation boolean NOT NULL,
 outcome text NOT NULL DEFAULT 'DISPATCHED' CHECK(outcome IN('DISPATCHED','UNKNOWN','SETTLED')),
 expires_at timestamptz NOT NULL,settled_at timestamptz
);
ALTER TABLE evolution_cleanup_io ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_cleanup_io FORCE ROW LEVEL SECURITY;
CREATE POLICY evolution_cleanup_io_maintenance ON evolution_cleanup_io TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON evolution_cleanup_io FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE FUNCTION evolution_cleanup_snapshot(deletion uuid,deletion_lease uuid,iid uuid,mutating boolean)
RETURNS TABLE("engineId" text,generation bigint,"destinationFingerprint" text,state text,traditional boolean,"organizationId" uuid,"upstreamKey" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.lifecycle_deletions%ROWTYPE;c public.lifecycle_cleanup_items%ROWTYPE;e public.evolution_engines%ROWTYPE;
BEGIN
 IF session_user NOT IN('jrc_lifecycle','jrc_platform') THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.lifecycle_deletions WHERE id=deletion AND lease_token=deletion_lease FOR UPDATE;
 IF NOT FOUND OR d.lease_expires_at<=clock_timestamp() OR d.status NOT IN('CLEANING_EXTERNAL','REMOVING_DATA') THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 IF NOT (CASE WHEN d.actor_kind='PLATFORM' THEN EXISTS(SELECT 1 FROM public.platform_users u WHERE u.id=d.actor_id AND u.role='SUPER_ADMIN' AND u.active)
  ELSE EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id WHERE m.organization_id=d.organization_id AND m.user_id=d.actor_id AND m.status='ACTIVE' AND u.status='ACTIVE' AND m.role IN('OWNER','ADMIN')) END) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lifecycle_cleanup_items WHERE deletion_id=deletion AND instance_id=iid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
 IF mutating AND (d.reconciliation_requested OR c.status<>'IN_FLIGHT') THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_RECONCILIATION_REQUIRED';END IF;
 IF c.engine_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.evolution_engines) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
  RETURN QUERY SELECT NULL::text,NULL::bigint,NULL::text,'ACTIVE'::text,true,d.organization_id,c.upstream_key;RETURN;
 END IF;
 SELECT * INTO e FROM public.evolution_engines WHERE id=c.engine_id FOR SHARE;
 IF NOT FOUND OR e.generation<>c.engine_generation OR e.destination_fingerprint<>c.engine_fingerprint THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
 IF mutating AND e.state='DISABLED' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_DISABLED';END IF;
 RETURN QUERY SELECT c.engine_id,c.engine_generation,c.engine_fingerprint,e.state,false,d.organization_id,c.upstream_key;
END $$;
CREATE FUNCTION evolution_acquire_cleanup(deletion uuid,deletion_lease uuid,iid uuid,token_value uuid,mutating boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b record;e public.evolution_engines%ROWTYPE;clock timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO b FROM public.evolution_cleanup_snapshot(deletion,deletion_lease,iid,mutating);
 IF b.traditional THEN RETURN true;END IF;
 SELECT * INTO e FROM public.evolution_engines WHERE id=b."engineId" FOR UPDATE;
 IF mutating AND EXISTS(SELECT 1 FROM public.evolution_cleanup_io l WHERE l.deletion_id=deletion AND l.instance_id=iid AND l.mutation AND (l.outcome='UNKNOWN' OR l.outcome='DISPATCHED' AND l.expires_at<=clock)) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_RECONCILIATION_REQUIRED';END IF;
 IF (SELECT count(*) FROM public.evolution_io_leases WHERE engine_id=e.id AND settled_at IS NULL AND expires_at>clock)
   +(SELECT count(*) FROM public.evolution_cleanup_io WHERE engine_id=e.id AND settled_at IS NULL AND expires_at>clock)>=e.operation_budget THEN RETURN false;END IF;
 INSERT INTO public.evolution_cleanup_io(token,deletion_id,instance_id,engine_id,generation,destination_fingerprint,mutation,expires_at)
  VALUES(token_value,deletion,iid,e.id,e.generation,e.destination_fingerprint,mutating,clock+interval '30 seconds');RETURN true;
END $$;
CREATE FUNCTION evolution_settle_cleanup(deletion uuid,deletion_lease uuid,iid uuid,token_value uuid,ok boolean,uncertain boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l public.evolution_cleanup_io%ROWTYPE;b record;
BEGIN
 -- The lifecycle transaction owns deletion/item authority before I/O rows.
 SELECT * INTO b FROM public.evolution_cleanup_snapshot(deletion,deletion_lease,iid,false);
 IF b.traditional THEN RETURN true;END IF;
 SELECT * INTO l FROM public.evolution_cleanup_io WHERE token=token_value AND deletion_id=deletion AND instance_id=iid FOR UPDATE;
 IF NOT FOUND THEN
  SELECT * INTO b FROM public.evolution_cleanup_snapshot(deletion,deletion_lease,iid,false);
  IF b.traditional THEN RETURN true;END IF;RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';
 END IF;
 IF l.settled_at IS NOT NULL THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 SELECT * INTO b FROM public.evolution_cleanup_snapshot(deletion,deletion_lease,iid,l.mutation);
 IF ok AND(l.expires_at<=clock_timestamp() OR (l.engine_id,l.generation,l.destination_fingerprint) IS DISTINCT FROM(b."engineId",b.generation,b."destinationFingerprint")) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_LEASE_CHANGED';END IF;
 UPDATE public.evolution_cleanup_io SET settled_at=clock_timestamp(),outcome=CASE WHEN uncertain AND mutation THEN 'UNKNOWN' ELSE 'SETTLED' END WHERE token=token_value;RETURN true;
END $$;
REVOKE ALL ON FUNCTION evolution_cleanup_snapshot(uuid,uuid,uuid,boolean),evolution_acquire_cleanup(uuid,uuid,uuid,uuid,boolean),evolution_settle_cleanup(uuid,uuid,uuid,uuid,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evolution_cleanup_snapshot(uuid,uuid,uuid,boolean),evolution_acquire_cleanup(uuid,uuid,uuid,uuid,boolean),evolution_settle_cleanup(uuid,uuid,uuid,uuid,boolean,boolean) TO jrc_lifecycle,jrc_platform;

--> statement-breakpoint
CREATE TABLE evolution_io_history (
 token uuid PRIMARY KEY,tenant_reference uuid NOT NULL,instance_id uuid NOT NULL,engine_id text NOT NULL,
 generation bigint NOT NULL,destination_fingerprint text NOT NULL,operation_id uuid,intent_id uuid,intent_kind text,mutation boolean NOT NULL,
 outcome text NOT NULL,expires_at timestamptz NOT NULL,archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE evolution_io_history ENABLE ROW LEVEL SECURITY;ALTER TABLE evolution_io_history FORCE ROW LEVEL SECURITY;
CREATE POLICY evolution_io_history_maintenance ON evolution_io_history TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON evolution_io_history FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE FUNCTION evolution_archive_io() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.evolution_io_history(token,tenant_reference,instance_id,engine_id,generation,destination_fingerprint,operation_id,intent_id,intent_kind,mutation,outcome,expires_at)
  VALUES(OLD.token,OLD.organization_id,OLD.instance_id,OLD.engine_id,OLD.generation,OLD.destination_fingerprint,OLD.operation_id,OLD.intent_id,OLD.intent_kind,OLD.mutation,CASE WHEN OLD.outcome='DISPATCHED' THEN 'UNKNOWN' ELSE OLD.outcome END,OLD.expires_at) ON CONFLICT DO NOTHING;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION evolution_archive_io() FROM PUBLIC;
CREATE TRIGGER evolution_io_archive BEFORE DELETE ON evolution_io_leases FOR EACH ROW EXECUTE FUNCTION evolution_archive_io();

--> statement-breakpoint
ALTER TABLE qr_dispatch_attempts ADD COLUMN engine_id text,ADD COLUMN engine_generation bigint,ADD COLUMN engine_fingerprint text,ADD COLUMN engine_instance_id uuid;
ALTER TABLE whatsapp_group_webhook_operations ADD COLUMN engine_id text,ADD COLUMN engine_generation bigint,ADD COLUMN engine_fingerprint text;
CREATE FUNCTION evolution_pin_qr_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE iid uuid;b public.evolution_instance_bindings%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.engine_id,NEW.engine_generation,NEW.engine_fingerprint,to_jsonb(NEW)->>'engine_instance_id',to_jsonb(NEW)->>'instance_id') IS DISTINCT FROM(OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint,to_jsonb(OLD)->>'engine_instance_id',to_jsonb(OLD)->>'instance_id')
   AND session_user<>'jrc_migrator' AND current_setting('role',true) IS DISTINCT FROM 'jrc_migrator' THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
  IF NEW.engine_id IS NOT NULL AND ((TG_TABLE_NAME='qr_dispatch_attempts' AND to_jsonb(NEW)->>'state'='CONFIRMED')
    OR(TG_TABLE_NAME='whatsapp_group_webhook_operations' AND to_jsonb(NEW)->>'phase'='CONFIRMED')) AND session_user='jrc_app' THEN
   iid:=coalesce((to_jsonb(NEW)->>'engine_instance_id')::uuid,(to_jsonb(NEW)->>'instance_id')::uuid);
   IF NOT public.evolution_assert_binding(NEW.organization_id,iid,NEW.engine_id,NEW.engine_generation,NEW.engine_fingerprint,false,false) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_CHANGED';END IF;
  END IF;
  IF NEW.engine_id IS NOT NULL AND ((TG_TABLE_NAME='qr_dispatch_attempts' AND to_jsonb(NEW)->>'state' IN('CONFIRMED','ABANDONED'))
   OR(TG_TABLE_NAME='whatsapp_group_webhook_operations' AND to_jsonb(NEW)->>'phase'='CONFIRMED')) THEN
   UPDATE public.evolution_io_leases SET outcome='RESOLVED',settled_at=coalesce(settled_at,clock_timestamp()) WHERE organization_id=NEW.organization_id AND intent_id=NEW.id AND engine_id=NEW.engine_id AND generation=NEW.engine_generation AND destination_fingerprint=NEW.engine_fingerprint AND outcome IN('DISPATCHED','UNKNOWN');
  END IF;RETURN NEW;
 END IF;
 SELECT c.instance_id INTO iid FROM public.messaging_channels c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.channel_id;
 SELECT * INTO b FROM public.evolution_instance_bindings WHERE organization_id=NEW.organization_id AND instance_id=iid;
 IF FOUND THEN NEW.engine_id:=b.engine_id;NEW.engine_generation:=b.generation;NEW.engine_fingerprint:=b.destination_fingerprint;
  IF TG_TABLE_NAME='qr_dispatch_attempts' THEN NEW.engine_instance_id:=b.instance_id;END IF;
 ELSIF EXISTS(SELECT 1 FROM public.evolution_engines) THEN RAISE EXCEPTION 'EVOLUTION_ENGINE_BINDING_REQUIRED';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evolution_pin_qr_snapshot() FROM PUBLIC;
CREATE TRIGGER evolution_qr_attempt_snapshot BEFORE INSERT OR UPDATE OF state,engine_id,engine_generation,engine_fingerprint,engine_instance_id ON qr_dispatch_attempts FOR EACH ROW EXECUTE FUNCTION evolution_pin_qr_snapshot();
CREATE TRIGGER evolution_group_webhook_snapshot BEFORE INSERT OR UPDATE OF phase,engine_id,engine_generation,engine_fingerprint,instance_id ON whatsapp_group_webhook_operations FOR EACH ROW EXECUTE FUNCTION evolution_pin_qr_snapshot();
CREATE FUNCTION evolution_archive_qr_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE iid uuid;
BEGIN
 IF OLD.engine_id IS NOT NULL THEN
  iid:=coalesce((to_jsonb(OLD)->>'engine_instance_id')::uuid,(to_jsonb(OLD)->>'instance_id')::uuid);
  INSERT INTO public.evolution_operation_history(operation_id,tenant_reference,instance_id,engine_id,generation,destination_fingerprint,operation_type,outcome)
   VALUES(OLD.id,OLD.organization_id,iid,OLD.engine_id,OLD.engine_generation,OLD.engine_fingerprint,TG_TABLE_NAME,coalesce(to_jsonb(OLD)->>'state',to_jsonb(OLD)->>'phase')) ON CONFLICT DO NOTHING;
 END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION evolution_archive_qr_snapshot() FROM PUBLIC;
CREATE TRIGGER evolution_qr_attempt_archive BEFORE DELETE ON qr_dispatch_attempts FOR EACH ROW EXECUTE FUNCTION evolution_archive_qr_snapshot();
CREATE TRIGGER evolution_group_webhook_archive BEFORE DELETE ON whatsapp_group_webhook_operations FOR EACH ROW EXECUTE FUNCTION evolution_archive_qr_snapshot();
