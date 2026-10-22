import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildPublicDocument, publicProfiles } from './public-api.mjs';
import { operationGuide } from './operation-guide.mjs';
const source = await readFile(new URL('../../docs/api/openapi.json', import.meta.url));
const document = JSON.parse(source);
const destination = new URL('../../tmp/pdfs/', import.meta.url);
await mkdir(destination, {recursive:true});
await writeFile(new URL('contracts.json',destination), JSON.stringify({
  sourceHash:createHash('sha256').update(source).digest('hex'),guides:operationGuide,
  profiles:Object.fromEntries(publicProfiles.map(p=>[p,buildPublicDocument(document,p)])),
},null,2));
