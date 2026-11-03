import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Own the listener directly: no npm/cmd descendants left behind on Windows. */
export async function startE2ePreview(options:{root:string;port:number;apiOrigin:string}):Promise<{close():Promise<void>}>{
 const index=await stat(resolve(options.root,'dist','index.html')).catch(()=>null);
 if(!index?.isFile())throw new Error('Built E2E index.html is required; run build:web first.');
 // Lazy import keeps fake-provider unit tests free from preview startup and Vite setup.
 const {preview}=await import('vite');
 const server=await preview({root:options.root,configFile:false,envFile:false,logLevel:'error',build:{outDir:'dist'},
  preview:{host:'127.0.0.1',port:options.port,strictPort:true,proxy:{'/v1':{target:options.apiOrigin,changeOrigin:false}}}});
 let closing:Promise<void>|undefined;
 return {close(){return closing??=server.close();}};
}
