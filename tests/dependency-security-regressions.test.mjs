import fs from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parse} from '@babel/parser';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {createManualModuleSource} from '@vitest/mocker/node';
import {glob} from 'glob';
import {describe,expect,it} from 'vitest';

const require=createRequire(import.meta.url);
const parsers=[['serializer',require('fast-uri')],['ajv',createRequire(require.resolve('ajv'))('fast-uri')],
 ['schema resolver',createRequire(require.resolve('json-schema-resolver'))('fast-uri')]];

describe('upstream security regressions through installed dependencies',()=>{
 for(const [name,uri] of parsers){
  it.each(['%6Aavascript:alert(1)','%u006Aavascript:alert(1)','%64ata:text/plain,probe'])('%s remains an invalid encoded scheme in '+name,input=>{
   let parsed;
   try{parsed=uri.parse(input);}catch{return;}
   expect(['javascript','data']).not.toContain(parsed.scheme?.toLowerCase());
  });
 }
 it.each(['X-Jrc-Forbidden','x-jrc-forbidden'])('enforces a mixed-case header deny-list for %s',async header=>{
  const app=Fastify();
  app.get('/probe',{schema:{headers:{type:'object',propertyNames:{not:{enum:['X-Jrc-Forbidden']}}}}},()=>({accepted:true}));
  try{expect((await app.inject({url:'/probe',headers:{[header]:'synthetic'}})).statusCode).toBe(400);}
  finally{await app.close();}
 });
 it('serializes a manual mock URL as data instead of executable source',()=>{
  const input='\");globalThis.__jrc_dependency_probe=true;//';
  const code=createManualModuleSource(input,['default']);
  const ast=parse(code,{sourceType:'module'});
  expect(ast.program.body.some(node=>node.type==='ExpressionStatement')).toBe(false);
  const factory=ast.program.body.find(node=>node.type==='VariableDeclaration');
  const initializer=factory.declarations[0].init;
  const call=initializer.type==='AwaitExpression'?initializer.argument:initializer;
  expect(call.arguments[0].value).toBe(input);
 });
 it('stops recursive filesystem traversal after cancellation and preserves static serving compatibility',async()=>{
  const parent=resolve('.sessions/dependency-probes');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'glob-'));
  if(!directory.startsWith(parent+sep))throw Error('Unexpected fixture location');
  let app;
  try{
   for(let i=0;i<5;i++)for(let j=0;j<4;j++){
    const path=join(directory,String(i),String(j));await mkdir(path,{recursive:true});await writeFile(join(path,'file.txt'),'synthetic');
   }
   const controller=new AbortController();let reads=0;
   const controlledFs={...fs,readdir(...args){reads++;if(reads===1)controller.abort(new Error('synthetic cancellation'));return fs.readdir(...args);}};
   await expect(glob('**/*',{cwd:directory,signal:controller.signal,fs:controlledFs})).rejects.toThrow('synthetic cancellation');
   const atRejection=reads;await delay(100);expect(reads).toBe(atRejection);
   app=Fastify();await app.register(fastifyStatic,{root:directory,prefix:'/assets/',wildcard:false});
   const response=await app.inject('/assets/0/0/file.txt');expect(response.statusCode).toBe(200);expect(response.body).toBe('synthetic');
   expect((await app.inject('/assets/../../package.json')).statusCode).toBe(404);
  }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
 });
});
