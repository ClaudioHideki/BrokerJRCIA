import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { sourceTextHash } from './source-hash.mjs';
import { buildPublicDocument, publicProfiles } from './public-api.mjs';
import { operationGuide, identityEnrollmentGuide } from './operation-guide.mjs';
import { documentationProvenance } from './provenance.mjs';
const source = await readFile(new URL('../../docs/api/openapi.json', import.meta.url));
const document = JSON.parse(source);
const destination = new URL('../../tmp/pdfs/', import.meta.url);
await mkdir(destination, {recursive:true});
await writeFile(new URL('contracts.json',destination), JSON.stringify({
  sourceHash:sourceTextHash(source),guides:operationGuide,identityEnrollmentGuide,provenance:await documentationProvenance(),
  profiles:Object.fromEntries(publicProfiles.map(p=>[p,buildPublicDocument(document,p)])),
},null,2));
