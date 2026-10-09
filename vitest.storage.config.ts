import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
const rootDirectory=dirname(fileURLToPath(import.meta.url));
export default defineConfig({root:rootDirectory,resolve:{alias:{'@jrc/contracts':resolve(rootDirectory,'packages/contracts/src/index.ts'),'@jrc/providers':resolve(rootDirectory,'packages/providers/src/index.ts'),'@jrc/security':resolve(rootDirectory,'packages/security/src/index.ts')}},
 test:{include:['apps/api/tests/storage/**/*.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:120000,hookTimeout:120000}});
