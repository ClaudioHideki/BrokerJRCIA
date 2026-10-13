import { AutomationHttpError, type AutomationHttpRequest, type AutomationHttpResponse } from '../automation-integrations/safe-http.js';
import type { CredentialType } from '../automation-integrations/credentials.js';
import type { OutboxRow } from './repository.js';
import type { ExternalEffectDispatcher } from './service.js';
import { renderAutomationIoPayload } from './io-payload.js';
import {HttpQueryNodeConfigSchema} from '@jrc/contracts';
import {assertHttpCredentialPolicy} from './http-query-policy.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
export interface AutomationHttpEffectOptions {
  request(input: AutomationHttpRequest): Promise<AutomationHttpResponse>;
  resolveCredential(org: string, id: string): Promise<{ type: CredentialType; secret: Record<string, unknown>;metadata?:Record<string,unknown>;revision?:number }>;
  audit(item: OutboxRow, outcome: string, started: number, credentialId?: string, detail?: Record<string, unknown>): Promise<void>;
}
export function createAutomationHttpEffectDispatcher(options: AutomationHttpEffectOptions): ExternalEffectDispatcher {
  return { dispatch: async item => {
    const started = Date.now(); let credentialId: string | undefined, method = text(item.payload.method) || 'GET';
    let phase: 'prepare' | 'request' | 'audit' = 'prepare';
    try {
      const queryConfig=item.payload.httpConfigVersion===undefined?null:HttpQueryNodeConfigSchema.parse(Object.fromEntries(Object.entries(item.payload).filter(([key])=>!['variables','runtimeStateVersion','nodeType'].includes(key))));
      const payload = renderAutomationIoPayload(item.payload);
      method = text(payload.method) || 'GET';
      credentialId = text(payload.credentialId) || undefined;
      const resolved = credentialId ? await options.resolveCredential(item.organizationId, credentialId) : null;
      let queryPolicy:string[]|undefined,url=text(payload.url);
      if(queryConfig){
        queryPolicy=assertHttpCredentialPolicy(item.organizationId,queryConfig,resolved?{id:queryConfig.credentialId,organizationId:item.organizationId,type:resolved.type,status:'ACTIVE',revision:resolved.revision??0,allowedOrigins:resolved.metadata?.allowedOrigins}:null);
        const rendered=HttpQueryNodeConfigSchema.parse(Object.fromEntries(Object.entries(payload).filter(([key])=>!['variables','runtimeStateVersion','nodeType'].includes(key))));
        const destination=new URL(queryConfig.url);for(const [name,value]of Object.entries(rendered.queryParameters))destination.searchParams.set(name,value);url=destination.href;
      }
      const headers = { ...object(payload.headers) } as Record<string, string>;
      if (resolved) {
        const secret = resolved.secret;
        if(queryConfig){
          const required=resolved.type==='BEARER'?['token']:resolved.type==='BASIC'?['username','password']:['name','value'];
          if(required.some(key=>!text(secret[key]).trim()))throw new Error('AUTOMATION_HTTP_CREDENTIAL_INVALID');
        }
        if (resolved.type === 'BEARER') headers.authorization = `Bearer ${text(secret.token)}`;
        else if (resolved.type === 'BASIC') headers.authorization = `Basic ${Buffer.from(`${text(secret.username)}:${text(secret.password)}`).toString('base64')}`;
        else if (resolved.type === 'HTTP_HEADER') headers[text(secret.name)] = text(secret.value);
        else Object.assign(headers, object(secret.headers));
      }
      phase = 'request';
      const response = await options.request({ method: method as AutomationHttpRequest['method'],
        url, headers, ...(payload.body === undefined ? {} : { body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body) }),
        timeoutMs: Number(payload.timeoutMs ?? 15000), retryAttempts: Number(payload.retryAttempts ?? 0),
        ...(queryConfig?{allowedOrigins:queryPolicy!,redirectLimit:0,maxResponseBytes:queryConfig.maxResponseBytes}:{}) });
      phase = 'audit';
      await options.audit(item, response.outcome, started, credentialId, { status: 'completed' });
      return { kind: 'SENT', remoteReference: `io:${item.id}`, resumePayload: { outcome: response.outcome,
        output: { status: response.status, headers: response.headers, body: response.body } } };
    } catch (error) {
      const code = error instanceof AutomationHttpError ? error.code : phase === 'prepare' ? 'AUTOMATION_HTTP_PREPARATION_FAILED' : phase === 'audit' ? 'AUTOMATION_HTTP_AUDIT_FAILED' : 'AUTOMATION_HTTP_TRANSPORT_FAILED';
      const uncertain = phase === 'audit' || (phase === 'request' && method !== 'GET' && (!(error instanceof AutomationHttpError) || error.dispatched));
      const outcome = uncertain ? 'unknown' : code === 'AUTOMATION_HTTP_TIMEOUT' ? 'timeout' : 'unknown';
      // Audit errors must also preserve the claimed UNKNOWN barrier, never trigger a blind replay.
      if (phase !== 'audit') try { await options.audit(item, outcome, started, credentialId, { error: code }); }
      catch { return { kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_AUDIT_FAILED' }; }
      if (uncertain) return { kind: 'UNKNOWN', error: code };
      return { kind: 'FAILED', error: code, resumePayload: { outcome, output: { error: code } } };
    }
  } };
}
