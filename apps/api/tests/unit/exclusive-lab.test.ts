import {expect,it} from 'vitest';
import {requireExclusiveLab} from '../integration/helpers/exclusive-lab.js';

it.each([
 'postgres://lab_admin@127.0.0.1/lab_admin?host=outside.invalid&user=postgres',
 'postgres://lab_admin@127.0.0.1/lab_admin?%68ost=outside.invalid',
 'postgres://lab_admin@127.0.0.1/lab_admin?sslmode=disable',
 'postgres://lab_admin@127.0.0.1/lab_admin#fragment',
 'postgres://lab_admin@outside.invalid/lab_admin',
 'postgres://postgres@127.0.0.1/lab_admin',
 'postgres://lab_admin@127.0.0.1/postgres',
 'https://lab_admin@127.0.0.1/lab_admin',
])('rejects unsafe lab URL without connecting: %s',raw=>{
 expect(()=>requireExclusiveLab(raw,'1','SYNTHETIC')).toThrow('SYNTHETIC_REQUIRES_LOOPBACK_LAB_ADMIN');
});
it.each(['postgres://lab_admin:synthetic@127.0.0.1:55432/lab_cluster','postgresql://lab_admin@[::1]/lab_cluster'])('accepts explicit loopback lab URL: %s',raw=>{
 expect(()=>requireExclusiveLab(raw,'1','SYNTHETIC')).not.toThrow();
});
it.each([[undefined,'1'],['postgres://lab_admin@127.0.0.1/lab_admin',undefined]])('requires explicit URL and exclusive assertion',(raw,exclusive)=>{
 expect(()=>requireExclusiveLab(raw,exclusive,'SYNTHETIC')).toThrow('SYNTHETIC_REQUIRES_EXPLICIT_EXCLUSIVE_LAB_CLUSTER');
});
