import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

export const MINIO_FIXTURE=Object.freeze({release:'RELEASE.2025-09-07T16-13-09Z',
 sha256:'7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f',size:110989496,
 url:'https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z'});
const digest=value=>createHash('sha256').update(value).digest('hex');
export function verifyFixtureDigest(bytes){if(digest(bytes)!==MINIO_FIXTURE.sha256)throw Error('STORAGE_TEST_BINARY_HASH_MISMATCH');}
export function createStorageTestEnvironment(endpoint){
 return {TEST_STORAGE_ENDPOINT:endpoint,TEST_STORAGE_BUCKET:'broker-storage-'+randomUUID(),TEST_STORAGE_PROFILE:'broker-storage-tests',TEST_STORAGE_REGION:'us-east-1',
  TEST_STORAGE_ACCESS_KEY_ID:'broker-'+randomBytes(12).toString('hex'),TEST_STORAGE_SECRET_ACCESS_KEY:randomBytes(32).toString('hex'),
  TEST_STORAGE_SERVER_RELEASE:MINIO_FIXTURE.release,TEST_STORAGE_BINARY_SHA256:MINIO_FIXTURE.sha256};
}
async function unusedPort(){
 const server=createServer();await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
 const port=server.address().port;await new Promise((done,fail)=>server.close(error=>error?fail(error):done()));return port;
}
export async function downloadVerifiedFixture(destination,fetcher=fetch){
 const response=await fetcher(MINIO_FIXTURE.url,{method:'GET',signal:AbortSignal.timeout(120000),redirect:'follow'});
 if(!response.ok||!response.body)throw Error('STORAGE_TEST_BINARY_DOWNLOAD_FAILED');
 if(response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==MINIO_FIXTURE.size){await response.body.cancel();throw Error('STORAGE_TEST_BINARY_SIZE_MISMATCH');}
 const file=await open(destination,'wx',0o700),hash=createHash('sha256');let total=0;
 try{
  for await(const chunk of response.body){total+=chunk.byteLength;if(total>MINIO_FIXTURE.size)throw Error('STORAGE_TEST_BINARY_SIZE_MISMATCH');hash.update(chunk);await file.writeFile(chunk);}
 }finally{await file.close();}
 if(total!==MINIO_FIXTURE.size)throw Error('STORAGE_TEST_BINARY_SIZE_MISMATCH');
 if(hash.digest('hex')!==MINIO_FIXTURE.sha256)throw Error('STORAGE_TEST_BINARY_HASH_MISMATCH');await chmod(destination,0o700);
}
async function waitForMinio(context){
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  if(context.exited||context.startFailure)throw Error('STORAGE_TEST_SERVER_START_FAILED');
  try{const response=await fetch(context.env.TEST_STORAGE_ENDPOINT+'/minio/health/ready',{signal:AbortSignal.timeout(1000)});await response.body?.cancel();if(response.ok)return;}catch{}
  await delay(250);
 }
 throw Error('STORAGE_TEST_SERVER_NOT_READY');
}
async function createPrivateBucket(context){
 const env=context.env,url=new URL('/'+env.TEST_STORAGE_BUCKET,env.TEST_STORAGE_ENDPOINT),date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),payloadHash=digest('');
 const scope=`${day}/${env.TEST_STORAGE_REGION}/s3/aws4_request`,headers=`host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`,signed='host;x-amz-content-sha256;x-amz-date';
 const canonical=['PUT',url.pathname,'',headers,signed,payloadHash].join('\n'),hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
 const key=hmac(hmac(hmac(hmac('AWS4'+env.TEST_STORAGE_SECRET_ACCESS_KEY,day),env.TEST_STORAGE_REGION),'s3'),'aws4_request');
 const signature=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',date,scope,digest(canonical)].join('\n')).digest('hex');
 const response=await fetch(url,{method:'PUT',signal:AbortSignal.timeout(5000),headers:{'x-amz-date':date,'x-amz-content-sha256':payloadHash,
  authorization:`AWS4-HMAC-SHA256 Credential=${env.TEST_STORAGE_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}`}});
 await response.body?.cancel();if(response.status!==200)throw Error('STORAGE_TEST_BUCKET_CREATE_FAILED');
 // Fresh bucket: no policy, ACL grant, versioning or object lock is configured.
 // The real adapter independently validates all four before conditional PUT.
}
async function stopAndClean(context){
 if(context.child&&!context.exited){
  context.child.kill('SIGTERM');for(let i=0;i<50&&!context.exited;i++)await delay(100);
  if(!context.exited){context.child.kill('SIGKILL');for(let i=0;i<50&&!context.exited;i++)await delay(100);}
  if(!context.exited)throw Error('STORAGE_TEST_SERVER_CLEANUP_FAILED');
 }
 const within=relative(tmpdir(),context.folder);if(!within||within.startsWith('..')||isAbsolute(within)||!within.startsWith('jrc-storage-gate-'))throw Error('STORAGE_TEST_UNSAFE_TMP_CLEANUP');
 await rm(context.folder,{recursive:true,force:true});
}
function realPorts(){
 const repo=fileURLToPath(new URL('../../',import.meta.url));
 return {
  async initialize(){
   if(process.platform!=='linux'||process.arch!=='x64')throw Error('STORAGE_TEST_CI_REQUIRES_LINUX_AMD64');
   if(!process.env.TEST_DATABASE_ADMIN_URL)throw Error('STORAGE_TEST_DATABASE_ADMIN_URL_REQUIRED');
   const port=await unusedPort(),folder=await mkdtemp(join(tmpdir(),'jrc-storage-gate-'));return {folder,binary:join(folder,'minio'),env:createStorageTestEnvironment('http://127.0.0.1:'+port),port,child:undefined,exited:false,startFailure:false};
  },
  async download(context){await downloadVerifiedFixture(context.binary);},
  async version(context){const result=spawnSync(context.binary,['--version'],{encoding:'utf8',timeout:10000,windowsHide:true});
   if(result.error||result.status!==0||!result.stdout.includes('minio version '+MINIO_FIXTURE.release)||!result.stdout.includes('linux/amd64'))throw Error('STORAGE_TEST_BINARY_VERSION_MISMATCH');},
  async start(context){context.child=spawn(context.binary,['server','--address','127.0.0.1:'+context.port,'--console-address','127.0.0.1:0',join(context.folder,'data')],
   {windowsHide:true,stdio:'ignore',env:{...process.env,MINIO_ROOT_USER:context.env.TEST_STORAGE_ACCESS_KEY_ID,MINIO_ROOT_PASSWORD:context.env.TEST_STORAGE_SECRET_ACCESS_KEY,MINIO_BROWSER:'off'}});
   context.child.once('error',()=>{context.startFailure=true;context.exited=true;});context.child.once('exit',()=>{context.exited=true;});},
  ready:waitForMinio,bucket:createPrivateBucket,
  async tests(context){
   const child=spawn('npm',['run','test:storage'],{cwd:repo,windowsHide:true,stdio:'inherit',env:{...process.env,...context.env}});
   await new Promise((done,fail)=>{child.once('error',()=>fail(Error('STORAGE_TEST_SUITE_START_FAILED')));child.once('exit',code=>code===0?done():fail(Error('STORAGE_TEST_SUITE_FAILED')));});
  },cleanup:stopAndClean,
 };
}
export async function runStorageGate(ports=realPorts()){
 const context=await ports.initialize();try{await ports.download(context);await ports.version(context);await ports.start(context);await ports.ready(context);await ports.bucket(context);await ports.tests(context);}
 finally{await ports.cleanup(context);}
}
const entrypoint=process.argv[1];
if(entrypoint&&pathToFileURL(resolve(entrypoint)).href===import.meta.url){
 try{await runStorageGate();process.stdout.write('STORAGE_TEST_GATE_PASSED\n');}
 catch(error){const code=error instanceof Error&&/^STORAGE_TEST_[A-Z0-9_]+$/.test(error.message)?error.message:'STORAGE_TEST_GATE_FAILED';process.stderr.write(code+'\n');process.exitCode=1;}
}
