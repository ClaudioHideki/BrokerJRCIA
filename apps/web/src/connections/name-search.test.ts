import {expect,it,vi} from 'vitest';
import {collectNameSearchPages,matchesConnectionName} from './name-search.js';
it('matches only names without case, accents or surrounding spaces',()=>{
 expect(matchesConnectionName('Comércio São José','  COMERCIO sao ')).toBe(true);
 expect(matchesConnectionName(null,'caixa')).toBe(false);expect(matchesConnectionName('Suporte','')).toBe(true);
});
it('walks complete cursor pages in series and deduplicates overlap',async()=>{
 const fetch=vi.fn(async(cursor:string|undefined)=>cursor?{data:[{id:'a',name:'atual'},{id:'b',name:'outra'}],nextCursor:null}:{data:[{id:'a',name:'antes'}],nextCursor:'opaque'});
 expect(await collectNameSearchPages(fetch,new AbortController().signal)).toEqual([{id:'a',name:'atual'},{id:'b',name:'outra'}]);
 expect(fetch.mock.calls.map(([cursor])=>cursor)).toEqual([undefined,'opaque']);
});
it('fails closed on a repeated cursor instead of looping or returning partial matches',async()=>{
 const fetch=vi.fn(async()=>({data:[{id:'a'}],nextCursor:'same'}));
 await expect(collectNameSearchPages(fetch,new AbortController().signal)).rejects.toThrow('NAME_SEARCH_PAGINATION_INVALID');expect(fetch).toHaveBeenCalledTimes(2);
});
it('bounds the traversal and reports incomplete instead of returning an empty result',async()=>{
 let page=0;const fetch=vi.fn(async()=>({data:[],nextCursor:String(++page)}));
 await expect(collectNameSearchPages(fetch,new AbortController().signal)).rejects.toThrow('NAME_SEARCH_INCOMPLETE');expect(fetch).toHaveBeenCalledTimes(100);
});
it('discards even the last page after abort and never starts another request',async()=>{
 const controller=new AbortController();const fetch=vi.fn(async(_cursor:string|undefined,signal:AbortSignal)=>{expect(signal).toBe(controller.signal);controller.abort();return {data:[{id:'old'}],nextCursor:null};});
 await expect(collectNameSearchPages(fetch,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(fetch).toHaveBeenCalledTimes(1);
});
