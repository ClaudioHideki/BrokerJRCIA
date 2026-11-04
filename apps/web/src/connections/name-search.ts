/** Name-only matching: never inspect addresses, tokens, IDs or other card fields. */
export function matchesConnectionName(name:string|null|undefined,query:string){
 const normalize=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').trim();
 return normalize(name??'').includes(normalize(query));
}

/** Complete authorized cursor traversal or an explicit failure; never return a partial search. */
export async function collectNameSearchPages<T extends {id:string}>(
 fetchPage:(cursor:string|undefined,signal:AbortSignal)=>Promise<{data:readonly T[];nextCursor:string|null}>,signal:AbortSignal,
){
 const items=new Map<string,T>(),seen=new Set<string>();let cursor:string|undefined;
 for(let page=0;page<100;page++){
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  const result=await fetchPage(cursor,signal);
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  for(const item of result.data)items.set(item.id,item);
  if(result.nextCursor===null)return [...items.values()];
  if(!result.nextCursor||seen.has(result.nextCursor))throw new Error('NAME_SEARCH_PAGINATION_INVALID');
  seen.add(result.nextCursor);cursor=result.nextCursor;
 }
 throw new Error('NAME_SEARCH_INCOMPLETE');
}
