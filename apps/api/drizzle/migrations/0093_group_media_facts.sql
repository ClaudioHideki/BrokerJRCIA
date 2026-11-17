-- Additive binary group facts. No flow activation, replay or historical rewrite.
ALTER TABLE whatsapp_group_transport_facts DROP CONSTRAINT whatsapp_group_transport_facts_content_check;
ALTER TABLE whatsapp_group_transport_facts ADD CONSTRAINT whatsapp_group_transport_facts_content_check CHECK(
 jsonb_typeof(content)='object' AND (
  content->>'type'='TEXT' AND jsonb_typeof(content->'text')='string' AND length(content->>'text') BETWEEN 1 AND 4096
  OR content->>'type'='MEDIA' AND jsonb_typeof(content->'mediaId')='string'
   AND content->>'mediaId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   AND content->>'kind' IN('image','audio','video','document','sticker')
   AND jsonb_typeof(content->'fileName')='string' AND length(content->>'fileName') BETWEEN 1 AND 255
   AND jsonb_typeof(content->'caption')='string' AND length(content->>'caption')<=4096
  ) IS TRUE
);
