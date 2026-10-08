import { isAutomationHttpErrorCode } from '../automation-integrations/safe-http.js';

// Diagnostics are codes, never a transport exception, URL or credential.
export function unknownOutboxDiagnostic(value:unknown):string {
  return isAutomationHttpErrorCode(value) || value === 'AUTOMATION_HTTP_PREPARATION_FAILED' || value === 'AUTOMATION_HTTP_AUDIT_FAILED'
    ? value : 'AUTOMATION_EFFECT_UNKNOWN';
}
