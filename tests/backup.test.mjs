import {Readable} from 'node:stream';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {encryptBackup,decryptBackup} from '../scripts/operations/backup.mjs';
it('restaura bytes do backup somente com chave correta e detecta adulteração',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jrc-backup-test-'));
 try{const key=Buffer.alloc(32,3).toString('base64'),source=Buffer.from('dados de teste\0binário'),encrypted=join(dir,'snapshot.jrcbak'),restored=join(dir,'restored.bin');
 await encryptBackup(Readable.from(source),encrypted,key);
 expect((await readFile(encrypted)).includes(source)).toBe(false);
 await decryptBackup(encrypted,restored,key);expect(await readFile(restored)).toEqual(source);
 await expect(decryptBackup(encrypted,join(dir,'wrong.bin'),Buffer.alloc(32,4).toString('base64'))).rejects.toThrow('BACKUP_AUTHENTICATION_FAILED');
 const bytes=await readFile(encrypted);bytes[20]^=1;await writeFile(encrypted,bytes);
 await expect(decryptBackup(encrypted,join(dir,'tampered.bin'),key)).rejects.toThrow('BACKUP_AUTHENTICATION_FAILED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
