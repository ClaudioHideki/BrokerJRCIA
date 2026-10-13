import {readFile} from 'node:fs/promises';
import {runRecoveryOperation} from './recovery-operations.mjs';

try{
 const[mode,flag,path,...extra]=process.argv.slice(2);if(!['capture','verify','restore'].includes(mode)||flag!=='--parameters'||!path||extra.length)throw Error('RECOVERY_CLI_PARAMETERS_INVALID');
 const raw=await readFile(path,'utf8');if(raw.length>32768)throw Error('RECOVERY_CLI_PARAMETERS_INVALID');const parameters=JSON.parse(raw);
 const result=await runRecoveryOperation({mode,parameters,backupKey:process.env.JRC_BACKUP_KEY});
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stdout.write(JSON.stringify({scope:'ISOLATED_NAMESPACE',passed:false,error:/^RECOVERY_[A-Z_]+$/.test(e?.message??'')?e.message:'RECOVERY_CLI_FAILED'})+'\n');process.exitCode=1;}
