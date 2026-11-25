import { describe, it, expect, vi } from 'vitest';
import { MetaSignupGraphClient, sealToken, openToken } from '../../src/modules/meta-onboarding/graph.js';

describe('Meta authorization boundary', () => {
  it('allows READY only with all authoritative prerequisites and rejects OAuth revocation', async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'CONNECTED'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({account_review_status:'APPROVED',health_status:{can_send_message:'AVAILABLE'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({primary_funding_id:'123456'})))
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
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({success:true})));
    const client=new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    expect(await client.checkReadiness('12345','67890','private')).toEqual(['META_PAYMENT_METHOD_REQUIRED']);
  });
  it.each([
    { health: 'AVAILABLE', subscription: 200, pending: [] },
    { health: 'BLOCKED', subscription: 200, pending: ['META_ACCOUNT_HEALTH_REVIEW_REQUIRED'] },
    { health: 'AVAILABLE', subscription: 500, pending: ['WEBHOOK_SUBSCRIPTION_REQUIRED'] },
  ])('checks health and subscription when billing access is restricted ($health, $subscription)', async ({ health, subscription, pending }) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({status:'CONNECTED'}))
      .mockResolvedValueOnce(Response.json({account_review_status:'APPROVED',health_status:{can_send_message:health}}))
      .mockResolvedValueOnce(Response.json({error:{code:10}}, {status:400}))
      .mockResolvedValueOnce(Response.json({success:true}, {status:subscription}));
    const client = new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    expect(await client.checkReadiness('12345','67890','private')).toEqual(pending);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://graph.facebook.com/v25.0/67890?fields=status',
      'https://graph.facebook.com/v25.0/12345?fields=account_review_status,health_status',
      'https://graph.facebook.com/v25.0/12345?fields=primary_funding_id',
      'https://graph.facebook.com/v25.0/12345/subscribed_apps',
    ]);
  });
  it.each([
    { status: 400, code: 190, expected: 'META_TOKEN_REVOKED' },
    { status: 500, code: 10, expected: 'META_GRAPH_UNAVAILABLE' },
  ])('propagates billing read failures outside the permission exception ($status, $code)', async ({ status, code, expected }) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({status:'CONNECTED'}))
      .mockResolvedValueOnce(Response.json({account_review_status:'APPROVED',health_status:{can_send_message:'AVAILABLE'}}))
      .mockResolvedValueOnce(Response.json({error:{code}}, {status}));
    const client = new MetaSignupGraphClient({appId:'123',appSecret:'secret',graphVersion:'v25.0'},fetcher);
    await expect(client.checkReadiness('12345','67890','private')).rejects.toThrow(expected);
    expect(fetcher).toHaveBeenCalledTimes(3);
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
