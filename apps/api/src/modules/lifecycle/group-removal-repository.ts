import type { PoolClient } from 'pg';
import type { RequestGroupCompanyRemoval } from '@jrc/contracts';

// Only the dedicated platform/worker roles may call these narrowly scoped functions.
// The database rechecks the current actor and serializes the preview/request against group writes.
export function groupRemovalRepository(tx:Pick<PoolClient,'query'>) {
  const json=async(sql:string,parameters:unknown[])=>{
    const result=await tx.query<{value:unknown}>(sql,parameters);
    return result.rows[0]?.value;
  };
  return {
    preview:(actor:string,groupId:string,reason:string)=>json('SELECT public.group_removal_preview($1,$2,$3) AS value',[actor,groupId,reason]),
    request:(actor:string,input:RequestGroupCompanyRemoval)=>json('SELECT public.group_removal_request($1,$2::jsonb) AS value',[actor,JSON.stringify(input)]),
    get:(actor:string,id:string)=>json('SELECT public.group_removal_get($1,$2) AS value',[actor,id]),
    list:(actor:string,group:string,cursor?:string)=>json('SELECT public.group_removal_list($1,$2,$3) AS value',[actor,group,cursor??null]),
    async processOne(){return (await tx.query<{worked:boolean}>('SELECT public.group_removal_process_one() AS worked')).rows[0]?.worked===true;},
  };
}
