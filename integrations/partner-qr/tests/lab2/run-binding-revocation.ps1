param(
  [Parameter(Mandatory = $true)][string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$image = 'sha256:b375544ab454a24fb8a305ba6f476c9b09b8aa0d99bed645c184d41510552fbb'
$files = @{
  'application_policy' = 'app/policies/application_policy.rb'
  'jrc_broker_policy' = 'app/policies/jrc_broker_policy.rb'
  'client' = 'app/services/jrc_broker/client.rb'
  'access' = 'app/services/jrc_broker/access.rb'
  'response' = 'app/services/jrc_broker/response.rb'
  'control' = 'app/services/jrc_broker/control.rb'
}
$expected = @{
  'application_policy' = @('c71962c2e8c51a2ec57b23a97eb78026b0ddc2305c545e54bac72ac2a6cd3c51')
  'jrc_broker_policy' = @('ff999497f73c907bc311403530ca53c1ba597a37d73aa2ec9a414a57c4b13c1e',
    '1aa9dc05593f0491d58eeb0833664641bfa0b949142f3376f32e16262998f229',
    'd6352a3140b0ca04fd2809bd269d73be59a60ee1fd09394a04ec14535837dc7f')
  'client' = @('26e95a8cff9e1f327b655830a5c65c942e6455ec0ed97e6c8e08b786eb794dda')
  'access' = @('58e5ebef4344ad4afcf10adcaaafc38c1d7953684346eb4bdd86774a6fd2f90c')
  'response' = @('50d088aaae54eb58ed23b97fd721c48316d4f635c1ebf4e84063d5af72e5cd40')
  'control' = @('0da423efae5892accef38fde3ccbe592947dde84c594576bca942f90e3fd2442')
}
$arguments = @('run', '--rm', '--pull', 'never', '--name', "jrc-lab2-binding-$PID", '--network', 'none',
  '--memory', '64m', '--cpus', '0.25', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges')
foreach ($entry in $files.GetEnumerator()) {
  $file = (Resolve-Path -LiteralPath (Join-Path $source $entry.Value)).Path
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -notin $expected[$entry.Key]) { throw "LAB2_SOURCE_CHANGED_REVIEW_REQUIRED: $($entry.Value)" }
  Write-Output ("SOURCE_SHA256 {0} {1}" -f $entry.Value, $hash)
  $arguments += @('--mount', "type=bind,source=$file,target=/consumer/$($entry.Key).rb,readonly")
}
$probe = Join-Path $PSScriptRoot 'binding-revocation-probe.rb'
$requestSpec = (Resolve-Path -LiteralPath (Join-Path $source 'spec/requests/api/v1/accounts/jrc_broker_spec.rb')).Path
$arguments += @('--mount', "type=bind,source=$requestSpec,target=/request_spec.rb,readonly")
$arguments += @('--mount', "type=bind,source=$probe,target=/probe.rb,readonly", '--entrypoint', 'ruby', $image, '/probe.rb')
& docker @arguments
exit $LASTEXITCODE
