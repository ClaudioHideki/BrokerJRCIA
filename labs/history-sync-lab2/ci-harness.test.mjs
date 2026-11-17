import{test}from'node:test';
import assert from'node:assert/strict';
import{readFileSync,existsSync,mkdtempSync,rmSync,mkdirSync,writeFileSync}from'node:fs';
import{spawnSync}from'node:child_process';
import{join,resolve}from'node:path';
import{homedir,tmpdir}from'node:os';
import{createHash}from'node:crypto';
import{parse}from'yaml';
const root=resolve('labs/history-sync-lab2');
const bash=process.env.BASH_BIN??(process.platform==='win32'?join(homedir(),'AppData/Local/Programs/Git/bin/bash.exe'):'bash');
const read=name=>readFileSync(join(root,name),'utf8');
const run=(args,env={})=>spawnSync(bash,[join(root,'run-ci.sh'),...args],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'',RUNNER_ENVIRONMENT:'',HISTORY_LAB2_CHECKOUT:'',HISTORY_LAB2_SHA:'',...env}});
test('disposable Rails and Sidekiq enable the Broker receiver for the synthetic origin',()=>{
 const c=parse(read('compose.ci.yml'),{merge:true});
 for(const name of ['rails','sidekiq']){
  assert.equal(c.services[name].environment.RAILS_ENV,'test');
  assert.equal(c.services[name].environment.JRC_BROKER_ENABLED,'true');
  assert.equal(c.services[name].environment.JRC_HISTORY_SYNC_V2_ENABLED,'true');
  assert.equal(c.services[name].environment.JRC_BROKER_ALLOWED_ORIGINS,'https://synthetic.example.test');
 }
});
test('signed attachment URLs use the published Rails origin after test configuration loads',()=>{
 const source=read('rails-initializer.rb');
 const hook=source.split('Rails.application.config.after_initialize do')[1];
 assert.ok(hook,'fixture initialization hook required');
 assert.match(hook,/Rails[.]application[.]routes[.]default_url_options\s*=\s*\{\s*host:\s*'127[.]0[.]0[.]1',\s*port:\s*54141,\s*protocol:\s*'http'\s*\}/);
});
test('Linux harness entrypoints have valid Bash syntax',()=>{for(const name of['run-ci.sh','start-ci.sh']){assert.ok(existsSync(join(root,name)),name+' missing');const r=spawnSync(bash,['-n',join(root,name)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}});
test('refuses non-CI use before Docker or credential generation',()=>{const r=run(['--check']);assert.notEqual(r.status,0);assert.match(r.stderr,/GitHub-hosted CI required/);});
test('rejects absent or mutable LAB2 revision before Docker',()=>{for(const revision of['','main','a'.repeat(39),'a'.repeat(41)]){const r=run(['--check'],{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',HISTORY_LAB2_SHA:revision});assert.notEqual(r.status,0);assert.match(r.stderr,/exact LAB2 SHA/);}});
test('refuses arbitrary test path before touching Docker',()=>{const r=run(['../../infra/unrelated.sh'],{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',HISTORY_LAB2_SHA:'a'.repeat(40)});assert.notEqual(r.status,0);assert.match(r.stderr,/Unknown test selection/);});
test('Compose isolates service persistence and publishes only loopback ports',()=>{const s=read('compose.ci.yml');assert.match(s,/pgvector[/]pgvector:pg16@sha256:7b822b/);assert.match(s,/redis:7[.]4[.]0-alpine@sha256:c35af/);assert.equal((s.match(/ports: [[][']127[.]0[.]0[.]1:/g)??[]).length,3);assert.match(s,/54141:3000/);assert.match(s,/jrc-history-v2-e2e-minio-20261112/);assert.match(s,/jrc-history-v2-sidekiq-20261112/);assert.doesNotMatch(s,/external:|privileged:|docker[.]sock|host_network|network_mode: host/);assert.match(s,/tmpfs:/);});
test('exact Ruby and verified MinIO fixture replace old runtime images',()=>{const s=read('Dockerfile.ci');assert.match(s,/FROM ruby:3[.]4[.]12-bookworm/);assert.match(s,/2[.]5[.]16/);assert.match(s,/7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f/);assert.match(s,/BUNDLE_FROZEN=true/);assert.match(s,/COPY --from=lab2/);});
test('worker starts only low queue with cron disabled and schema creation stays explicit',()=>{const s=read('start-ci.sh');assert.match(s,/printf.*\{\}.*schedule[.]yml/);assert.match(s,/sidekiq -e test -q low -c 1/);assert.match(s,/db:schema:load/);assert.doesNotMatch(s,/db:prepare|db:reset|backup|pg_dump|restore|cron.*start/);});
test('all existing E2E Docker callers support context override while preserving desktop default',()=>{for(const name of['chatwoot-live-lab2','history-sync-lab2']){const s=readFileSync(resolve('apps/api/tests/integration',name+'.test.ts'),'utf8');assert.match(s,/HISTORY_LAB_DOCKER_CONTEXT/);assert.match(s,/desktop-linux/);assert.ok(!s.includes("['--context','desktop-linux'"));}});

test('generated Rails credential decodes to exactly32 bytes and no credential is printed',()=>{
 const script=read('run-ci.sh').match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)?.[1];assert.ok(script);
 const dir=mkdtempSync(join(tmpdir(),'jrc-lab-ci-test-'));
 try{const file=join(dir,'synthetic.env'),r=spawnSync(process.execPath,['--input-type=module','-',file],{encoding:'utf8',input:script});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');
  const env=Object.fromEntries(readFileSync(file,'utf8').trim().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
  assert.equal(Buffer.from(env.JRC_BROKER_CREDENTIAL_KEY,'base64').length,32);
  assert.equal(env.HISTORY_LAB_HTTP_KEY,createHash('sha256').update('synthetic-history-http:'+env.JRC_BROKER_CREDENTIAL_KEY).digest('hex'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('rejects a different repository before accepting any revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jrc-lab-ci-repo-'));
 try{assert.equal(spawnSync('git',['init',dir],{encoding:'utf8'}).status,0);assert.equal(spawnSync('git',['-C',dir,'remote','add','origin','https://github.com/other/unrelated.git'],{encoding:'utf8'}).status,0);
  const r=run(['--check'],{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',HISTORY_LAB2_SHA:'a'.repeat(40),HISTORY_LAB2_CHECKOUT:dir});assert.notEqual(r.status,0);assert.match(r.stderr,/LAB2 repository identity mismatch/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('start process refuses a production environment before touching application files',()=>{
 const r=spawnSync(bash,[join(root,'start-ci.sh'),'rails'],{encoding:'utf8',env:{...process.env,RAILS_ENV:'production',HISTORY_LAB_MODE:'true',HISTORY_LAB_CI:'true'}});assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.ok(!r.stderr.includes('/testapp'));
});
test('all and live selections include the independent outbound-media E2E',()=>{
 const s=read('run-ci.sh');assert.match(s,/all\|live\|group\|history\|operational\|outbound\|--check/);assert.match(s,/selection == all \|\| \$selection == live \|\| \$selection == outbound.*files\+=\(chatwoot-outbound-media-lab2\)/);
});

test('GROUP live travels through its independent worker HTTP suite',()=>{
 const s=read('run-ci.sh');
 assert.match(s,/all\|live\|group\|history\|operational\|outbound\|--check/);
 assert.match(s,/selection == all \|\| \$selection == live \|\| \$selection == group.*files\+=\(chatwoot-group-live-lab2\)/);
});

test('PG and private MinIO persist through container restarts in owned project volumes',()=>{
 const c=parse(read('compose.ci.yml'),{merge:true});
 assert.ok(c.services.postgres.volumes.includes('postgres-data:/var/lib/postgresql/data'));assert.ok(c.services.minio.volumes.includes('minio-data:/data'));
 for(const volume of Object.values(c.volumes)){assert.equal(volume.labels['com.jrc.purpose'],'broker-lab2-github-e2e');assert.ok(!volume.external);assert.ok(!volume.name);}
 assert.ok(!c.services.postgres.tmpfs);assert.ok(!c.services.minio.tmpfs.some(v=>v.startsWith('/data')));
});
test('failure log sanitizer removes generated keys and credential-bearing lines',()=>{
 const r=spawnSync(process.execPath,[join(root,'sanitize-ci-logs.mjs')],{encoding:'utf8',env:{...process.env,HISTORY_LAB_HTTP_KEY:'secret-fixture-value'},input:'worker failure secret-fixture-value\napi_access_token: dynamically-created-token\nordinary startup failure\n'});
 assert.equal(r.status,0,r.stderr);assert.ok(!r.stdout.includes('secret-fixture-value'));assert.ok(!r.stdout.includes('dynamically-created-token'));assert.match(r.stdout,/ordinary startup failure/);
});

test('suite runner collects all five results and fails overall when one independent suite fails',()=>{
 const block=read('run-ci.sh').match(/# BEGIN E2E SUITE RUNNER\r?\n([\s\S]*?)# END E2E SUITE RUNNER/)?.[1];assert.ok(block,'independent suite runner missing');
 const dir=mkdtempSync(join(tmpdir(),'jrc-lab-ci-results-'));
 try{const script='set -euo pipefail\nselection=all\nevidence=$TEST_EVIDENCE\nnpm(){ if [[ $4 == *chatwoot-live-lab2* ]]; then return 9; fi; return 0; }\n'+block+'\nrun_selected_suites';
  const r=spawnSync(bash,['-c',script],{encoding:'utf8',env:{...process.env,TEST_EVIDENCE:dir}});assert.equal(r.status,1,r.stderr);
  const rows=readFileSync(join(dir,'status.tsv'),'utf8').trim().split('\n');assert.equal(rows.length,6);assert.match(rows[1],/chatwoot-live-lab2\t9\t\d+/);assert.match(rows[2],/chatwoot-group-live-lab2\t0\t\d+/);assert.match(rows[5],/history-sync-operational-lab2\t0\t\d+/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('workflow prepares runner-scoped evidence at execution time and shares it with harness and artifact',()=>{
 const workflow=parse(readFileSync(resolve('.github/workflows/delivery-lab2-e2e.yml'),'utf8'));
 const job=workflow.jobs['rails-sidekiq-private-media'];
 for(const value of Object.values(job.env??{}))assert.doesNotMatch(String(value),/\$\{\{\s*runner\./,'runner context is unavailable in jobs.<job_id>.env');
 const setup=job.steps.find(step=>step.id==='evidence');assert.ok(setup?.run,'runtime evidence setup missing');
 assert.equal(job.steps[0],setup,'evidence must exist before checkout or test failures');
 const dir=mkdtempSync(join(tmpdir(),'jrc-ci-evidence space-'));
 try{
  const runner=join(dir,'runner temp'),envFile=join(dir,'github.env');
  const portable=value=>process.platform==='win32'?value.replace(/\\/g,'/'):value;
  const result=spawnSync(bash,['-c',setup.run],{encoding:'utf8',env:{...process.env,RUNNER_TEMP:portable(runner),GITHUB_ENV:portable(envFile)}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
  const line=readFileSync(envFile,'utf8').trim();assert.equal(line,'HISTORY_LAB_EVIDENCE_DIR='+portable(join(runner,'broker-lab2-delivery-evidence')));
  assert.ok(existsSync(join(runner,'broker-lab2-delivery-evidence')));
  assert.equal(job.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@')).with.path,'${{ env.HISTORY_LAB_EVIDENCE_DIR }}/');
  assert.match(read('run-ci.sh'),/evidence=\$\{HISTORY_LAB_EVIDENCE_DIR:-/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('both workflows compile the API dependency graph before storage or cross-repository execution',()=>{
 for(const [file,jobName,execute] of [
  ['delivery-regression.yml','transport',/npm run test:storage:ci/],
  ['delivery-lab2-e2e.yml','rails-sidekiq-private-media',/run-ci[.]sh (?:--check|all)/],
 ]){
  const steps=parse(readFileSync(resolve('.github/workflows',file),'utf8')).jobs[jobName].steps;
  const install=steps.findIndex(s=>s.run?.trim()==='npm ci'),compile=steps.findIndex(s=>/npx(?: --no-install)? tsc -b/.test(s.run??''));
  const execution=steps.findIndex(s=>execute.test(s.run??''));
  assert.ok(install>=0&&compile>install&&execution>compile,file+' must compile after install and before runtime consumers');
 }
});

test('compiled Broker prerequisites fail before Docker and accept a complete fixture graph',()=>{
 const script=read('run-ci.sh'),block=script.match(/# BEGIN COMPILED PREREQUISITES\r?\n([\s\S]*?)# END COMPILED PREREQUISITES/)?.[1];
 assert.ok(block,'compiled prerequisites missing');
 assert.ok(script.indexOf('# BEGIN COMPILED PREREQUISITES')<script.indexOf('docker_cmd='),'must reject before Docker');
 const dir=mkdtempSync(join(tmpdir(),'jrc-ci-compiled-'));
 try{
  const portable=value=>process.platform==='win32'?value.replace(/\\/g,'/'):value;
  const code='set -euo pipefail\nroot=$TEST_COMPILED_ROOT\ndie(){ echo "$1" >&2; exit 64; }\n'+block;
  const runGuard=()=>spawnSync(bash,['-c',code],{encoding:'utf8',env:{...process.env,TEST_COMPILED_ROOT:portable(dir)}});
  const missing=runGuard();assert.equal(missing.status,64);assert.match(missing.stderr,/Compiled Broker prerequisite missing/);
  for(const relative of ['apps/api/dist/modules/messaging/private-object-store.js','packages/contracts/dist/index.js','packages/providers/dist/index.js','packages/security/dist/index.js']){
   const target=join(dir,relative);mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,'export {};\n');
  }
  const ready=runGuard();assert.equal(ready.status,0,ready.stderr);assert.equal(ready.stdout,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('runner bridge supports explicit loopback publications and captures sanitized startup diagnostics',()=>{
 const c=parse(read('compose.ci.yml'),{merge:true});assert.equal(c.networks.lab.driver,'bridge');assert.ok(!c.networks.lab.internal);
 assert.equal(c.networks.lab.driver_opts['com.docker.network.bridge.host_binding_ipv4'],'127.0.0.1');
 assert.equal(c.networks.lab.labels['com.jrc.purpose'],'broker-lab2-github-e2e');
 for(const service of Object.values(c.services))for(const port of service.ports??[])assert.match(port,/^127[.]0[.]0[.]1:/);
 const s=read('run-ci.sh');assert.match(s,/logs --no-color --tail 200 postgres redis minio rails sidekiq[^\n]*sanitize-ci-logs[.]mjs/);
});
