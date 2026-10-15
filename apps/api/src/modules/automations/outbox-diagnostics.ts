import { isAutomationHttpErrorCode } from '../automation-integrations/safe-http.js';

// Diagnostics are codes, never a transport exception, URL or credential.
export function unknownOutboxDiagnostic(value:unknown):string {
  if(typeof value==='string'&&['AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN','AUTOMATION_EFFECT_INTENT_EXISTS',
    'AUTOMATION_MEDIA_TRANSPORT_PENDING','CHATWOOT_OUTCOME_UNKNOWN','CHATWOOT_INVALID_RESPONSE'].includes(value))return value;
  return isAutomationHttpErrorCode(value) || value === 'AUTOMATION_HTTP_PREPARATION_FAILED' || value === 'AUTOMATION_HTTP_AUDIT_FAILED'
    ? value : 'AUTOMATION_EFFECT_UNKNOWN';
}
