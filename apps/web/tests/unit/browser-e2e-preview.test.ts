import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {startE2ePreview} from '../e2e/preview.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.reverse())await cleanup();cleanups.length=0;});
async function listen(server:Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return (server.address() as {port:number}).port;}
async function close(server:Server){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
async function directory(built=true){const root=await mkdtemp(join(tmpdir(),'broker-preview-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));if(built){await mkdir(join(root,'dist'));await writeFile(join(root,'dist','index.html'),'<h1>Built synthetic fixture</h1>');}return root;}
it('serves the built artifact and local API proxy, then releases its owned listener',async()=>{
 const api=createServer((_req,res)=>res.end('synthetic-api')),apiPort=await listen(api);cleanups.push(()=>close(api));
 const probe=createServer();const port=await listen(probe);await close(probe);
 const server=await startE2ePreview({root:await directory(),port,apiOrigin:`http://127.0.0.1:${apiPort}`});cleanups.push(()=>server.close());
 expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('Built synthetic fixture');
 expect(await (await fetch(`http://127.0.0.1:${port}/v1/probe`)).text()).toBe('synthetic-api');
 await server.close();
 const replacement=createServer();await new Promise<void>((resolve,reject)=>{replacement.once('error',reject);replacement.listen(port,'127.0.0.1',resolve);});await close(replacement);
});
it('fails on an occupied port without reusing or terminating the other server',async()=>{
 const foreign=createServer((_req,res)=>res.end('untouched')),port=await listen(foreign);cleanups.push(()=>close(foreign));
 await expect(startE2ePreview({root:await directory(),port,apiOrigin:'http://127.0.0.1:3310'})).rejects.toThrow(/already in use/i);
 expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('untouched');
});
it('rejects a missing bundle instead of starting a development server',async()=>{
 await expect(startE2ePreview({root:await directory(false),port:4173,apiOrigin:'http://127.0.0.1:3310'})).rejects.toThrow('Built E2E index.html is required');
});
