import {expect,it} from 'vitest';
import {buildApp} from '../../src/app.js';
it('sinaliza indisponibilidade com correlação sem expor detalhes ou derrubar liveness',async()=>{
 const app=buildApp({nodeEnv:'test',readinessCheck:async()=>{throw new Error('postgres-private-password');}});
 try{const ready=await app.inject({url:'/ready',headers:{'x-request-id':'2cbb143f-7ee3-448b-8041-9be6bcb94aac'}});expect(ready.statusCode).toBe(503);expect(ready.body).not.toContain('postgres-private-password');expect(ready.json()).toMatchObject({requestId:'2cbb143f-7ee3-448b-8041-9be6bcb94aac',correlationId:'2cbb143f-7ee3-448b-8041-9be6bcb94aac'});expect((await app.inject('/health')).statusCode).toBe(200);}finally{await app.close();}
});
