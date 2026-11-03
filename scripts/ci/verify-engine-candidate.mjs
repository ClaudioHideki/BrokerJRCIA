import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,basename,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// These receipts prove isolated artifact gates, never production ownership or a real WhatsApp session.
export function verifyEngineEvidence({image,revision,inspect,admission,cleanup,provisioned}){
 assert.match(image,/^sha256:[a-f0-9]{64}$/u);assert.match(revision,/^[a-f0-9]{40}$/u);
 assert.equal(inspect.Id,image);assert.equal(inspect.Config.User,'node');
 assert.deepEqual(inspect.Config.Entrypoint,['node','jrc-image/entrypoint.mjs']);
 assert.equal(inspect.Config.Labels['org.opencontainers.image.revision'],revision);
 assert.equal(inspect.Config.Labels['com.jrc.delivery-ownership'],'UNPROVEN');
 assert.equal(inspect.Config.Labels['com.jrc.evolution-source'],'fa09d37892cdbb1d65a250155d293d92230c5b30');
 assert.deepEqual(inspect.Config.Env.filter(v=>v.startsWith('JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=')),['JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false']);
 assert.equal(admission.image,image);assert.equal(admission.ownership,'UNPROVEN');
 assert.equal(admission.realEngineBoot,false);assert.equal(admission.network,'none');
 assert.deepEqual(admission.results.map(r=>r.case).sort(),['capture_true','invalid_flag','original_image_artifact_contract','tampered_receipt']);
 for(const item of admission.results){assert.equal(item.passed,true);if(item.case!=='original_image_artifact_contract'){
  assert.equal(item.exitCode,1);assert.equal(item.canaryDisclosed,false);
 }}
 assert.ok(Array.isArray(cleanup)&&cleanup.length>0);
 assert.ok(cleanup.every(row=>['confirmed_absent','confirmed_absent_after_stop','confirmed_removed'].includes(row.status)));
 assert.equal(provisioned.image,image);assert.equal(provisioned.gate,'PROVISIONED_ENGINE_AND_REAL_HOOK_SOURCE_CRASH_VERIFIED');
 for(const key of ['capture','productionApproved','operationallyReady','engineOOMKilled','syntheticSecretDisclosed'])assert.equal(provisioned[key],false,key);
 for(const key of ['cleanupConfirmed','emptyEngineBootAndShutdownVerified','catalogUnchanged'])assert.equal(provisioned[key],true,key);
 assert.equal(provisioned.ownership,'UNPROVEN');assert.equal(provisioned.ddlStatementLogCount,0);assert.equal(provisioned.engineFinalExitCode,0);
 assert.equal(provisioned.artifactCustody.gate,'ARTIFACT_MODULES_CUSTODY_CRASH_VERIFIED');
 assert.equal(provisioned.artifactCustody.engineMainImported,false);assert.equal(provisioned.artifactCustody.syntheticSource,true);
 assert.equal(provisioned.artifactCustody.actualWhatsAppSession,false);
 assert.equal(provisioned.artifactCustody.cases.length,2);
 for(const item of provisioned.artifactCustody.cases){assert.equal(item.sigkillObserved,true);assert.equal(item.sameEventRecovered,true);assert.equal(item.replayLegacyEffects,0);}
 const hook=provisioned.realHook;assert.equal(hook.gate,'REAL_ENGINE_HOOK_AND_SOURCE_CRASH_VERIFIED');
 for(const key of ['sourceMainImported','recoveryMainImported','cleanupConfirmed'])assert.equal(hook[key],true,key);
 for(const key of ['productionCapture','actualWhatsAppSession','nativeHandlerReplaced','syntheticPayloadLoggedByUpstream'])assert.equal(hook[key],false,key);
 assert.equal(hook.productionOwnership,'UNPROVEN');assert.equal(hook.sourceExitSignal,'SIGKILL');assert.equal(hook.recoveryStopExitCode,1);
 assert.ok(Number.isSafeInteger(hook.sourcePid)&&hook.sourcePid>0);assert.ok(Number.isSafeInteger(hook.recoveryPid)&&hook.recoveryPid>0);
 assert.notEqual(hook.sourcePid,hook.recoveryPid);
 assert.deepEqual(hook.terminationObservations,[
  {pid:hook.sourcePid,requestedSignal:'SIGKILL',alreadyExited:false,exitCode:null,signalCode:'SIGKILL'},
  {pid:hook.recoveryPid,requestedSignal:'SIGTERM',alreadyExited:false,exitCode:1,signalCode:null}]);
 for(const [key,value]of Object.entries({journalEvents:2,receiverRows:2,nativeMessages:1,unownedLegacyRequests:1,ownedDispatcherRequests:2,replayNativeEffects:0}))assert.equal(hook[key],value,key);
 return {schemaVersion:1,image,revision,publishableCandidate:true,productionCaptureApproved:false,realSessionHomologated:false,
  proof:'ISOLATED_PINNED_ARTIFACT_AND_REAL_HANDLER_WITH_SYNTHETIC_SOCKET',deliveryOwnership:'UNPROVEN'};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),values={};
 assert.equal(args.length,10,'Expected image, revision, admission, provisioned and output arguments');
 for(let i=0;i<args.length;i+=2){assert.ok(['--image','--revision','--admission','--provisioned','--output'].includes(args[i]));assert.ok(!Object.hasOwn(values,args[i]));values[args[i]]=args[i+1];}
 const read=async path=>JSON.parse(await readFile(path,'utf8'));
 const admission=await read(values['--admission']),provisioned=await read(values['--provisioned']);
 const buildRoot=await realpath(resolve('integrations/evolution-origin-journal/build'));
 const directory=await realpath(admission.evidenceDirectory);
 assert.equal(dirname(directory),buildRoot);assert.match(basename(directory),/^image-gates-[a-f0-9]{10}$/u);
 const binary=process.env.JRC_ENGINE_DOCKER_EXECUTABLE||'docker';
 const inspect=JSON.parse(execFileSync(binary,['--context','desktop-linux','image','inspect','--format','{{json .}}',values['--image']],{encoding:'utf8'}));
 const report=verifyEngineEvidence({image:values['--image'],revision:values['--revision'],inspect,admission,
  cleanup:await read(join(directory,'cleanup.log')),provisioned});
 await writeFile(values['--output'],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}
