import {Client} from 'pg';import {pathToFileURL} from 'node:url';
import {registerEvolutionEngines} from '../modules/evolution-fleet/registration.js';
export async function runEvolutionFleetRegistration(environment:NodeJS.ProcessEnv=process.env,firstRegistration=false){
 const connectionString=environment.MIGRATION_DATABASE_URL;
 if(!connectionString)throw new Error('EVOLUTION_ENGINE_MAINTENANCE_DATABASE_REQUIRED');
 const client=new Client({connectionString});
 try{await client.connect();await client.query('BEGIN');
  if((await client.query("SELECT pg_has_role(current_user,'jrc_migrator','SET') AS allowed")).rows[0]?.allowed!==true)throw new Error('EVOLUTION_ENGINE_MAINTENANCE_ROLE_REQUIRED');
  await client.query('SET LOCAL ROLE jrc_migrator');
  const identity=(await client.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  if(identity?.current_user!=='jrc_migrator'||identity.rolsuper||identity.rolbypassrls)throw new Error('EVOLUTION_ENGINE_MAINTENANCE_ROLE_REQUIRED');
  const entries=await registerEvolutionEngines(environment,client,firstRegistration);await client.query('COMMIT');return entries;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 runEvolutionFleetRegistration(process.env,process.argv.includes('--first-registration')).then(entries=>process.stdout.write(JSON.stringify({registered:entries})+'\n')).catch(()=>{process.stderr.write('EVOLUTION_ENGINE_REGISTRATION_FAILED\n');process.exitCode=1;});
}
