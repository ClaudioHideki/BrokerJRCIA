# MinIO fixture for the required storage gate

This fixture runs only in CI or a disposable laboratory. It is not production configuration or a deployment of MinIO in the JRC images.

The vendor artifact is fixed to MinIO `RELEASE.2025-09-07T16-13-09Z`, commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`, linux/amd64, Go1.24.6. The binary tested by the laboratory and the digest exposed by the official GitHub release API are the same:

- Origin: https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z
- SHA-256: `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`
- Exact size:110989496 bytes.
- Vendor release metadata: https://api.github.com/repos/minio/minio/releases/tags/RELEASE.2025-09-07T16-13-09Z
- License origin: https://github.com/minio/minio/blob/07c3a429bfed433e49018cb0f78a52145d4bedeb/LICENSE

Copyright 2015-2025 MinIO, Inc. License: GNU Affero General Public License version3. The complete vendor license is preserved in `docs/legal/minio/LICENSE`. The fixture binary is executed without modification in a temporary directory, removed after the gate and never copied into the application image. No attribution or vendor license is replaced.

`npm run test:integration` uses only PostgreSQL/Redis; `npm run test:storage` explicitly selects the five real private-media cases. It requires `TEST_DATABASE_ADMIN_URL` and these values with no local file, hardcoded endpoint or skip fallback:

```text
TEST_STORAGE_ENDPOINT
TEST_STORAGE_BUCKET
TEST_STORAGE_PROFILE
TEST_STORAGE_REGION
TEST_STORAGE_ACCESS_KEY_ID
TEST_STORAGE_SECRET_ACCESS_KEY
TEST_STORAGE_SERVER_RELEASE
TEST_STORAGE_BINARY_SHA256
```

`npm run test:storage:ci` is required in both CI and the image publication workflow before image builds. It downloads only the pinned official asset with a bounded request/size, verifies SHA-256 and executed version, starts that binary directly on a free loopback port, waits for real readiness, creates a fresh private bucket via SigV4, supplies randomly generated test credentials/bucket and runs `npm run test:storage`. The real adapter then checks bucket safety, signed wildcard conditional PUT conflict with preserved original bytes, anonymous denial and observed deletion before the five PostgreSQL cases. No proxy or synthetic precondition server is used.

Normal completion and every setup/test error run cleanup in finally: stop the private process and remove only the verified temporary fixture directory. Server output, credentials and signed request headers are not logged. Missing required variables, download/hash/version/health/conditional-write failures or failing tests are gate failures. Running contract tests with injected ports only validates orchestration; a green GitHub execution on the same revision is still required to claim the remote CI storage gate passed.
