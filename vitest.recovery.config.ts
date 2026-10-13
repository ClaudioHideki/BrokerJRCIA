import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
const root=dirname(fileURLToPath(import.meta.url));
export default defineConfig({root,resolve:{alias:{'@jrc/contracts':resolve(root,'packages/contracts/src/index.ts'),'@jrc/providers':resolve(root,'packages/providers/src/index.ts'),'@jrc/security':resolve(root,'packages/security/src/index.ts')}},test:{include:['apps/api/tests/recovery/*.lab.test.{ts,mjs}'],maxWorkers:1,fileParallelism:false,testTimeout:120000,hookTimeout:120000}});
