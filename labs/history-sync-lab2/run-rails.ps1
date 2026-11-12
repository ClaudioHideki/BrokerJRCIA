#requires -Version 7
param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$taskContext = 'desktop-linux'
$taskName = 'jrc-history-v2-complete-20261112-rails'
$taskStorage = (docker --context $taskContext inspect 'jrc-history-v2-complete-20261112-minio' | ConvertFrom-Json)[0]
$taskRails = (docker --context $taskContext inspect $taskName | ConvertFrom-Json)[0]
if ($taskStorage.Config.Labels.'com.jrc.test' -ne 'jrc-history-v2-complete-20261112' -or
    $taskRails.Config.Labels.'com.jrc.test' -ne 'jrc-history-v2-complete-20261112') { throw 'Only isolated history test containers permitted' }

$env:HISTORY_PHYSICAL_STORAGE_TEST = 'true'
$env:RAILS_ENV = 'test'
$env:STORAGE_ENDPOINT = 'http://jrc-history-v2-complete-20261112-minio:9000'
$env:STORAGE_REGION = 'us-east-1'
$env:STORAGE_FORCE_PATH_STYLE = 'true'
$env:STORAGE_BUCKET_NAME = 'synthetic-history-20261112'
# Temporary synthetic credentials are read only into process memory. No file/log.
$env:STORAGE_ACCESS_KEY_ID = ($taskStorage.Config.Env | Where-Object { $_ -like 'MINIO_ROOT_USER=*' }) -replace '^MINIO_ROOT_USER=', ''
$env:STORAGE_SECRET_ACCESS_KEY = ($taskStorage.Config.Env | Where-Object { $_ -like 'MINIO_ROOT_PASSWORD=*' }) -replace '^MINIO_ROOT_PASSWORD=', ''
$taskEnvironment = @('HISTORY_PHYSICAL_STORAGE_TEST','RAILS_ENV','STORAGE_ENDPOINT','STORAGE_REGION','STORAGE_FORCE_PATH_STYLE',
  'STORAGE_BUCKET_NAME','STORAGE_ACCESS_KEY_ID','STORAGE_SECRET_ACCESS_KEY')
$taskArguments = @('--context',$taskContext,'exec')
foreach ($taskKey in $taskEnvironment) { $taskArguments += @('-e',$taskKey) }
$taskArguments += @('-w','/testapp',$taskName,'bundle','exec','rspec',
  'spec/requests/jrc_history_sync_v2_spec.rb','spec/services/jrc_broker/history_sync_media_spec.rb',
  'spec/services/jrc_broker/history_sync_contract_canonical_spec.rb','spec/services/jrc_broker/history_media_body_limit_spec.rb',
  'spec/requests/api/v1/accounts/conversations_member_inboxes_spec.rb','spec/services/conversations/shared_inbox_routing_spec.rb',
  'spec/services/conversations/inbox_visibility_exclusive_spec.rb',
  '--format','json','--out','/evidence/rails-current-regression.json','--format','progress')
& docker @taskArguments *> (Join-Path $EvidenceDirectory 'rails-current-regression.log')
$taskExitCode = $LASTEXITCODE
Remove-Item Env:STORAGE_ACCESS_KEY_ID,Env:STORAGE_SECRET_ACCESS_KEY
exit $taskExitCode
