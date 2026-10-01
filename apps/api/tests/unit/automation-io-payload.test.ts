import { describe, expect, it } from 'vitest';
import { automationCodeInput, renderAutomationIoPayload } from '../../src/modules/automations/io-payload.js';

describe('versioned IO payload rendering', () => {
  it('renders textual IO fields as JSON text without losing typed references',()=>{
    const result=renderAutomationIoPayload({runtimeStateVersion:2,variables:{result:{balance:12},enabled:false,count:3},
      content:'{{result}}',query:'{{count}}',headers:{'x-enabled':'{{enabled}}'},body:'{{result}}'});
    expect(result.content).toBe('{"balance":12}');
    expect(result.query).toBe('3');
    expect(result.headers).toEqual({'x-enabled':'false'});
    expect(result.body).toEqual({balance:12});
  });
  it('preserves null Code input while using variables only when input is absent',()=>{
    const variables={value:null,private:'not-input'};
    const result=renderAutomationIoPayload({runtimeStateVersion:2,variables,input:'{{value}}'});
    expect(automationCodeInput(result)).toBeNull();
    expect(automationCodeInput({variables})).toEqual(variables);
    expect(automationCodeInput({variables,input:false})).toBe(false);
  });
  it('keeps referenced header values as data without evaluating a second template',()=>{
    const headers={'x-note':'{{private}}','x-count':3};
    const result=renderAutomationIoPayload({runtimeStateVersion:2,variables:{headers,private:'secret'},headers:'{{headers}}'});
    expect(result.headers).toEqual({'x-note':'{{private}}','x-count':'3'});
  });
  it('passes a typed object, list and boolean to request input without stringifying', () => {
    const variables = { result: { count: 3 }, rows: [1, 2], enabled: false, reference: '0012' };
    const rendered = renderAutomationIoPayload({ runtimeStateVersion: 2, variables,
      body: { customer: '{{result}}', rows: '{{rows}}', enabled: '{{enabled}}', reference: '{{reference}}' },
      url: 'https://example.test/{{reference}}' });
    expect(rendered.body).toEqual({ customer: { count: 3 }, rows: [1, 2], enabled: false, reference: '0012' });
    expect(rendered.url).toBe('https://example.test/0012');
  });
  it('does not recursively interpret templates contained in customer variable values', () => {
    const variables = { message: '{{secret}}', secret: 'sensitive' };
    const result = renderAutomationIoPayload({ runtimeStateVersion: 2, variables, content: '{{message}}' });
    expect(result.content).toBe('{{secret}}');
    expect(result.variables).toEqual(variables);
  });
  it('retains the historical string substitutions for a persisted legacy effect', () => {
    expect(renderAutomationIoPayload({ variables: { count: '3' }, body: { count: '{{count}}' } }).body).toEqual({ count: '3' });
  });
  it('fails closed on an unknown payload state version', () => {
    expect(() => renderAutomationIoPayload({ runtimeStateVersion: 99, variables: {} })).toThrow('AUTOMATION_STATE_VERSION_UNSUPPORTED');
  });
});
