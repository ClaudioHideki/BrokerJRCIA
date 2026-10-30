-- Broker JRC, PostgreSQL: diagnóstico agregado sem payloads, conteúdo ou segredos.
-- Executar via psql -X -A -v ON_ERROR_STOP=1 -U <operador> -d jrc_broker -f <arquivo>
-- Requer perfil de leitura autorizado. Não concede permissões nem altera filas.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT now() AS snapshot_at;

SELECT count(*) AS migration_count, max(created_at)::text AS latest,
 md5(string_agg(hash || ':' || created_at::text, ',' ORDER BY created_at)) AS fingerprint
FROM drizzle.__drizzle_migrations;

SELECT status, kind,
 CASE WHEN last_error ~ '^[A-Z0-9_]{1,80}$' THEN last_error ELSE 'OTHER_REDACTED' END AS error_code,
 count(*) AS jobs, min(created_at) AS first_created, max(updated_at) AS last_updated
FROM integration_jobs WHERE status IN ('FAILED','UNKNOWN')
GROUP BY status,kind,last_error ORDER BY count(*) DESC;

SELECT c.inbox_id,c.status AS binding_status,h.observed_connected,
 h.identity_error,h.access_error,h.callback_verified_at IS NOT NULL AS callback_seen,h.observed_at
FROM chatwoot_connections c LEFT JOIN chatwoot_connection_health h
 ON h.organization_id=c.organization_id AND h.integration_id=c.id ORDER BY c.inbox_id;

SELECT c.inbox_id,j.status,count(*) AS jobs,min(j.created_at) AS first_created,max(j.created_at) AS last_created
FROM integration_jobs j JOIN chatwoot_connections c
 ON c.organization_id=j.organization_id AND c.id=j.integration_id
WHERE j.status IN ('PENDING','RUNNING','UNKNOWN') GROUP BY c.inbox_id,j.status;

SELECT c.inbox_id,
 CASE WHEN j.payload->>'operation' ~ '^[A-Z0-9_]{1,80}$'
 THEN j.payload->>'operation' ELSE 'OTHER_REDACTED' END AS operation,
 j.attempts,j.created_at,j.updated_at
FROM integration_jobs j JOIN chatwoot_connections c
 ON c.organization_id=j.organization_id AND c.id=j.integration_id WHERE j.status='UNKNOWN';

SELECT 'integration_jobs' AS source,status,count(*) FROM integration_jobs GROUP BY status;
SELECT 'partner_event_deliveries' AS source,status,count(*) FROM partner_event_deliveries GROUP BY status;

SELECT x.inbox_id,i.status AS instance_status,k.channel_id IS NOT NULL AS has_catalog,
 k.valid_until>now() AS catalog_current,k.last_error_code,
 (SELECT count(*) FROM whatsapp_group_catalog_items z WHERE z.organization_id=c.organization_id
  AND z.channel_id=c.id AND z.selected) AS selected_groups,
 (SELECT phase FROM whatsapp_group_webhook_operations w WHERE w.organization_id=c.organization_id AND w.channel_id=c.id
  ORDER BY (w.phase IN('PREPARED','DISPATCHED','UNKNOWN')) DESC,w.created_at DESC,w.id DESC LIMIT 1) AS webhook_phase
FROM chatwoot_connections x JOIN messaging_channels c ON c.organization_id=x.organization_id AND c.id=x.channel_id
JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
LEFT JOIN whatsapp_group_catalogs k ON k.organization_id=c.organization_id AND k.channel_id=c.id;
ROLLBACK;
