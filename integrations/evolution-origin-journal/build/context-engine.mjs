import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stagePinnedEngine } from './stage-engine.mjs';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw Error('ORIGIN_ENGINE_CONTEXT_USAGE');
  console.log(JSON.stringify(await stagePinnedEngine({ imageContext: true })));
}
