import {describe,expect,it} from 'vitest';
import * as contracts from '../src/index.js';
import type {z} from 'zod';

const organizationId='11111111-1111-4111-8111-111111111111';
const rootAutomationId='22222222-2222-4222-8222-222222222222';
const automationId='33333333-3333-4333-8333-333333333333';
const entry={automationId,name:'Triagem publicada',version:7,checksum:'a'.repeat(64),runtimeStateVersion:2};
const page={schemaVersion:1,scope:{organizationId,rootAutomationId},data:[entry],nextCursor:null};
const schema=()=>{
 const value=(contracts as unknown as Record<string,z.ZodType>).AutomationSubflowCatalogPageSchema;
 expect(value,'O catálogo publicado deve ter um contrato próprio de metadados').toBeDefined();
 return value!;
};

describe('published subflow catalog contract',()=>{
 it('keeps the exact supplied version and tenant/root scope without exposing the graph',()=>{
  expect(schema().parse(page)).toEqual(page);
  expect(schema().safeParse({...page,data:[{...entry,graph:{nodes:[],edges:[]}}]}).success).toBe(false);
  expect(schema().safeParse({...page,credential:'secret'}).success).toBe(false);
 });
 it('rejects invalid immutable references rather than inventing version one',()=>{
  for(const change of [{version:null},{version:0},{version:1.5},{runtimeStateVersion:1},{automationId:'unknown'},{checksum:'not-a-checksum'},{automationId:rootAutomationId}])
   expect(schema().safeParse({...page,data:[{...entry,...change}]}).success).toBe(false);
  expect(schema().safeParse({...page,data:[entry,entry]}).success).toBe(false);
 });
 it('allows full pages with a continuation and never accepts an oversized page',()=>{
  const rows=Array.from({length:200},(_,at)=>({...entry,version:at+1}));
  expect(schema().safeParse({...page,data:rows,nextCursor:'cursor_2'}).success).toBe(true);
  expect(schema().safeParse({...page,data:[...rows,{...entry,version:201}]}).success).toBe(false);
  expect(schema().safeParse({...page,nextCursor:''}).success).toBe(false);
 });
});
