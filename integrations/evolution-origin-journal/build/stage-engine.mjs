import { cp,readFile,writeFile,mkdir,mkdtemp,readdir,lstat,realpath,rm } from 'node:fs/promises';
import { dirname,join,resolve,basename } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { preparePinnedEngineSources,ENGINE_SOURCE_HASHES } from '../src/engine-overlay.mjs';
import { PINNED_SOURCE_COMMIT } from '../src/overlay.mjs';
const own=fileURLToPath(new URL('../',import.meta.url)),vendor=fileURLToPath(new URL('../../../upstream/evolution-api/',import.meta.url)),parent=join(own,'.staging');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function inventory(directory,prefix=''){
 const result=[];
 for(const name of (await readdir(directory)).sort()){
  const path=join(directory,name),stat=await lstat(path),relative=prefix+name;
  if(stat.isSymbolicLink())throw Error('ORIGIN_ENGINE_SOURCE_SYMLINK_REFUSED');
  if(stat.isDirectory())result.push(...await inventory(path,relative+'/'));
  else if(stat.isFile())result.push({path:relative,sha256:sha(await readFile(path))});
 }
 return result;
}
export async function stagePinnedEngine(){
 const originals={};for(const path of Object.keys(ENGINE_SOURCE_HASHES))originals[path]=await readFile(join(vendor,path),'utf8');
 const prepared=preparePinnedEngineSources(originals),files=await inventory(join(vendor,'src'));
 await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'engine-'));
 try{
  await cp(join(vendor,'src'),join(directory,'src'),{recursive:true});
  const legalFiles=['LICENSE','NOTICE','TRADEMARKS.md'];
  for(const name of ['package.json','package-lock.json','tsconfig.json','tsup.config.ts',...legalFiles])await cp(join(vendor,name),join(directory,name));
  for(const [path,source]of Object.entries(prepared.sources))await writeFile(join(directory,path),source);
  const runtimeFiles=['bootstrap.mjs','dispatcher.mjs','engine-composition.mjs','engine-host.mjs','hook.mjs','http-transport.mjs','journal.mjs','projection.mjs','webhook-ownership.mjs','worker.mjs'];
  await mkdir(join(directory,'jrc-origin'),{recursive:true});
  for(const name of runtimeFiles)await cp(join(own,'src',name),join(directory,'jrc-origin',name));
  await mkdir(join(directory,'schema'),{recursive:true});
  await cp(join(own,'schema/origin-journal.sql'),join(directory,'schema/origin-journal.sql'));
  const config=JSON.parse(await readFile(join(directory,'tsconfig.json'),'utf8'));
  config.compilerOptions.paths['@jrc-origin/*']=['./jrc-origin/*'];
  await writeFile(join(directory,'tsconfig.json'),JSON.stringify(config,null,2)+'\n');
  const buildConfig=await readFile(join(directory,'tsup.config.ts'),'utf8');
  if(buildConfig.split("entry: ['src'],").length!==2)throw Error('ORIGIN_ENGINE_BUILD_CONFIG_MISMATCH');
  await writeFile(join(directory,'tsup.config.ts'),buildConfig.replace("entry: ['src'],","entry: ['src/main.ts'],"));
  const manifest={schemaVersion:1,kind:'EVOLUTION_PINNED_LAB_STAGING',sourceCommit:PINNED_SOURCE_COMMIT,deliveryOwnership:'UNPROVEN',buildEntry:'src/main.ts',sourceFileCount:files.length,
   sourceInventorySha256:sha(JSON.stringify(files)),runtimeInventorySha256:sha(JSON.stringify(await inventory(join(directory,'jrc-origin')))),lockfileSha256:sha(await readFile(join(directory,'package-lock.json'))),patches:prepared.manifest,legalFiles};
  await writeFile(join(directory,'jrc-origin-provenance.json'),JSON.stringify(manifest,null,2)+'\n');
  return {directory,manifest};
 }catch(error){await removeOwnStage(directory);throw error;}
}
export async function removeOwnStage(directory){
 const target=await realpath(directory),root=await realpath(parent);
 if(dirname(target)!==root||!/^engine-[A-Za-z0-9]+$/u.test(basename(target)))throw Error('ORIGIN_ENGINE_STAGE_DELETE_REFUSED');
 await rm(target,{recursive:true});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==2)throw Error('ORIGIN_ENGINE_STAGE_USAGE');
 console.log(JSON.stringify(await stagePinnedEngine()));
}
