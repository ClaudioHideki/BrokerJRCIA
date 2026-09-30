-- Explicit selections only. These records outlive deleted companies; no company/group FK
-- may cascade an operation away. Content is limited to impact/confirmation, never messages.
ALTER TABLE lifecycle_deletions ADD COLUMN reconciliation_requested boolean NOT NULL DEFAULT false;
ALTER TABLE lifecycle_cleanup_items DROP CONSTRAINT lifecycle_cleanup_items_status_check;
ALTER TABLE lifecycle_cleanup_items ADD CONSTRAINT lifecycle_cleanup_items_status_check CHECK(status IN ('PENDING','IN_FLIGHT','DONE','ACTION_REQUIRED'));
GRANT UPDATE(reconciliation_requested) ON lifecycle_deletions TO jrc_lifecycle;

CREATE FUNCTION lifecycle_request_reconciliation(p_org uuid,p_resource uuid,p_operation uuid,p_reason text,p_actor_kind text,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.lifecycle_deletions%ROWTYPE;
BEGIN
 IF session_user<>'jrc_platform' OR coalesce(length(btrim(p_reason)),0) NOT BETWEEN 5 AND 500 THEN
  RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_actor_kind='PLATFORM' THEN
  IF NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND role='SUPER_ADMIN' AND active) THEN
   RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 ELSIF p_actor_kind='TENANT' THEN
  IF NOT EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id=p_org AND m.user_id=p_actor AND m.role IN ('OWNER','ADMIN') AND m.status='ACTIVE' AND u.status='ACTIVE') THEN
   RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO op FROM public.lifecycle_deletions WHERE id=p_operation AND organization_id=p_org AND resource_id=p_resource FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LIFECYCLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_actor_kind='TENANT' AND op.kind<>'CHANNEL' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF op.reconciliation_requested AND op.status IN ('REQUESTED','CLEANING_EXTERNAL') THEN RETURN op.id; END IF;
 IF op.status<>'ACTION_REQUIRED' OR op.error_code NOT IN ('EVOLUTION_CLEANUP_UNVERIFIED','EVOLUTION_INSTANCE_STILL_PRESENT') THEN
  RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='23514',CONSTRAINT='lifecycle_conflict'; END IF;
 UPDATE public.lifecycle_deletions SET reconciliation_requested=true,status='REQUESTED',error_code=NULL,actor_kind=p_actor_kind,actor_id=p_actor,
   reason=p_reason,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=op.id;
 INSERT INTO public.platform_audit_logs(actor_id,organization_id,action,reason)
 SELECT p_actor,p_org,'lifecycle-reconcile:'||op.id::text,p_reason WHERE p_actor_kind='PLATFORM';
 RETURN op.id;
