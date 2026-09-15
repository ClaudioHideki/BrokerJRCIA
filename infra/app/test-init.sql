CREATE ROLE jrc_app LOGIN PASSWORD 'container-test-app-password';
CREATE ROLE jrc_auth LOGIN PASSWORD 'container-test-auth-password';
GRANT CONNECT ON DATABASE jrc_broker TO jrc_app, jrc_auth;
