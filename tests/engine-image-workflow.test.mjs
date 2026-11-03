import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

const revision='a'.repeat(40),image='sha256:'+'b'.repeat(64);
function fixture(){return {revision,image,inspect:{Id:image,Config:{User:'node',Entrypoint:['node','jrc-image/entrypoint.mjs'],
 Labels:{'org.opencontainers.image.revision':revision,'com.jrc.delivery-ownership':'UNPROVEN','com.jrc.evolution-source':'fa09d37892cdbb1d65a250155d293d92230c5b30'},
 Env:['JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false']}},
 admission:{image,ownership:'UNPROVEN',realEngineBoot:false,network:'none',results:[
  {case:'original_image_artifact_contract',passed:true},
  ...['capture_true','invalid_flag','tampered_receipt'].map(name=>({case:name,passed:true,exitCode:1,canaryDisclosed:false}))]},
 cleanup:[{status:'confirmed_removed'}],
 provisioned:{image,gate:'PROVISIONED_ENGINE_AND_REAL_HOOK_SOURCE_CRASH_VERIFIED',capture:false,ownership:'UNPROVEN',productionApproved:false,
  operationallyReady:false,cleanupConfirmed:true,emptyEngineBootAndShutdownVerified:true,engineOOMKilled:false,
  catalogUnchanged:true,ddlStatementLogCount:0,syntheticSecretDisclosed:false,engineFinalExitCode:0,
  artifactCustody:{gate:'ARTIFACT_MODULES_CUSTODY_CRASH_VERIFIED',engineMainImported:false,syntheticSource:true,actualWhatsAppSession:false,
   cases:[{sigkillObserved:true,sameEventRecovered:true,replayLegacyEffects:0},{sigkillObserved:true,sameEventRecovered:true,replayLegacyEffects:0}]},
  realHook:{gate:'REAL_ENGINE_HOOK_AND_SOURCE_CRASH_VERIFIED',sourceMainImported:true,recoveryMainImported:true,
   productionCapture:false,productionOwnership:'UNPROVEN',actualWhatsAppSession:false,nativeHandlerReplaced:false,
   sourceExitSignal:'SIGKILL',recoveryStopExitCode:1,sourcePid:101,recoveryPid:202,syntheticPayloadLoggedByUpstream:false,
   terminationObservations:[
    {pid:101,requestedSignal:'SIGKILL',alreadyExited:false,exitCode:null,signalCode:'SIGKILL'},
    {pid:202,requestedSignal:'SIGTERM',alreadyExited:false,exitCode:1,signalCode:null}],
   journalEvents:2,receiverRows:2,nativeMessages:1,
   unownedLegacyRequests:1,ownedDispatcherRequests:2,replayNativeEffects:0,cleanupConfirmed:true}}};}
async function validate(input){const {verifyEngineEvidence}=await import('../scripts/ci/verify-engine-candidate.mjs');return verifyEngineEvidence(input);}
describe('engine publication evidence (synthetic verifier fixtures, not Docker proof)',()=>{
 it('accepts only the same tested image and keeps ownership/capture/real-session claims unapproved',async()=>{
  expect(await validate(fixture())).toMatchObject({image,revision,publishableCandidate:true,productionCaptureApproved:false,realSessionHomologated:false});
 });
 it.each([
  ['different image after gates',x=>{x.inspect.Id='sha256:'+'c'.repeat(64);}],
  ['different core revision',x=>{x.inspect.Config.Labels['org.opencontainers.image.revision']='d'.repeat(40);}],
  ['capture enabled',x=>{x.inspect.Config.Env=['JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=true'];}],
  ['missing admission case',x=>{x.admission.results.pop();}],
  ['failed admission',x=>{x.admission.results[1].passed=false;}],
  ['canary disclosure',x=>{x.admission.results[2].canaryDisclosed=true;}],
  ['unproven cleanup',x=>{x.cleanup[0].status='cleanup_unproven';}],
  ['old module-only proof',x=>{x.provisioned.gate='PROVISIONED_EMPTY_ENGINE_SHUTDOWN_AND_ARTIFACT_CUSTODY_VERIFIED';}],
  ['no real main recovery',x=>{x.provisioned.realHook.recoveryMainImported=false;}],
  ['missing correlated receiver persistence',x=>{x.provisioned.realHook.receiverRows=1;}],
  ['legacy effects replayed',x=>{x.provisioned.realHook.replayNativeEffects=1;}],
  ['mutated schema during startup',x=>{x.provisioned.ddlStatementLogCount=1;}],
  ['out of memory',x=>{x.provisioned.engineOOMKilled=true;}],
  ['upstream synthetic payload logged',x=>{x.provisioned.realHook.syntheticPayloadLoggedByUpstream=true;}],
  ['invalid source pid',x=>{x.provisioned.realHook.sourcePid=0;}],
  ['same source and recovery process',x=>{x.provisioned.realHook.recoveryPid=101;}],
  ['recovery process already dead',x=>{x.provisioned.realHook.terminationObservations[1].alreadyExited=true;}],
  ['source pid differs from crash evidence',x=>{x.provisioned.realHook.terminationObservations[0].pid=303;}],
  ['normal exit mislabeled as source crash',x=>{x.provisioned.realHook.terminationObservations[0].signalCode=null;}],
  ['missing recovery termination observation',x=>{x.provisioned.realHook.terminationObservations.pop();}],
  ['custody test misrepresented as real session',x=>{x.provisioned.artifactCustody.actualWhatsAppSession=true;}],
  ['custody test misrepresented as engine main',x=>{x.provisioned.artifactCustody.engineMainImported=true;}],
  ['custody synthetic source omitted',x=>{delete x.provisioned.artifactCustody.syntheticSource;}],
 ])('refuses %s',async(_name,mutate)=>{const x=fixture();mutate(x);await expect(validate(x)).rejects.toThrow();});
 it('publishes by manual opt-in only, after verifying the single built image, without a rebuild',async()=>{
  const yaml=await readFile(new URL('../.github/workflows/engine-image.yml',import.meta.url),'utf8');
  expect(yaml).toContain('workflow_dispatch:');expect(yaml).toContain('default: false');
  expect(yaml.match(/docker --context desktop-linux build\s/g)).toHaveLength(1);
  expect(yaml).not.toMatch(/build-push-action|docker compose|ssh |ci:verify|restore-drill|continue-on-error/);
  const gate=yaml.indexOf('verify-engine-candidate.mjs');const push=yaml.indexOf('docker --context desktop-linux push');
  expect(gate).toBeGreaterThan(0);expect(push).toBeGreaterThan(gate);
  expect(yaml).toContain('pull_request:');
  for(const path of ['infra/evolution/**','upstream/evolution-api','.gitmodules','package.json','package-lock.json'])expect(yaml).toContain("- '"+path+"'");
  expect(yaml.slice(gate,push)).toContain("if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}");
  expect(yaml).toContain('JRC_ENGINE_REAL_HOOK_GATE: "true"');
  expect(yaml).toContain('org.opencontainers.image.revision=$GITHUB_SHA');
  expect(yaml).toContain('test "$rebuilt" = "$tested"');
 });
});
