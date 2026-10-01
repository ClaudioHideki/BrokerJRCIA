-- Removing an administrative group never deletes organizations or their resources.
-- The platform service authorizes SUPER_ADMIN and serializes membership changes.
GRANT DELETE ON economic_groups TO jrc_platform;
