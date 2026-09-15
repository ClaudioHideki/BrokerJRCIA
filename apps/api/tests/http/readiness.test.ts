import {expect,it} from 'vitest';
import {buildApp} from '../../src/app.js';
it('sinaliza indisponibilidade das dependências sem expor detalhes ou derrubar liveness',async()=>{
 const app=buildApp({nodeEnv:'test',readinessCheck:async()=>{throw new Error('postgres-private-password');}});
 try{const ready=await app.inject('/ready');expect(ready.statusCode).toBe(503);expect(ready.body).not.toContain('postgres-private-password');expect((await app.inject('/health')).statusCode).toBe(200);}finally{await app.close();}
});
