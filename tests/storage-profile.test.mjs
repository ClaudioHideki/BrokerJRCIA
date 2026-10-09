import {readFile} from 'node:fs/promises';
import {matchesGlob} from 'node:path';
import {expect,it} from 'vitest';
import integration from '../vitest.integration.config.ts';
import storage from '../vitest.storage.config.ts';
import unit from '../vitest.config.ts';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
it('discovers the external storage suite only in the explicit profile, never PG/Redis or ordinary units',()=>{
 const file='apps/api/tests/storage/private-media-minio.test.ts';
 expect(integration.test.include.some(glob=>matchesGlob(file,glob))).toBe(false);
 expect(unit.test.include.some(glob=>matchesGlob(file,glob))).toBe(false);
 expect(storage.test.include).toEqual(['apps/api/tests/storage/**/*.test.ts']);
 expect(storage.test.include.some(glob=>matchesGlob(file,glob))).toBe(true);
 expect(storage.test.maxWorkers).toBe(1);expect(storage.test.fileParallelism).toBe(false);
});
it('requires explicit storage environment in a clean checkout and a separate runner command',async()=>{
 const source=await read('apps/api/tests/storage/private-media-minio.test.ts'),pkg=JSON.parse(await read('package.json'));
 expect(source).toContain('requireStorageEnvironment');expect(source).not.toContain('.sessions/');expect(source).not.toContain('19104');expect(source).not.toMatch(/it\.skip|describe\.skip/);
 expect(pkg.scripts['test:storage']).toBe('vitest run --config vitest.storage.config.ts');expect(pkg.scripts['test:storage:ci']).toBe('node scripts/ci/storage-minio.mjs');
 expect(pkg.scripts['ci:verify']).toContain('npm run test:storage:ci &&');
});
it.each([['.github/workflows/ci.yml','Build the immutable'],['.github/workflows/images.yml','Prepare BuildKit']])('requires the actual storage gate before builds in %s',async(path,before)=>{
 const source=await read(path),gate=source.indexOf('run: npm run test:storage:ci');expect(gate).toBeGreaterThan(-1);expect(gate).toBeLessThan(source.indexOf(before));
 expect(source.slice(source.lastIndexOf('      - name:',gate),source.indexOf('      - name:',gate))).not.toMatch(/if:|continue-on-error/);
});
