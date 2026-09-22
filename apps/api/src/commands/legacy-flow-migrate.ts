import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import { createLegacyFlowMigrationService } from '../modules/automations/legacy-migration.js';

export async function runLegacyFlowMigration(environment:NodeJS.ProcessEnv=process.env){const databaseUrl=z.string().url().parse(environment.DATABASE_URL);if(new URL(databaseUrl).username!=='jrc_app')throw new Error('LEGACY_MIGRATION_REQUIRES_APP_ROLE');const pool=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000,statement_timeout:120000}),service=createLegacyFlowMigrationService({transact:<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,org,work)});try{const organizations=(await pool.query<{organization_id:string}>('select * from legacy_flow_migration_organizations(null,1000)')).rows;for(const row of organizations){const report=await service.migrateBatch(row.organization_id,{limit:200});process.stdout.write(JSON.stringify({event:'LEGACY_FLOW_MIGRATION_BATCH',...report})+'\n');}}finally{await pool.end();}}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)runLegacyFlowMigration().catch(error=>{process.stderr.write(JSON.stringify({event:'LEGACY_FLOW_MIGRATION_FAILED',code:error instanceof Error?error.message:'UNKNOWN'})+'\n');process.exitCode=1;});
