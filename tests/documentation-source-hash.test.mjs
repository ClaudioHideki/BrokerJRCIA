import {expect,it} from 'vitest';
import {sourceTextHash} from '../scripts/docs/source-hash.mjs';
it('keeps the documented source digest stable across Git text checkout line endings',()=>{
  expect(sourceTextHash(Buffer.from('ação\r\nrota\r\n'))).toBe(sourceTextHash(Buffer.from('ação\nrota\n')));
  expect(sourceTextHash(Buffer.from('ação\nrota\n'))).not.toBe(sourceTextHash(Buffer.from('ação\noutra rota\n')));
});
