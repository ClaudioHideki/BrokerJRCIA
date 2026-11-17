#!/usr/bin/env bash
set -euo pipefail
# Deliberately no xtrace: temporary synthetic credentials never enter logs.
die() { echo "$1" >&2; exit 64; }
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || die 'GitHub-hosted CI required'
selection=${1:-all}
case "$selection" in all|live|group|history|operational|outbound|--check) ;; *) die 'Unknown test selection';; esac
[[ ${HISTORY_LAB2_SHA:-} =~ ^[0-9a-f]{40}$ ]] || die 'An exact LAB2 SHA is required'
[[ -n ${HISTORY_LAB2_CHECKOUT:-} && -d $HISTORY_LAB2_CHECKOUT ]] || die 'An external LAB2 checkout is required'
source_path=$(cd "$HISTORY_LAB2_CHECKOUT" && pwd -P)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ $source_path != "$root" && $source_path != / ]] || die 'LAB2 must be an external checkout'
case $(git -C "$source_path" config --get remote.origin.url || true) in
  https://github.com/ClaudioHideki/jrc-conversas-lab2|https://github.com/ClaudioHideki/jrc-conversas-lab2.git|git@github.com:ClaudioHideki/jrc-conversas-lab2.git) ;;
  *) die 'LAB2 repository identity mismatch';;
esac
[[ $(git -C "$source_path" rev-parse HEAD) == "$HISTORY_LAB2_SHA" ]] || die 'LAB2 checkout SHA mismatch'
[[ -z $(git -C "$source_path" status --porcelain) ]] || die 'LAB2 checkout must be clean'
for file in Gemfile Gemfile.lock db/schema.rb spec/assets/sample.png spec/assets/sample.ogg spec/assets/sample.pdf spec/assets/synthetic-opus.ogg; do
  [[ -f $source_path/$file ]] || die 'LAB2 source contract missing'
done
grep -q "ruby '3.4.12'" "$source_path/Gemfile" || die 'LAB2 Ruby version mismatch'
[[ $(node --version) == v24.19.0 ]] || die 'Node24.19.0 required'
# BEGIN COMPILED PREREQUISITES
for compiled in apps/api/dist/modules/messaging/private-object-store.js packages/contracts/dist/index.js packages/providers/dist/index.js packages/security/dist/index.js; do
  [[ -f $root/$compiled ]] || die "Compiled Broker prerequisite missing: $compiled; run npx tsc -b first"
