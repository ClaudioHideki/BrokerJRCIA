import {describe,expect,it} from 'vitest';
import {AutomationGraphV1Schema} from '../src/automations-v1.js';
const graph=(data:Record<string,unknown>)=>({nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data},{id:'end',type:'end',label:'Fim',position:{x:200,y:0},data:{}}],edges:[{id:'e',source:'start',target:'end',port:'next'}]});
describe('AutomationGraphV1 secret boundary',()=>{it.each(['token','authorization','apiKey','password','privateKey','connectionString'])('rejects inline secret field %s',field=>expect(AutomationGraphV1Schema.safeParse(graph({[field]:'must-not-leak'})).success).toBe(false));it('allows an opaque credential reference',()=>expect(AutomationGraphV1Schema.safeParse(graph({credentialId:'11111111-1111-4111-8111-111111111111'})).success).toBe(true));});
