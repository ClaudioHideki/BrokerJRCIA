import { describe, it, expect, vi } from 'vitest';
import { MetaSignupGraphClient, sealToken, openToken } from '../../src/modules/meta-onboarding/graph.js';

describe('Meta authorization boundary', () => {
  it('allows READY only with all authoritative prerequisites and rejects OAuth revocation', async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'CONNECTED'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({account_review_status:'APPROVED',primary_funding_id:'123456',health_status:{can_send_message:'AVAILABLE'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({success:true})))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{code:190,message:'secret'}}),{status:400}));
    const client=new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    expect(await client.checkReadiness('12345','67890','private')).toEqual([]);
    await expect(client.checkReadiness('12345','67890','private')).rejects.toThrow('META_TOKEN_REVOKED');
  });
  it('bounds Graph responses even when Content-Length is absent', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response('x'.repeat(1_048_577)));
    const client=new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    await expect(client.authorize('code','12345','67890')).rejects.toThrow('META_GRAPH_UNAVAILABLE');
  });
  it('keeps missing payment evidence pending even with approved phone and review', async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'CONNECTED'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({account_review_status:'APPROVED',health_status:{can_send_message:'AVAILABLE'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({success:true})));
    const client=new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    expect(await client.checkReadiness('12345','67890','private')).toEqual(['META_PAYMENT_METHOD_REQUIRED']);
  });
  it('binds encrypted token to tenant and connection', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealToken('secret-token', key, 'org:a');
    expect(sealed).not.toContain('secret-token');
    expect(openToken(sealed, key, 'org:a')).toBe('secret-token');
    expect(() => openToken(sealed, key, 'org:b')).toThrow();
  });
  it('rejects tokens issued for another application before trusting browser assets', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'private'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{is_valid:true,app_id:'999',scopes:['whatsapp_business_management','whatsapp_business_messaging']}})));
    const client = new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'}, fetcher);
    await expect(client.authorize('code','12345','67890')).rejects.toThrow('META_AUTHORIZATION_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects phone outside server-verified WABA', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'private'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{is_valid:true,app_id:'123',scopes:['whatsapp_business_management','whatsapp_business_messaging'],granular_scopes:[{scope:'whatsapp_business_management',target_ids:['12345']}]}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'99999'}]})));
    const client = new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'}, fetcher);
    await expect(client.authorize('code','12345','67890')).rejects.toThrow('META_ASSET_NOT_AUTHORIZED');
  });
});