done
# END COMPILED PREREQUISITES
if [[ $selection == --check ]]; then echo 'Exact LAB2 source and CI preflight verified'; exit 0; fi
[[ $(uname -s) == Linux ]] || die 'Linux runner required'
[[ -z ${DOCKER_HOST:-} && -z ${DOCKER_CONTEXT:-} ]] || die 'Remote Docker overrides prohibited'
export HISTORY_LAB_DOCKER_CONTEXT=default
docker_cmd=(docker --context "$HISTORY_LAB_DOCKER_CONTEXT")
[[ $("${docker_cmd[@]}" context inspect default --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]] || die 'Local runner Docker socket required'
[[ -z $("${docker_cmd[@]}" ps -aq --filter label=com.docker.compose.project=jrc-history-ci) ]] || die 'Synthetic Compose project already in use'
[[ -z $("${docker_cmd[@]}" volume ls -q --filter label=com.docker.compose.project=jrc-history-ci) ]] || die 'Synthetic Compose data already in use'
for name in broker-history-native-pg-20261112 jrc-history-v2-http-20261112 jrc-history-v2-sidekiq-20261112 jrc-history-v2-e2e-minio-20261112; do
  if "${docker_cmd[@]}" inspect "$name" >/dev/null 2>&1; then die 'Synthetic container name already in use'; fi
done
cd "$root"
evidence=${HISTORY_LAB_EVIDENCE_DIR:-$root/artifacts/history-lab2}
mkdir -p "$evidence"
task_tmp=$(mktemp -d "${RUNNER_TEMP:?Runner temporary directory required}/jrc-history-ci.XXXXXXXX")
chmod 0700 "$task_tmp"
export HISTORY_LAB_CI_ENV=$task_tmp/synthetic.env HISTORY_LAB_CI_SOURCE=$task_tmp/lab2-source
compose=("${docker_cmd[@]}" compose --project-name jrc-history-ci -f "$root/labs/history-sync-lab2/compose.ci.yml")
started=false
cleanup() {
  status=$?
  trap - EXIT
  if [[ $started == true ]]; then
    if [[ $status != 0 ]]; then
      "${compose[@]}" logs --no-color --tail 200 postgres redis minio rails sidekiq 2>&1 | node "$root/labs/history-sync-lab2/sanitize-ci-logs.mjs" > "$evidence/failure-startup.log" || true
    fi
    "${compose[@]}" down --volumes --timeout 20 >/dev/null 2>&1 || true
  fi
  [[ $task_tmp == "${RUNNER_TEMP}/jrc-history-ci."* ]] && rm -rf -- "$task_tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$HISTORY_LAB_CI_SOURCE"
# Package tracked exact-SHA source only; ignored .env/auth state cannot enter build.
git -C "$source_path" archive "$HISTORY_LAB2_SHA" | tar -xf - -C "$HISTORY_LAB_CI_SOURCE"
# LAB2's product .dockerignore excludes spec; only this exported test-build
# context gets an overlay so FactoryBot and synthetic asset fixtures are present.
printf '.git\nnode_modules\n**/node_modules\n.env\n.env.*\n' > "$HISTORY_LAB_CI_SOURCE/.dockerignore"
node --input-type=module - "$HISTORY_LAB_CI_ENV" <<'NODE'
import {randomBytes,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const key=randomBytes(32).toString('base64'),access='synthetic-'+randomBytes(12).toString('hex'),secret=randomBytes(32).toString('hex');
const env={SECRET_KEY_BASE:randomBytes(64).toString('hex'),JRC_BROKER_CREDENTIAL_KEY:key,
 HISTORY_LAB_HTTP_KEY:createHash('sha256').update('synthetic-history-http:'+key).digest('hex'),
 MINIO_ROOT_USER:access,MINIO_ROOT_PASSWORD:secret,STORAGE_ACCESS_KEY_ID:access,STORAGE_SECRET_ACCESS_KEY:secret};
writeFileSync(process.argv[2],Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
NODE
set -a
source "$HISTORY_LAB_CI_ENV"
set +a
printf 'Broker SHA: %s\nLAB2 SHA: %s\nRuby: 3.4.12\nNode: 24.19.0\n' "$(git rev-parse HEAD)" "$HISTORY_LAB2_SHA" > "$evidence/provenance.txt"
printf '\nObserved runner resources\n' >> "$evidence/provenance.txt"
getconf _NPROCESSORS_ONLN >> "$evidence/provenance.txt"
free -m >> "$evidence/provenance.txt"
df -Pm "$root" >> "$evidence/provenance.txt"
"${compose[@]}" build rails minio > "$evidence/build.log" 2>&1
started=true
"${compose[@]}" up -d --wait postgres redis minio > "$evidence/start.log" 2>&1
storage_port=$("${docker_cmd[@]}" inspect --format '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}' jrc-history-v2-e2e-minio-20261112)
pg_port=$("${docker_cmd[@]}" inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' broker-history-native-pg-20261112)
export HISTORY_LAB_MINIO_ENDPOINT=http://127.0.0.1:$storage_port
node --input-type=module <<'NODE'
const until=Date.now()+60000;let ready=false;
while(Date.now()<until){try{const r=await fetch(process.env.HISTORY_LAB_MINIO_ENDPOINT+'/minio/health/cluster',{signal:AbortSignal.timeout(1500)});await r.body?.cancel();if(r.status===200&&!r.headers.get('x-minio-server-status')){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
if(!ready)throw Error('Synthetic private storage did not become ready');
NODE
"${compose[@]}" run --rm --no-deps rails schema > "$evidence/schema.log" 2>&1
"${compose[@]}" up -d --no-deps rails sidekiq >> "$evidence/start.log" 2>&1
export HISTORY_LAB2_E2E=true HISTORY_LAB2_ORIGIN=http://127.0.0.1:54141 HISTORY_LAB_RAILS_CONTAINER=jrc-history-v2-http-20261112
export HISTORY_LAB_MINIO_ACCESS=$MINIO_ROOT_USER HISTORY_LAB_MINIO_SECRET=$MINIO_ROOT_PASSWORD
export TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:$pg_port/postgres
export NODE_OPTIONS=--max-old-space-size=512
node --input-type=module <<'NODE'
const until=Date.now()+120000;let ready=false;
while(Date.now()<until){try{const r=await fetch(process.env.HISTORY_LAB2_ORIGIN+'/__history_lab/seed',{method:'POST',headers:{'Content-Type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY},body:'{}',signal:AbortSignal.timeout(3000)});await r.body?.cancel();if(r.status===400){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
if(!ready)throw Error('Synthetic Rails fixture did not become ready');
NODE
# BEGIN E2E SUITE RUNNER
run_selected_suites() {
  local file status start failed=0
  local files=()
  [[ $selection == all || $selection == live ]] && files+=(chatwoot-live-lab2)
  [[ $selection == all || $selection == live || $selection == group ]] && files+=(chatwoot-group-live-lab2)
  [[ $selection == all || $selection == live || $selection == outbound ]] && files+=(chatwoot-outbound-media-lab2)
  [[ $selection == all || $selection == history ]] && files+=(history-sync-lab2)
  [[ $selection == all || $selection == operational ]] && files+=(history-sync-operational-lab2)
  printf 'test\texit_code\tduration_seconds\n' > "$evidence/status.tsv"
  for file in "${files[@]}"; do
    echo "Running isolated $file"
    start=$SECONDS
    if npm run test:integration -- "apps/api/tests/integration/$file.test.ts" --maxWorkers=1 --no-file-parallelism > "$evidence/$file.log" 2>&1; then
      status=0
    else
      status=$?
      failed=1
    fi
    printf '%s\t%s\t%s\n' "$file" "$status" "$((SECONDS-start))" >> "$evidence/status.tsv"
  done
  return "$failed"
}
# END E2E SUITE RUNNER
run_selected_suites
echo 'Laboratory selection completed; see evidence logs'
