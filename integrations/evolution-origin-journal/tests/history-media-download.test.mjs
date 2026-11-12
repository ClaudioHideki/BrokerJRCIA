import assert from 'node:assert/strict';
import { createCipheriv,createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createBaileysHistoryMediaDownloader } from '../src/history-media-download.mjs';

const bytes=Buffer.from('synthetic encrypted WhatsApp media'),cipherKey=Buffer.alloc(32,39),iv=Buffer.alloc(16,43),macKey=Buffer.alloc(32,47);
const cipher=createCipheriv('aes-256-cbc',cipherKey,iv),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
const body=Buffer.concat([encrypted,createHmac('sha256',macKey).update(iv).update(encrypted).digest().subarray(0,10)]);
const descriptor={mediaType:'IMAGE',directPath:'/v/synthetic.enc',mediaKey:Buffer.alloc(32,31).toString('base64')};
const collect=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);};
const keys=async(value,type)=>{assert.deepEqual(value,Buffer.alloc(32,31));assert.equal(type,'image');return {cipherKey,iv,macKey};};

test('physical HTTP transfer applies abort/redirect controls, authenticates ciphertext and decrypts before custody',async()=>{
  let fetched=0,closed=false;
  const server=createServer((request,response)=>{
    fetched++;
    if(request.url==='/redirect'){response.writeHead(307,{location:'/should-never-be-followed'});response.end();return;}
    if(request.url==='/stalled'){request.on('close',()=>{closed=true;});return;}
    response.writeHead(200,{'Content-Type':'application/octet-stream'});response.write(body.subarray(0,19));response.end(body.subarray(19));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let path='/media',observed;
  const download=createBaileysHistoryMediaDownloader({getMediaKeys:keys,fetch:async(url,options)=>{
    assert.equal(url,'https://mmg.whatsapp.net/v/synthetic.enc');observed=options;return fetch(origin+path,options);
  }});
  try {
    assert.deepEqual(await collect(await download(descriptor,{signal:new AbortController().signal})),bytes);
    assert.equal(observed.redirect,'error');assert.equal(observed.signal instanceof AbortSignal,true);
    path='/redirect';const before=fetched;
    await assert.rejects(download(descriptor,{signal:new AbortController().signal}));assert.equal(fetched,before+1);
    path='/stalled';const abort=new AbortController(),pending=download(descriptor,{signal:abort.signal});
    await new Promise(resolve=>setTimeout(resolve,30));abort.abort();await assert.rejects(pending);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,true,'the actual network request must close before retry');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('corrupt MAC, oversized ciphertext and arbitrary URLs never become recoverable plaintext',async()=>{
  const corrupt=Buffer.from(body);corrupt[corrupt.length-1]^=1;
  const download=createBaileysHistoryMediaDownloader({getMediaKeys:keys,fetch:async()=>new Response(corrupt)});
  await assert.rejects(collect(await download(descriptor,{signal:new AbortController().signal})),/INTEGRITY/u);
  const oversized=createBaileysHistoryMediaDownloader({getMediaKeys:keys,fetch:async()=>new Response(body,{headers:{'content-length':String(17*1024*1024)}})});
  await assert.rejects(oversized(descriptor,{signal:new AbortController().signal}),/LIMIT/u);
  await assert.rejects(download({...descriptor,directPath:'//attacker.invalid/private'},{signal:new AbortController().signal}));
});
