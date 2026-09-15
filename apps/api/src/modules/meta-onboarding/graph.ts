import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export function sealToken(token: string, key: Buffer, context: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([iv, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function openToken(value: string, key: Buffer, context: string): string {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12));
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12,-16)), cipher.final()]).toString('utf8');
}
export interface MetaSignupConfig { appId: string; appSecret: string; graphVersion: string }
export class MetaSignupGraphClient {
  #config: MetaSignupConfig; #fetch: typeof fetch;
  constructor(config: MetaSignupConfig, fetcher: typeof fetch = fetch) {
    if (!/^v\d+\.\d+$/.test(config.graphVersion) || !/^\d+$/.test(config.appId)) throw new Error('META_CONFIG_INVALID');
    this.#config = config; this.#fetch = fetcher;
  }
  async #request(path: string, token?: string, method = 'GET', body?: URLSearchParams): Promise<unknown> {
    try {
      const response = await this.#fetch(`https://graph.facebook.com/${this.#config.graphVersion}/${path}`, {
        method, redirect:'error', signal:AbortSignal.timeout(15_000),
        headers: token ? {Authorization:`Bearer ${token}`} : {}, ...(body ? {body} : {}),
      });
      if(Number(response.headers.get('content-length'))>1_048_576 || !response.body) throw new Error();
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      try {
        while(true) {const next=await reader.read();if(next.done) break;bytes+=next.value.byteLength;
          if(bytes>1_048_576) {await reader.cancel();throw new Error();}chunks.push(next.value);}
      } finally {reader.releaseLock();}
      const json:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const error=z.object({error:z.object({code:z.number()})}).safeParse(json);
        if(error.success && error.data.error.code===190) throw new Error('META_TOKEN_REVOKED');
        throw new Error();
      }
      return json;
    } catch(error) {
      if(error instanceof Error && error.message==='META_TOKEN_REVOKED') throw error;
      throw Object.assign(new Error('META_GRAPH_UNAVAILABLE'), {status:503});
    }
  }
  async authorize(code: string, wabaId: string, phoneNumberId: string) {
    if (!/^\d{5,64}$/.test(wabaId) || !/^\d{5,64}$/.test(phoneNumberId)) throw new Error('META_ASSET_NOT_AUTHORIZED');
    const token = z.object({access_token:z.string().min(1).max(4096)}).parse(await this.#request('oauth/access_token', undefined, 'POST',
      new URLSearchParams({client_id:this.#config.appId,client_secret:this.#config.appSecret,code}))).access_token;
    const result = z.object({data:z.object({is_valid:z.boolean(),app_id:z.string(),scopes:z.array(z.string()),
      granular_scopes:z.array(z.object({scope:z.string(),target_ids:z.array(z.string()).optional()})).default([]),expires_at:z.number().optional()})})
      .parse(await this.#request(`debug_token?input_token=${encodeURIComponent(token)}`,`${this.#config.appId}|${this.#config.appSecret}`)).data;
    if (!result.is_valid || result.app_id !== this.#config.appId || (result.expires_at && result.expires_at*1000 <= Date.now()) ||
      !['whatsapp_business_management','whatsapp_business_messaging'].every(scope => result.scopes.includes(scope))) throw new Error('META_AUTHORIZATION_INVALID');
    if (!result.granular_scopes.some(scope => scope.scope === 'whatsapp_business_management' && scope.target_ids?.includes(wabaId))) throw new Error('META_ASSET_NOT_AUTHORIZED');
    const phones = z.object({data:z.array(z.object({id:z.string()}))}).parse(await this.#request(`${wabaId}/phone_numbers?fields=id&limit=100`,token));
    if (!phones.data.some(phone => phone.id === phoneNumberId)) throw new Error('META_ASSET_NOT_AUTHORIZED');
    return {accessToken:token, expiresAt:result.expires_at ? new Date(result.expires_at*1000) : null};
  }
  async subscribe(wabaId: string, token: string) {
    z.object({success:z.literal(true)}).parse(await this.#request(`${wabaId}/subscribed_apps`,token,'POST'));
  }
  async register(phoneId:string,token:string,pin:string) {
    if(!/^\d{6}$/.test(pin)) throw new Error('META_PIN_INVALID');
    z.object({success:z.literal(true)}).parse(await this.#request(`${phoneId}/register`,token,'POST',new URLSearchParams({messaging_product:'whatsapp',pin})));
  }
  async checkReadiness(wabaId:string,phoneId:string,token:string):Promise<string[]> {
    const phone=z.object({status:z.string().optional()}).parse(await this.#request(`${phoneId}?fields=status`,token));
    const waba=z.object({account_review_status:z.string().optional(),primary_funding_id:z.string().optional(),
      health_status:z.object({can_send_message:z.string().optional()}).optional()}).parse(await this.#request(`${wabaId}?fields=account_review_status,primary_funding_id,health_status`,token));
    const pending:string[]=[];
    if(phone.status!=='CONNECTED') pending.push('PHONE_REGISTRATION_REQUIRED');
    if(waba.account_review_status!=='APPROVED') pending.push('META_BUSINESS_REVIEW_REQUIRED');
    if(!waba.primary_funding_id) pending.push('META_PAYMENT_METHOD_REQUIRED');
    if(waba.health_status?.can_send_message!=='AVAILABLE') pending.push('META_ACCOUNT_HEALTH_REVIEW_REQUIRED');
    try {await this.subscribe(wabaId,token);} catch {pending.push('WEBHOOK_SUBSCRIPTION_REQUIRED');}
    return pending;
  }
}
