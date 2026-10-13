import {describe,it,expect} from 'vitest';
import {AiNodeConfigSchema,AiCredentialPolicySchema,validateAiOutput,estimateAiCost,maximumAiCost} from '../src/automation-ai.js';
const common={aiConfigVersion:1,credentialId:'11111111-1111-4111-8111-111111111111',credentialRevision:2,model:'approved-model',content:'{{message}}',target:'ai.result',timeoutMs:15000,maxOutputTokens:256,maxResponseBytes:32768,maxCostMicros:100000};
const model={name:'approved-model',inputMicrosPerMillion:1000000,outputMicrosPerMillion:2000000};
describe('bounded AI contracts',()=>{
 it('requires an explicit operation, active revision and bounded controls without secrets, tools or URLs',()=>{
  for(const operation of ['generate','summarize'])expect(AiNodeConfigSchema.safeParse({...common,operation}).success).toBe(true);
  for(const extra of [{tools:[]},{baseUrl:'https://example.test'},{apiKey:'private'},{credentialRevision:0},{aiConfigVersion:2},{maxOutputTokens:0},{timeoutMs:30001},{maxResponseBytes:65537},{content:'x'.repeat(32769)}])expect(AiNodeConfigSchema.safeParse({...common,operation:'generate',...extra}).success).toBe(false);
 });
 it('classifies only into explicit unique categories and rejects unobserved output',()=>{
  const node=AiNodeConfigSchema.parse({...common,operation:'classify',categories:['Comercial','Suporte']});
  expect(validateAiOutput(node,'Suporte')).toBe('Suporte');expect(()=>validateAiOutput(node,'Financeiro')).toThrow('AUTOMATION_AI_OUTPUT_INVALID');
  expect(AiNodeConfigSchema.safeParse({...node,categories:['Suporte','Suporte']}).success).toBe(false);
 });
 it('extracts typed fields without arbitrary schema, unknown keys or prototype paths',()=>{
  const node=AiNodeConfigSchema.parse({...common,operation:'extract',fields:[{name:'nome',type:'string'},{name:'ativo',type:'boolean'},{name:'idade',type:'number'}]});
  expect(validateAiOutput(node,{nome:'Ana',ativo:true,idade:20})).toEqual({nome:'Ana',ativo:true,idade:20});
  for(const output of [{nome:'Ana',ativo:'true',idade:20},{nome:'Ana',ativo:true,idade:20,other:1},{nome:'Ana',ativo:true,idade:Infinity}])expect(()=>validateAiOutput(node,output)).toThrow('AUTOMATION_AI_OUTPUT_INVALID');
  expect(AiNodeConfigSchema.safeParse({...node,fields:[{name:'__proto__',type:'string'}]}).success).toBe(false);
 });
 it('bounds input and output by UTF8 bytes, not character count',()=>{
  expect(AiNodeConfigSchema.safeParse({...common,operation:'generate',content:'é'.repeat(17000)}).success).toBe(false);
  const node=AiNodeConfigSchema.parse({...common,operation:'generate',maxResponseBytes:1024});
  expect(()=>validateAiOutput(node,'é'.repeat(513))).toThrow('AUTOMATION_AI_OUTPUT_LIMIT');
 });
 it('computes rounded configured cost without arithmetic overflow or unverifiable usage',()=>{
  expect(estimateAiCost(model,{inputTokens:1,outputTokens:1})).toBe(3);
  expect(estimateAiCost({...model,inputMicrosPerMillion:1,outputMicrosPerMillion:1},{inputTokens:1,outputTokens:0})).toBe(1);
  expect(()=>estimateAiCost(model,{inputTokens:-1,outputTokens:2})).toThrow('AUTOMATION_AI_USAGE_INVALID');
  expect(()=>estimateAiCost({...model,inputMicrosPerMillion:Number.MAX_SAFE_INTEGER},{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:2})).toThrow('AUTOMATION_AI_COST_OVERFLOW');
  expect(maximumAiCost(AiNodeConfigSchema.parse({...common,operation:'generate'}),model)).toBeGreaterThan(512);
 });
 it('requires administrator-approved unique models and a finite monthly allowance',()=>{
  expect(AiCredentialPolicySchema.safeParse({models:[model],monthlyCostMicros:1000000}).success).toBe(true);
  for(const policy of [{models:[model,model],monthlyCostMicros:1000000},{models:[model],monthlyCostMicros:0},{models:[{...model,inputMicrosPerMillion:-1}],monthlyCostMicros:1000000}])expect(AiCredentialPolicySchema.safeParse(policy).success).toBe(false);
 });
});
