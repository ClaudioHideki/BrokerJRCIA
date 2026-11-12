#requires -Version 7
param([Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference = 'Stop'
$taskContext = 'desktop-linux'
function Read-LabContainer([string]$Name,[string]$Label) {
  $value = (docker --context $taskContext inspect $Name | ConvertFrom-Json)[0]
  if ($LASTEXITCODE -ne 0 -or $value.Config.Labels.'com.jrc.test' -ne $Label) { throw 'Only owned synthetic containers permitted' }
  return $value
}
$taskPg = Read-LabContainer 'broker-history-native-pg-20261112' 'broker-history-native-20261112'
$taskStorage = Read-LabContainer 'jrc-history-v2-e2e-minio-20261112' 'jrc-history-v2-complete-20261112'
$taskHttp = Read-LabContainer 'jrc-history-v2-http-20261112' 'jrc-history-v2-complete-20261112'
& docker --context $taskContext cp (Join-Path $PSScriptRoot 'prepare-storage.rb') 'jrc-history-v2-http-20261112:/testapp/jrc_history_prepare_storage.rb'
if ($LASTEXITCODE -ne 0) { throw 'Synthetic storage fixture copy failed' }
& docker --context $taskContext exec -w /testapp 'jrc-history-v2-http-20261112' bundle exec rails runner ./jrc_history_prepare_storage.rb *> ($EvidencePath + '.storage.log')
if ($LASTEXITCODE -ne 0) { throw 'Synthetic Rails bucket initialization failed' }
$taskPort = $taskPg.NetworkSettings.Ports.'5432/tcp'[0].HostPort
$env:TEST_DATABASE_ADMIN_URL = "postgres://postgres@127.0.0.1:$taskPort/jrc_test_history_admin"
$env:NODE_OPTIONS = '--max-old-space-size=384'
$env:HISTORY_LAB2_E2E = 'true'
$env:HISTORY_LAB2_ORIGIN = 'http://127.0.0.1:54141'
$taskStoragePort = $taskStorage.NetworkSettings.Ports.'9000/tcp'[0]
if ($taskStoragePort.HostIp -ne '127.0.0.1' -or -not $taskStoragePort.HostPort) { throw 'Only running loopback storage permitted' }
$env:HISTORY_LAB_MINIO_ENDPOINT = 'http://127.0.0.1:' + $taskStoragePort.HostPort
$env:HISTORY_LAB_RAILS_CONTAINER = 'jrc-history-v2-http-20261112'
$env:HISTORY_LAB2_CHECKOUT = 'C:\Users\DEV02\.codex\worktrees\whatsapp-history-order\consolidacao-core-20261109'
# Read only this test container's temporary credentials; never write them to evidence.
$env:HISTORY_LAB_MINIO_ACCESS = ($taskStorage.Config.Env | Where-Object { $_ -like 'MINIO_ROOT_USER=*' }) -replace '^MINIO_ROOT_USER=', ''
$env:HISTORY_LAB_MINIO_SECRET = ($taskStorage.Config.Env | Where-Object { $_ -like 'MINIO_ROOT_PASSWORD=*' }) -replace '^MINIO_ROOT_PASSWORD=', ''
$taskCredential = ($taskHttp.Config.Env | Where-Object { $_ -like 'JRC_BROKER_CREDENTIAL_KEY=*' }) -replace '^JRC_BROKER_CREDENTIAL_KEY=', ''
$env:HISTORY_LAB_HTTP_KEY = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
  [Text.Encoding]::UTF8.GetBytes('synthetic-history-http:' + $taskCredential))).ToLowerInvariant()
& npm run test:integration -- apps/api/tests/integration/history-sync-lab2.test.ts --maxWorkers=1 --no-file-parallelism *> $EvidencePath
exit $LASTEXITCODE