END $$;
ALTER FUNCTION lifecycle_request_reconciliation(uuid,uuid,uuid,text,text,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_request_reconciliation(uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_request_reconciliation(uuid,uuid,uuid,text,text,uuid) TO jrc_platform;

CREATE TABLE group_company_removal_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision uuid NOT NULL DEFAULT gen_random_uuid(),
 group_id uuid NOT NULL, group_name text NOT NULL, group_revision integer NOT NULL,
 actor_id uuid NOT NULL, snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE TABLE group_company_removals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL, actor_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, request_hash text NOT NULL, preview_id uuid NOT NULL,
 selected_company_ids uuid[] NOT NULL, snapshot jsonb, confirmation jsonb, reason text,
 remove_group_if_empty boolean NOT NULL, status text NOT NULL DEFAULT 'RUNNING',
 group_stage text NOT NULL, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT group_removal_idempotency UNIQUE(actor_id,idempotency_key),
 CONSTRAINT group_removal_status CHECK(status IN ('RUNNING','PARTIAL','ACTION_REQUIRED','COMPLETED')),
 CONSTRAINT group_removal_group_stage CHECK(group_stage IN ('NOT_REQUESTED','PENDING','REMOVED','ALREADY_REMOVED','PRESERVED')),
 CONSTRAINT group_removal_selection CHECK(cardinality(selected_company_ids) BETWEEN 1 AND 200)
);
CREATE TABLE group_company_removal_children (
 removal_id uuid NOT NULL REFERENCES group_company_removals(id), company_id uuid NOT NULL, company_name text,
 deletion_id uuid NOT NULL REFERENCES lifecycle_deletions(id),
 PRIMARY KEY(removal_id,company_id), CONSTRAINT group_removal_child_deletion UNIQUE(deletion_id)
);
CREATE INDEX group_removal_pending ON group_company_removals(created_at,id) WHERE status<>'COMPLETED';
CREATE POLICY group_removal_group_migrator ON economic_groups TO jrc_migrator USING(true) WITH CHECK(true);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['group_company_removal_previews','group_company_removals','group_company_removal_children'] LOOP
  EXECUTE format('ALTER TABLE public.%I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY group_removal_migrator ON public.%I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('CREATE POLICY group_removal_platform ON public.%I FOR SELECT TO jrc_platform USING(true)',tab);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle',tab);
  EXECUTE format('GRANT SELECT ON public.%I TO jrc_platform',tab);
 END LOOP;
END $$;

CREATE FUNCTION group_removal_report(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('operationId',r.id,'groupId',r.group_id,
  'status',CASE WHEN EXISTS(SELECT 1 FROM public.group_company_removal_children c JOIN public.lifecycle_deletions d ON d.id=c.deletion_id WHERE c.removal_id=r.id AND d.status='ACTION_REQUIRED') THEN 'ACTION_REQUIRED'
    WHEN r.group_stage='PRESERVED' THEN 'ACTION_REQUIRED'
    WHEN EXISTS(SELECT 1 FROM public.group_company_removal_children c JOIN public.lifecycle_deletions d ON d.id=c.deletion_id WHERE c.removal_id=r.id AND d.status='COMPLETED')
      AND EXISTS(SELECT 1 FROM public.group_company_removal_children c JOIN public.lifecycle_deletions d ON d.id=c.deletion_id WHERE c.removal_id=r.id AND d.status<>'COMPLETED') THEN 'PARTIAL'
    ELSE r.status END,
  'groupStage',r.group_stage,'errorCode',r.error_code,'updatedAt',r.updated_at,
  'companies',(SELECT jsonb_agg(jsonb_build_object('id',c.company_id,'name',CASE WHEN d.status='COMPLETED' THEN NULL ELSE c.company_name END,
    'operationId',c.deletion_id,'status',d.status,'errorCode',d.error_code) ORDER BY c.company_id)
    FROM public.group_company_removal_children c JOIN public.lifecycle_deletions d ON d.id=c.deletion_id WHERE c.removal_id=r.id))
 FROM public.group_company_removals r WHERE r.id=p_id
$$;
ALTER FUNCTION group_removal_report(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_report(uuid) FROM PUBLIC;

CREATE FUNCTION group_removal_get(p_actor uuid,p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF session_user<>'jrc_platform' OR NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND active AND role='SUPER_ADMIN')
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 result=public.group_removal_report(p_id);
 IF result IS NULL THEN RAISE EXCEPTION 'GROUP_REMOVAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION group_removal_get(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_get(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_removal_get(uuid,uuid) TO jrc_platform;

CREATE FUNCTION group_removal_list(p_actor uuid,p_group uuid,p_cursor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[]; data jsonb;
BEGIN
 IF session_user<>'jrc_platform' OR NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND active AND role='SUPER_ADMIN')
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT array_agg(id ORDER BY id DESC) INTO ids FROM (SELECT id FROM public.group_company_removals
  WHERE group_id=p_group AND (p_cursor IS NULL OR id<p_cursor) ORDER BY id DESC LIMIT 26) page;
 SELECT coalesce(jsonb_agg(public.group_removal_report(id) ORDER BY id DESC),'[]'::jsonb) INTO data FROM unnest(ids[1:25]) id;
 RETURN jsonb_build_object('data',data,'nextCursor',CASE WHEN cardinality(ids)>25 THEN ids[25] ELSE NULL END);
END $$;
ALTER FUNCTION group_removal_list(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_list(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_removal_list(uuid,uuid,uuid) TO jrc_platform;

CREATE FUNCTION group_removal_preview(p_actor uuid,p_group uuid,p_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target record; company record; items jsonb='[]'::jsonb; saved public.group_company_removal_previews%ROWTYPE;
BEGIN
 IF session_user<>'jrc_platform' OR coalesce(length(btrim(p_reason)),0) NOT BETWEEN 5 AND 500
   OR NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND active AND role='SUPER_ADMIN')
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM public.economic_groups WHERE id=p_group FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_REMOVAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 FOR company IN SELECT o.id,o.status FROM public.organizations o JOIN public.economic_group_organizations m ON m.organization_id=o.id
   WHERE m.group_id=p_group ORDER BY o.id FOR SHARE OF o LOOP
  items=items||jsonb_build_array(jsonb_build_object('preview',public.lifecycle_preview_organization(company.id),'organizationStatus',company.status));
 END LOOP;
 DELETE FROM public.group_company_removal_previews WHERE expires_at<now();
 INSERT INTO public.group_company_removal_previews(group_id,group_name,group_revision,actor_id,snapshot)
   VALUES(p_group,target.name,target.revision,p_actor,items) RETURNING * INTO saved;
 INSERT INTO public.platform_audit_logs(actor_id,organization_id,action,reason)
   VALUES(p_actor,NULL,'group-company-removal-preview:'||saved.id::text,p_reason);
 RETURN jsonb_build_object('previewId',saved.id,'previewRevision',saved.revision,'groupId',p_group,'groupName',target.name,
   'groupRevision',target.revision,'expiresAt',saved.expires_at,'companies',coalesce((SELECT jsonb_agg(item->'preview') FROM jsonb_array_elements(items) item),'[]'::jsonb));
END $$;
ALTER FUNCTION group_removal_preview(uuid,uuid,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_preview(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_removal_preview(uuid,uuid,text) TO jrc_platform;

CREATE FUNCTION group_removal_request(p_actor uuid,p_input jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target record; saved public.group_company_removal_previews%ROWTYPE; existing public.group_company_removals%ROWTYPE;
 selected uuid[]; confirmed uuid[]; company_id uuid; typed_name text; item jsonb; current_preview jsonb; company_status text;
 fingerprint text; operation_id uuid; deletion_id uuid; selection_snapshot jsonb='[]'::jsonb;
BEGIN
 IF session_user<>'jrc_platform' OR coalesce(length(btrim(p_input->>'reason')),0) NOT BETWEEN 5 AND 500
   OR NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=p_actor AND active AND role='SUPER_ADMIN')
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 fingerprint=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('group-removal:'||p_actor::text||':'||(p_input->>'idempotencyKey'),0));
 SELECT * INTO existing FROM public.group_company_removals WHERE actor_id=p_actor AND idempotency_key=(p_input->>'idempotencyKey')::uuid FOR UPDATE;
 IF FOUND THEN
  IF existing.request_hash<>fingerprint THEN RAISE EXCEPTION 'GROUP_REMOVAL_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514',CONSTRAINT='group_removal_idempotency'; END IF;
  RETURN public.group_removal_report(existing.id);
 END IF;
 SELECT * INTO target FROM public.economic_groups WHERE id=(p_input->>'groupId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_REMOVAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- Do not lock a preview before its companies: company purge scrubs previews
 -- while holding the organization row. Preserve that same lock order.
 SELECT * INTO saved FROM public.group_company_removal_previews WHERE id=(p_input->>'previewId')::uuid;
 IF NOT FOUND OR saved.actor_id<>p_actor OR saved.group_id<>target.id OR saved.revision<>(p_input->>'previewRevision')::uuid
   OR saved.expires_at<=now() OR saved.group_revision<>target.revision OR target.revision<>(p_input->>'expectedRevision')::integer
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_PREVIEW_CHANGED' USING ERRCODE='23514',CONSTRAINT='group_removal_preview_changed'; END IF;
 SELECT array_agg(value::uuid ORDER BY value::uuid) INTO selected FROM jsonb_array_elements_text(p_input->'selectedCompanyIds');
 SELECT array_agg((value->>'id')::uuid ORDER BY (value->>'id')::uuid) INTO confirmed FROM jsonb_array_elements(p_input->'confirmation'->'companies');
 IF cardinality(selected) NOT BETWEEN 1 AND 200 OR selected IS NULL OR confirmed IS DISTINCT FROM selected
   OR cardinality(selected)<>(SELECT count(DISTINCT value) FROM unnest(selected) value)
 THEN RAISE EXCEPTION 'GROUP_REMOVAL_CONFIRMATION_REQUIRED' USING ERRCODE='23514',CONSTRAINT='group_removal_confirmation'; END IF;
 FOREACH company_id IN ARRAY selected LOOP
  -- Serialize against individual lifecycle requests, then take the same organization lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle:'||company_id::text,0));
  SELECT o.status::text INTO company_status FROM public.organizations o JOIN public.economic_group_organizations m ON m.organization_id=o.id
    WHERE o.id=company_id AND m.group_id=target.id FOR UPDATE OF o;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_REMOVAL_PREVIEW_CHANGED' USING ERRCODE='23514',CONSTRAINT='group_removal_preview_changed'; END IF;
  SELECT value INTO item FROM jsonb_array_elements(saved.snapshot) WHERE (value->'preview'->>'resourceId')::uuid=company_id;
  SELECT value->>'typedName' INTO typed_name FROM jsonb_array_elements(p_input->'confirmation'->'companies') WHERE (value->>'id')::uuid=company_id;
  IF item IS NULL OR typed_name IS DISTINCT FROM item->'preview'->>'resourceName'
  THEN RAISE EXCEPTION 'GROUP_REMOVAL_CONFIRMATION_REQUIRED' USING ERRCODE='23514',CONSTRAINT='group_removal_confirmation'; END IF;
  current_preview=public.lifecycle_preview_organization(company_id);
  IF item->'preview' IS DISTINCT FROM current_preview OR item->>'organizationStatus' IS DISTINCT FROM company_status
  THEN RAISE EXCEPTION 'GROUP_REMOVAL_PREVIEW_CHANGED' USING ERRCODE='23514',CONSTRAINT='group_removal_preview_changed'; END IF;
  IF NOT (current_preview->>'canDelete')::boolean THEN RAISE EXCEPTION 'GROUP_REMOVAL_COMPANY_BLOCKED' USING ERRCODE='23514',CONSTRAINT='group_removal_pending'; END IF;
  IF current_preview->>'operationId' IS NOT NULL THEN RAISE EXCEPTION 'GROUP_REMOVAL_COMPANY_ALREADY_REQUESTED' USING ERRCODE='23514',CONSTRAINT='group_removal_busy'; END IF;
  selection_snapshot=selection_snapshot||jsonb_build_array(item);
 END LOOP;
 PERFORM 1 FROM public.group_company_removal_previews WHERE id=saved.id AND revision=saved.revision AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_REMOVAL_PREVIEW_CHANGED' USING ERRCODE='23514',CONSTRAINT='group_removal_preview_changed'; END IF;
 INSERT INTO public.group_company_removals(group_id,actor_id,idempotency_key,request_hash,preview_id,selected_company_ids,snapshot,confirmation,reason,remove_group_if_empty,group_stage)
 VALUES(target.id,p_actor,(p_input->>'idempotencyKey')::uuid,fingerprint,saved.id,selected,selection_snapshot,p_input->'confirmation',p_input->>'reason',
   (p_input->'confirmation'->>'removeGroupIfEmpty')::boolean,CASE WHEN (p_input->'confirmation'->>'removeGroupIfEmpty')::boolean THEN 'PENDING' ELSE 'NOT_REQUESTED' END)
 RETURNING id INTO operation_id;
 FOREACH company_id IN ARRAY selected LOOP
  -- Never manufacture the nominative confirmation from a database company name.
  SELECT value->>'typedName' INTO typed_name FROM jsonb_array_elements(p_input->'confirmation'->'companies') WHERE (value->>'id')::uuid=company_id;
  deletion_id=public.lifecycle_request_organization(company_id,typed_name,p_input->>'reason',p_actor);
  INSERT INTO public.group_company_removal_children(removal_id,company_id,company_name,deletion_id) VALUES(operation_id,company_id,typed_name,deletion_id);
 END LOOP;
 DELETE FROM public.group_company_removal_previews WHERE id=saved.id;
 INSERT INTO public.platform_audit_logs(actor_id,organization_id,action,reason)
 VALUES(p_actor,NULL,'group-company-removal-request:'||operation_id::text,'Explicit company selection recorded');
 RETURN public.group_removal_report(operation_id);
END $$;
ALTER FUNCTION group_removal_request(uuid,jsonb) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_request(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_removal_request(uuid,jsonb) TO jrc_platform;

CREATE FUNCTION group_removal_process_one() RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.group_company_removals%ROWTYPE; group_exists boolean; next_stage text; next_error text;
BEGIN
 IF session_user<>'jrc_lifecycle' THEN RAISE EXCEPTION 'GROUP_REMOVAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 DELETE FROM public.group_company_removal_previews WHERE expires_at<now();
 SELECT * INTO op FROM public.group_company_removals r WHERE r.status<>'COMPLETED' AND r.group_stage<>'PRESERVED'
  AND NOT EXISTS(SELECT 1 FROM public.group_company_removal_children c JOIN public.lifecycle_deletions d ON d.id=c.deletion_id
    WHERE c.removal_id=r.id AND d.status<>'COMPLETED')
  ORDER BY r.created_at,r.id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN false; END IF;
 next_stage=op.group_stage;
 IF op.remove_group_if_empty THEN
  IF NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=op.actor_id AND active AND role='SUPER_ADMIN') THEN
   next_stage='PRESERVED'; next_error='LIFECYCLE_ACTOR_REVOKED';
  ELSE
   PERFORM 1 FROM public.economic_groups WHERE id=op.group_id FOR UPDATE; group_exists=FOUND;
   IF NOT group_exists THEN next_stage='ALREADY_REMOVED';
   ELSIF EXISTS(SELECT 1 FROM public.economic_group_organizations WHERE group_id=op.group_id) THEN
    next_stage='PRESERVED'; next_error='GROUP_HAS_REMAINING_COMPANIES';
   ELSE
    DELETE FROM public.economic_groups WHERE id=op.group_id; next_stage='REMOVED';
   END IF;
  END IF;
 END IF;
 UPDATE public.group_company_removals SET status=CASE WHEN next_stage='PRESERVED' THEN 'ACTION_REQUIRED' ELSE 'COMPLETED' END,
  group_stage=next_stage,error_code=next_error,snapshot=NULL,confirmation=NULL,reason=NULL,updated_at=now() WHERE id=op.id;
 UPDATE public.group_company_removal_children SET company_name=NULL WHERE removal_id=op.id;
 INSERT INTO public.platform_audit_logs(actor_id,organization_id,action,reason)
  VALUES(op.actor_id,NULL,'group-company-removal-finish:'||op.id::text,'Final group step: '||next_stage);
 RETURN true;
END $$;
ALTER FUNCTION group_removal_process_one() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_process_one() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_removal_process_one() TO jrc_lifecycle;

-- Scrub company names and confirmation content in the same transaction that purges
-- each company, even when another selected company remains blocked indefinitely.
CREATE FUNCTION group_removal_scrub_company() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.kind='ORGANIZATION' AND NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE public.group_company_removal_children SET company_name=NULL WHERE deletion_id=NEW.id;
  UPDATE public.group_company_removals r SET
   snapshot=(SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(r.snapshot) item WHERE item->'preview'->>'resourceId'<>NEW.organization_id::text),
   confirmation=jsonb_set(r.confirmation,'{companies}',(SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(r.confirmation->'companies') item WHERE item->>'id'<>NEW.organization_id::text)),
   reason=NULL,updated_at=now()
   WHERE NEW.organization_id=ANY(r.selected_company_ids);
  DELETE FROM public.group_company_removal_previews p WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot) item WHERE item->'preview'->>'resourceId'=NEW.organization_id::text);
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION group_removal_scrub_company() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION group_removal_scrub_company() FROM PUBLIC;
CREATE TRIGGER group_removal_scrub_company AFTER UPDATE OF status ON lifecycle_deletions
 FOR EACH ROW EXECUTE FUNCTION group_removal_scrub_company();
