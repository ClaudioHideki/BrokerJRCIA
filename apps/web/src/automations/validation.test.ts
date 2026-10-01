import { describe, expect, it, vi } from 'vitest';
import { validateAutomation } from './api.js';
import type { ApiClient } from '../api/client.js';

describe('automation validation response adapter',()=>{
  it('preserves diagnostics and does not guess a node from a legacy label',async()=>{
    const request=vi.fn().mockResolvedValueOnce({valid:false,errors:['Nome duplicado: erro.']})
      .mockResolvedValueOnce({valid:false,diagnostics:[{nodeId:'second',field:'data.text',code:'INVALID_CONFIG',message:'Nome duplicado: erro.'}]});
    const client={request} as unknown as ApiClient;
    expect((await validateAutomation(client,'id')).diagnostics).toEqual([{nodeId:null,field:'',code:'LEGACY_VALIDATION',message:'Nome duplicado: erro.'}]);
    expect((await validateAutomation(client,'id')).diagnostics[0]?.nodeId).toBe('second');
  });
  it('rejects malformed structured diagnostics rather than silently claiming validity',async()=>{
    const client={request:vi.fn().mockResolvedValue({valid:false,diagnostics:[{message:'broken'}],errors:[]})} as unknown as ApiClient;
    await expect(validateAutomation(client,'id')).rejects.toMatchObject({status:502});
  });
});
