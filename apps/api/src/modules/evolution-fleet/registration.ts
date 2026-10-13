import {loadEvolutionFleet} from './config.js';
import type {PoolClient} from 'pg';
/** SQL is parameterized, environment endpoints and secrets never reach SQL or
 * operator stdout. Role is the same maintenance profile used by migrations. */
export async function registerEvolutionEngines(environment:NodeJS.ProcessEnv,client:Pick<PoolClient,'query'>,firstRegistration:boolean){
 const fleet=loadEvolutionFleet(environment);
 const entries=[...fleet.values()].map(e=>({...e.metadata(),state:e.state,operationBudget:e.operationBudget}));
 const result=await client.query<{registered:number}>('SELECT public.evolution_register_engines($1::jsonb,$2) AS registered',[JSON.stringify(entries),firstRegistration]);
 if(result.rows[0]?.registered!==entries.length)throw new Error('EVOLUTION_ENGINE_REGISTRATION_FAILED');
 return entries;
}
